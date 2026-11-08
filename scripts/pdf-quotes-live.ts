// End-to-end check of the real-PDF path from Node: the library and its attachments from a
// running Zotero, page text through the plugin's own `extractPdfPages` (pdf.js from the
// pdfjs-dist devDependency, in place of Obsidian's `loadPdfJs()`), the page budget, the
// quote-search prompt against a running Ollama, and every quote checked verbatim against
// the extracted pages, with its cited page. Finishes with one "Ask this paper" question.
//   npm run quotes:pdf-live                      (3 papers, 3 quote calls + 1 ask call)
//   DRY=1 npm run quotes:pdf-live                (extraction and budget only, no model)
//   N=2 QUESTION="..." ASK="..." MODEL=qwen3.5:9b NUM_CTX=32768 ZOTERO_DIR=C:/Users/me/Zotero
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import type { PaperItem } from "../src/core/catalog";
import { OllamaClient, OllamaError } from "../src/core/ollama";
import { extractPdfPages, type PdfDocumentLike, type PdfJsLike } from "../src/core/pdf";
import { MAX_QUOTES_PER_PAPER, parseQuotes, quotesMessages, type Quote } from "../src/core/quotes";
import { askMessages, budgetPages, type PageBudget } from "../src/core/reading";
import { ZoteroClient, attachPdfs } from "../src/core/zotero";
import { nodeRequest } from "../src/node-http";

const MAX_MODEL_CALLS = 5;
const RETRY_WAIT_MS = 60_000;

interface RawPdfJs {
	getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocumentLike>; destroy(): Promise<void> };
}

/** pdfjs-dist's legacy build adapted to the `PdfJsLike` the core expects. Node has no Worker, so
 *  pdf.js runs its worker code in-process (the "fake worker"); nothing to configure. */
function loadPdfJs(): PdfJsLike {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const raw = require("pdfjs-dist/legacy/build/pdf.mjs") as RawPdfJs;
	return {
		getDocument: ({ data }) => {
			const task = raw.getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
			return {
				promise: task.promise.then((doc) => ({
					numPages: doc.numPages,
					getPage: (n: number) => doc.getPage(n),
					destroy: () => task.destroy(),
				})),
			};
		},
	};
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Hyphens and typographic quotes/dashes are differences a reader would not count; dropping hyphens
 *  on both sides keeps the comparison symmetric however a line-broken word was put back together. */
const loose = (s: string) =>
	norm(s)
		.replace(/[“”«»]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/[‐‑‒–—−-]\s?/g, "")
		.toLowerCase();

interface Verified {
	verbatim: boolean;
	/** Found after hyphenation/typography normalisation only. */
	near: boolean;
	/** Pages (1-based) on which the text appears. */
	pages: number[];
	pageOk: boolean;
	/** The text occurs only when pages are joined, i.e. it runs across a page break. */
	spansPages: boolean;
}

function verify(text: string, page: number | null, pages: string[]): Verified {
	const strict = norm(text);
	const lax = loose(text);
	const exact = pages.map((p, i) => (norm(p).includes(strict) ? i + 1 : 0)).filter(Boolean);
	const found = exact.length ? exact : pages.map((p, i) => (loose(p).includes(lax) ? i + 1 : 0)).filter(Boolean);
	const spansPages = found.length === 0 && loose(pages.join(" ")).includes(lax);
	return {
		verbatim: exact.length > 0,
		near: exact.length === 0 && found.length > 0,
		pages: found,
		pageOk: page !== null && found.some((p) => Math.abs(p - page) <= 1),
		spansPages,
	};
}

interface Paper {
	item: PaperItem;
	pages: string[];
	numPages: number;
	chars: number;
	budget: PageBudget;
}

let modelCalls = 0;
let modelStopped = false;

async function chat(ollama: OllamaClient, model: string, messages: ReturnType<typeof quotesMessages>, numCtx: number): Promise<string | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (modelStopped || modelCalls >= MAX_MODEL_CALLS) {
			console.log(`  (model call skipped: ${modelStopped ? "stopped after a failed retry" : `${MAX_MODEL_CALLS} calls already made`})`);
			return null;
		}
		modelCalls++;
		try {
			return await ollama.chat({ model, messages, think: false, options: { num_ctx: numCtx, temperature: 0.1 } });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const connection = err instanceof OllamaError ? err.status === undefined || err.status >= 500 : /ECONNREFUSED|ECONNRESET|fetch failed|socket|Cannot reach/i.test(msg);
			if (!connection || attempt === 1) {
				console.log(`  model call FAILED: ${msg}`);
				modelStopped = true;
				return null;
			}
			console.log(`  model call failed (${msg}); waiting ${RETRY_WAIT_MS / 1000} s and retrying once`);
			await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
		}
	}
	return null;
}

function expandHome(p: string): string {
	return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

async function main() {
	const n = Number(process.env.N ?? 3);
	const model = process.env.MODEL ?? "qwen3.5:9b";
	const numCtx = Number(process.env.NUM_CTX ?? 32768);
	const dry = process.env.DRY === "1";
	const question = process.env.QUESTION ?? "What problem does this work set out to solve, and what is its main contribution?";
	const ask = process.env.ASK ?? "What method does the paper use, and how was it evaluated? Quote the sentence that states the method.";
	const dataDir = expandHome(process.env.ZOTERO_DIR ?? `${homedir()}/Zotero`);

	const zotero = new ZoteroClient(() => process.env.ZOTERO_URL ?? "http://127.0.0.1:23119", nodeRequest);
	const ollama = new OllamaClient(() => process.env.OLLAMA_URL ?? "http://localhost:11434");

	let t0 = Date.now();
	const [items, attachments] = await Promise.all([zotero.topItems(), zotero.attachments()]);
	attachPdfs(items, attachments, dataDir);
	const withPdf = items.filter((i) => i.pdfPath);
	const onDisk = withPdf.filter((i) => existsSync(expandHome(i.pdfPath!)));
	console.log(`Zotero: ${items.length} papers, ${attachments.length} attachments, ${withPdf.length} with a PDF path, ${onDisk.length} PDFs on disk (${Date.now() - t0} ms)`);
	const chosen = onDisk.slice(0, n);
	if (chosen.length === 0) throw new Error("No paper has a PDF on disk");

	const pdfjs = loadPdfJs();
	const papers: Paper[] = [];
	for (const item of chosen) {
		t0 = Date.now();
		const bytes = new Uint8Array(await readFile(expandHome(item.pdfPath!)));
		const extracted = await extractPdfPages(bytes, pdfjs);
		const chars = extracted.pages.reduce((s, p) => s + p.length, 0);
		const empty = extracted.pages.filter((p) => p.length === 0).length;
		const budget = budgetPages(extracted.pages, numCtx);
		papers.push({ item, pages: extracted.pages, numPages: extracted.numPages, chars, budget });
		console.log(`\n## ${item.title.slice(0, 90)}`);
		console.log(`   ${item.pdfPath}`);
		console.log(`   extracted ${extracted.pages.length}/${extracted.numPages} pages, ${chars} chars, ${empty} empty page(s), in ${Date.now() - t0} ms`);
		console.log(`   budget (num_ctx ${numCtx}): ${budget.pagesIncluded.length} pages included${budget.truncated ? ` (truncated: ${budget.pagesIncluded.join(",")})` : ""}, prompt ${budget.text.length} chars`);
		const markers = Array.from(budget.text.matchAll(/^=== Page (\d+) ===$/gm)).map((m) => Number(m[1]));
		if (markers.join(",") !== budget.pagesIncluded.join(",")) console.log(`   DEFECT: markers ${markers.join(",")} differ from pagesIncluded ${budget.pagesIncluded.join(",")}`);
		console.log(`   page 1 starts: ${JSON.stringify(extracted.pages[0]?.slice(0, 160) ?? "")}`);
		const sample = extracted.pages[Math.min(1, extracted.pages.length - 1)] ?? "";
		console.log(`   page ${Math.min(2, extracted.pages.length)} starts: ${JSON.stringify(sample.slice(0, 160))}`);
	}
	if (dry) {
		console.log("\nDRY=1: no model calls made.");
		return;
	}

	console.log(`\n# Quote search with ${model}: ${question}`);
	const summary: string[] = [];
	for (const paper of papers) {
		t0 = Date.now();
		const reply = await chat(ollama, model, quotesMessages(paper.item, paper.budget, question), numCtx);
		if (reply === null) break;
		const seconds = ((Date.now() - t0) / 1000).toFixed(1);
		const quotes = parseQuotes(reply);
		const listLines = reply.split(/\n+/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s*\S/.test(l)).length;
		const results = quotes.map((q) => ({ q, v: verify(q.text, q.page, paper.pages) }));
		const verbatim = results.filter((r) => r.v.verbatim).length;
		const near = results.filter((r) => r.v.near).length;
		const pageOk = results.filter((r) => r.v.pageOk).length;
		const line = `${paper.item.title.slice(0, 60)} | pages ${paper.pages.length} | chars ${paper.chars} | budget ${paper.budget.pagesIncluded.length} pages | quotes ${quotes.length}/${MAX_QUOTES_PER_PAPER} | verbatim ${verbatim} (+${near} near) | page ok ${pageOk} | dropped by parser ${Math.max(0, listLines - quotes.length)} | ${seconds} s`;
		summary.push(line);
		console.log(`\n## ${line}`);
		console.log(`   raw reply: ${JSON.stringify(reply.slice(0, 300))}${reply.length > 300 ? "…" : ""}`);
		for (const { q, v } of results) {
			const status = v.verbatim ? "VERBATIM" : v.near ? "NEAR    " : v.spansPages ? "SPANS   " : "MISSING ";
			const where = v.pages.length ? `on p. ${v.pages.join(",")}` : "not on any page";
			console.log(`   ${status} cited p. ${q.page ?? "?"} ${v.pageOk ? "ok " : "BAD"} (${where}): ${q.text.slice(0, 120)}${q.text.length > 120 ? "…" : ""}`);
			if (!v.verbatim && !v.near) console.log(`            closest: ${closest(q.text, paper.pages)}`);
		}
	}

	if (!modelStopped && modelCalls < MAX_MODEL_CALLS) {
		const paper = papers[0];
		console.log(`\n# Ask this paper (${paper.item.title.slice(0, 60)}): ${ask}`);
		t0 = Date.now();
		const answer = await chat(ollama, model, askMessages(paper.item, paper.budget, ask), numCtx);
		if (answer !== null) {
			console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)} s, ${answer.length} chars\n`);
			console.log(answer.split("\n").map((l) => `   | ${l}`).join("\n"));
			const cited = Array.from(answer.matchAll(/\[\s*p\.\s*(\d+(?:\s*[,–-]\s*\d+)*)\s*\]/g)).flatMap((m) => m[1].split(/\s*[,–-]\s*/).map(Number));
			const valid = cited.filter((p) => paper.budget.pagesIncluded.includes(p));
			console.log(`\n   citations: ${cited.length} (${valid.length} point at a page that was provided)`);
			const quoted: Quote[] = Array.from(answer.matchAll(/["“]([^"“”]{15,})["”]/g)).map((m) => {
				const after = answer.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
				const cite = /\[\s*p\.\s*(\d+)/.exec(after);
				return { text: m[1], page: cite ? Number(cite[1]) : null };
			});
			for (const q of quoted) {
				const v = verify(q.text, q.page, paper.pages);
				const status = v.verbatim ? "VERBATIM" : v.near ? "NEAR    " : v.spansPages ? "SPANS   " : "MISSING ";
				console.log(`   ${status} cited p. ${q.page ?? "?"} ${v.pageOk ? "ok " : "BAD"} (${v.pages.length ? `on p. ${v.pages.join(",")}` : "not on any page"}): ${q.text.slice(0, 120)}`);
			}
			if (quoted.length === 0) console.log("   (no quoted passage in the answer)");
		}
	}

	console.log(`\n# Summary (${modelCalls} model call(s))`);
	for (const s of summary) console.log(`- ${s}`);
}

/** The longest leading part of the quote that does appear somewhere, to see where a miss diverges. */
function closest(text: string, pages: string[]): string {
	const all = loose(pages.join(" "));
	const q = loose(text);
	let lo = 0;
	let hi = q.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (all.includes(q.slice(0, mid))) lo = mid;
		else hi = mid - 1;
	}
	const idx = lo >= 15 ? all.indexOf(q.slice(0, lo)) : -1;
	return idx < 0 ? "(no 15-char prefix found)" : `matches ${lo}/${q.length} chars; page has "…${all.slice(idx + Math.max(0, lo - 30), idx + lo + 40)}…"`;
}

main().catch((err) => {
	console.error("FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
	process.exit(1);
});

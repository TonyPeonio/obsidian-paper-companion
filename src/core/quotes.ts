// Quote search across the library: one question, the top papers by meaning, and for each
// paper the passages in its PDF that bear on the question, copied verbatim with page numbers.

import { authorLabel, type PaperItem } from "./catalog";
import { safeFileName } from "./notes";
import type { ChatMessage } from "./ollama";
import { paperHeader, type PageBudget } from "./reading";

export interface Quote {
	text: string;
	page: number | null;
}

export interface QuoteHit {
	item: PaperItem;
	/** Wikilink target of the paper's literature note (path without .md). */
	noteLink: string;
	quotes: Quote[];
	pagesSeen: number;
	numPages: number;
	/** Set when the PDF could not be read or the model failed; `quotes` is then empty. */
	error?: string;
}

export const MAX_QUOTES_PER_PAPER = 5;
export const NONE_MARKER = "NONE";

export function quotesMessages(item: PaperItem, pages: PageBudget, question: string): ChatMessage[] {
	const system = `You find the passages in one research paper that answer or bear on a question. The paper's pages follow, each starting with a marker like "=== Page 7 ===".
Reply with a markdown list only, no introduction: each item is ONE passage of one to three sentences copied word for word from a page, in double quotes, followed by its page citation [p. N] taken from the marker above it. Most relevant first, at most ${MAX_QUOTES_PER_PAPER} items. Never paraphrase, summarise or merge sentences from different places; a quote must appear verbatim on the page you cite.
If no passage bears on the question, reply with exactly ${NONE_MARKER}.${pages.truncated ? " Only some pages were provided." : ""}`;
	const user = `${paperHeader(item)}\n\n${pages.text}\n\nQuestion: ${question.trim()}`;
	return [
		{ role: "system", content: system },
		{ role: "user", content: user },
	];
}

const PAGE_RE = /\[\s*p(?:p|age|\.)?\.?\s*(\d{1,4})(?:\s*[-–,]\s*\d{1,4})?\s*\]|\(\s*p(?:p|age|\.)?\.?\s*(\d{1,4})\s*\)/i;
const QUOTE_RE = /["“”«»]([^"“”«»]{15,})["“”«»]/;

/** Reads the model's list back into quotes; tolerant of numbering, straight or curly quotes and missing pages. */
export function parseQuotes(text: string): Quote[] {
	const trimmed = text.trim();
	if (!trimmed || new RegExp(`^\\W*${NONE_MARKER}\\b`, "i").test(trimmed)) return [];
	const out: Quote[] = [];
	for (const raw of trimmed.split(/\n+/)) {
		const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
		if (!line) continue;
		const pageMatch = PAGE_RE.exec(line);
		const page = pageMatch ? Number(pageMatch[1] ?? pageMatch[2]) : null;
		const quoted = QUOTE_RE.exec(line);
		let body = quoted ? quoted[1] : line.replace(PAGE_RE, "");
		body = body.replace(/\s+/g, " ").replace(/^[\s"“”«»:\-–]+|[\s"“”«»:\-–]+$/g, "").trim();
		if (body.length < 15) continue;
		if (out.some((q) => q.text === body)) continue;
		out.push({ text: body, page });
		if (out.length >= MAX_QUOTES_PER_PAPER) break;
	}
	return out;
}

export function quoteSearchFileName(question: string): string {
	const base = safeFileName(question.trim().replace(/\?+$/, "")).replace(/\s+/g, " ").trim();
	return (base.length > 80 ? base.slice(0, 80).trim() : base) || "Quote search";
}

export interface QuoteSearchMeta {
	model: string;
	date: string;
	/** How many papers were ranked before the top ones were read. */
	libraryLabel: string;
}

export function renderQuoteSearch(question: string, hits: QuoteHit[], meta: QuoteSearchMeta): string {
	const lines: string[] = [];
	lines.push("---", `type: quote-search`, `question: ${yamlString(question)}`, `date: ${meta.date}`, `model: ${yamlString(meta.model)}`, "---", "");
	lines.push(`# ${question.trim()}`, "");
	const found = hits.filter((h) => h.quotes.length > 0);
	lines.push(
		`_${found.length} of the ${hits.length} papers read had a relevant passage (${meta.libraryLabel}, ranked by meaning; read with ${meta.model} on ${meta.date}). Quotes are copied from the PDFs by a model: check the page before you cite one._`,
		"",
	);
	for (const hit of [...found, ...hits.filter((h) => h.quotes.length === 0)]) {
		lines.push(`## [[${hit.noteLink}]]`, "");
		lines.push(`${authorLabel(hit.item)}${hit.item.year ? ` (${hit.item.year})` : ""}. ${hit.item.title}`, "");
		if (hit.error) {
			lines.push(`_Could not read this paper: ${hit.error}_`, "");
			continue;
		}
		if (hit.quotes.length === 0) {
			lines.push(`_No relevant passage in the ${hit.pagesSeen} of ${hit.numPages} pages read._`, "");
			continue;
		}
		for (const q of hit.quotes) {
			lines.push(`> "${q.text}"`, `> — [[${hit.noteLink}]]${q.page ? `, p. ${q.page}` : ""}`, "");
		}
		if (hit.pagesSeen < hit.numPages) lines.push(`_${hit.pagesSeen} of ${hit.numPages} pages were read; long papers are sampled to fit the context window._`, "");
	}
	return lines.join("\n").trimEnd() + "\n";
}

function yamlString(s: string): string {
	return JSON.stringify(s.trim());
}

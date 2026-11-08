import { Notice, Plugin, TFile, TFolder, loadPdfJs, normalizePath, requestUrl } from "obsidian";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { emptyCatalog, emptyIndex, embedText, itemsNeedingEmbedding, pruneIndex, rankByKeywords, rankBySimilarity, type Catalog, type PaperIndex, type PaperItem, type Ranked } from "./core/catalog";
import { parseExport } from "./core/exports";
import type { HttpRequest } from "./core/http";
import { appendQA, mergeLiteratureNote, noteBaseName, renderLiteratureNote, replaceSection, SECTION_READING, splitFrontmatter } from "./core/notes";
import { OllamaClient, OllamaError } from "./core/ollama";
import { extractPdfPages, type PdfJsLike } from "./core/pdf";
import { askMessages, budgetPages, hasPageCitations, readingNotesMessages } from "./core/reading";
import { parseQuotes, quoteSearchFileName, quotesMessages, renderQuoteSearch, type QuoteHit } from "./core/quotes";
import { attachPdfs, ZoteroClient, ZoteroError } from "./core/zotero";
import { FindPapersModal, QuestionModal } from "./modals";
import { nodeHttpAvailable, nodeRequest } from "./node-http";
import { DEFAULT_SETTINGS, type PaperCompanionSettings } from "./settings";
import { PaperCompanionSettingTab } from "./settings-tab";

interface SavedData {
	settings?: Partial<PaperCompanionSettings>;
	catalog?: Catalog;
	index?: PaperIndex;
}

const EMBED_BATCH = 16;

export default class PaperCompanionPlugin extends Plugin {
	settings: PaperCompanionSettings = { ...DEFAULT_SETTINGS };
	catalog: Catalog = emptyCatalog("zotero");
	index: PaperIndex = emptyIndex(DEFAULT_SETTINGS.embeddingModel);
	http!: HttpRequest;
	zotero!: ZoteroClient;
	ollama!: OllamaClient;
	private syncing = false;
	private queryVectors = new Map<string, number[]>();

	async onload(): Promise<void> {
		await this.loadAll();
		const viaRequestUrl: HttpRequest = async (opts) => {
			const res = await requestUrl({ url: opts.url, method: opts.method ?? "GET", headers: opts.headers, body: opts.body, contentType: opts.contentType, throw: false });
			return { status: res.status, headers: res.headers, text: res.text, arrayBuffer: res.arrayBuffer };
		};
		// Zotero closes the connection on any request with an Origin header, and requestUrl
		// sends one (app://obsidian.md). Node's http sends none; this plugin is desktop-only.
		this.http = nodeHttpAvailable() ? nodeRequest : viaRequestUrl;
		this.zotero = new ZoteroClient(() => this.settings.zoteroApiUrl, this.http);
		this.ollama = new OllamaClient(
			() => this.settings.ollamaUrl,
			undefined,
			async (url, body, method) => {
				const res = await requestUrl(method === "GET" ? { url, method, throw: false } : { url, method, contentType: "application/json", body, throw: false });
				return { status: res.status, text: res.text };
			},
		);
		this.addSettingTab(new PaperCompanionSettingTab(this.app, this));

		this.addRibbonIcon("book-open", "Find papers", () => this.findPapers());
		this.addCommand({ id: "sync-library", name: "Sync Zotero library", callback: () => void this.syncLibrary() });
		this.addCommand({ id: "find-papers", name: "Find papers", callback: () => this.findPapers() });
		this.addCommand({ id: "find-quotes", name: "Find quotes across papers", callback: () => void this.findQuotes() });
		this.addCommand({
			id: "related-papers",
			name: "Related papers to this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.relatedPapers(file);
				return true;
			},
		});
		this.addCommand({
			id: "write-reading-notes",
			name: "Write reading notes",
			checkCallback: (checking) => {
				const file = this.activeLiteratureNote();
				if (!file) return false;
				if (!checking) void this.writeReadingNotes(file);
				return true;
			},
		});
		this.addCommand({
			id: "ask-paper",
			name: "Ask this paper",
			checkCallback: (checking) => {
				const file = this.activeLiteratureNote();
				if (!file) return false;
				if (!checking) void this.askPaper(file);
				return true;
			},
		});
	}

	// ---------------------------------------------------------------- persistence

	private async loadAll(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as SavedData;
		this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
		// 0.1.0 defaulted to "localhost", which can resolve to ::1 while Zotero listens on IPv4.
		if (this.settings.zoteroApiUrl === "http://localhost:23119") this.settings.zoteroApiUrl = DEFAULT_SETTINGS.zoteroApiUrl;
		if (data.catalog?.version === 1) this.catalog = data.catalog;
		if (data.index?.version === 1) this.index = data.index;
	}

	async saveSettings(): Promise<void> {
		await this.saveAll();
	}

	private async saveAll(): Promise<void> {
		const data: SavedData = { settings: this.settings, catalog: this.catalog, index: this.index };
		await this.saveData(data);
	}

	// ---------------------------------------------------------------- sync

	async syncLibrary(): Promise<void> {
		if (this.syncing) {
			new Notice("A sync is already running.");
			return;
		}
		this.syncing = true;
		const notice = new Notice("Paper Companion: reading your Zotero library…", 0);
		try {
			let items: PaperItem[];
			let source: Catalog["source"];
			if (await this.zotero.available()) {
				const collections = await this.zotero.collections();
				items = await this.zotero.topItems(collections);
				notice.setMessage(`Paper Companion: ${items.length} papers, resolving PDFs…`);
				const attachments = await this.zotero.attachments();
				attachPdfs(items, attachments, expandHome(this.settings.zoteroDataDir), expandHome(this.settings.linkedAttachmentBaseDir));
				source = "zotero";
			} else if (this.settings.exportFilePath.trim()) {
				const text = await readFile(expandHome(this.settings.exportFilePath), "utf8");
				items = parseExport(text);
				source = "export";
			} else {
				notice.hide();
				new Notice(`No Zotero at ${this.zotero.baseUrl}. Start Zotero and enable "Allow other applications on this computer to communicate with Zotero" (Settings → Advanced), or set an export file in the plugin settings.`, 15000);
				return;
			}
			this.catalog = { version: 1, source, updated: new Date().toISOString(), items: Object.fromEntries(items.map((i) => [i.key, i])) };
			this.index = pruneIndex(this.catalog, this.index);
			await this.saveAll();
			const embedded = await this.embedMissing((done, total) => notice.setMessage(`Paper Companion: embedding ${done}/${total} papers…`));
			notice.hide();
			const withPdf = items.filter((i) => i.pdfPath).length;
			new Notice(`Synced ${items.length} papers from ${source === "zotero" ? "Zotero" : "the export file"} (${withPdf} with a PDF)${embedded.note}.`, 8000);
		} catch (err) {
			notice.hide();
			new Notice(`Paper Companion: ${(err as Error).message}`, 12000);
		} finally {
			this.syncing = false;
		}
	}

	/** Embeds catalog items that have no current vector. Returns a note for the summary. */
	private async embedMissing(onProgress: (done: number, total: number) => void): Promise<{ count: number; note: string }> {
		const model = this.settings.embeddingModel;
		const todo = itemsNeedingEmbedding(this.catalog, this.index, model);
		if (todo.length === 0) return { count: 0, note: "" };
		if (this.index.model !== model) this.index = emptyIndex(model);
		let done = 0;
		try {
			for (let i = 0; i < todo.length; i += EMBED_BATCH) {
				const batch = todo.slice(i, i + EMBED_BATCH);
				const vectors = await this.ollama.embed(model, batch.map(embedText));
				batch.forEach((item, k) => (this.index.vectors[item.key] = { version: item.version, vec: vectors[k] }));
				done += batch.length;
				onProgress(done, todo.length);
				if (done % (EMBED_BATCH * 5) === 0) await this.saveAll();
			}
			await this.saveAll();
			return { count: done, note: `, ${done} embedded for search by meaning` };
		} catch (err) {
			await this.saveAll();
			const hint = err instanceof OllamaError ? ` Search by meaning needs the embedding model: run \`ollama pull ${model}\` and sync again. Keyword search works meanwhile.` : "";
			new Notice(`Embedding stopped after ${done}/${todo.length}: ${(err as Error).message}.${hint}`, 15000);
			return { count: done, note: done ? `, ${done} embedded` : ", not embedded" };
		}
	}

	// ---------------------------------------------------------------- search

	/** Semantic ranking when the index has vectors and the model answers; keyword ranking otherwise. */
	async rank(query: string, limit: number): Promise<Ranked[]> {
		const q = query.trim();
		const items = Object.values(this.catalog.items);
		if (!q) {
			return items
				.sort((a, b) => (b.dateModified ?? "").localeCompare(a.dateModified ?? "") || a.title.localeCompare(b.title))
				.slice(0, limit)
				.map((item) => ({ item, score: 0, by: "keyword" as const }));
		}
		const hasVectors = Object.keys(this.index.vectors).length > 0;
		if (hasVectors && q.length >= 4) {
			try {
				let vec = this.queryVectors.get(q);
				if (!vec) {
					[vec] = await this.ollama.embed(this.settings.embeddingModel, [q]);
					this.queryVectors.set(q, vec);
					if (this.queryVectors.size > 200) this.queryVectors.delete(this.queryVectors.keys().next().value as string);
				}
				const semantic = rankBySimilarity(vec, this.catalog, this.index, limit);
				if (semantic.length) return semantic;
			} catch {
				// Ollama down: keyword search still works.
			}
		}
		return rankByKeywords(q, this.catalog, limit);
	}

	findPapers(): void {
		if (Object.keys(this.catalog.items).length === 0) {
			new Notice("The library is empty. Run \"Sync Zotero library\" first.", 8000);
			void this.syncLibrary();
			return;
		}
		new FindPapersModal(this.app, this, null, (r) => this.openLiteratureNote(r.item)).open();
	}

	async relatedPapers(file: TFile): Promise<void> {
		if (Object.keys(this.catalog.items).length === 0) {
			new Notice("The library is empty. Run \"Sync Zotero library\" first.", 8000);
			return;
		}
		const text = splitFrontmatter(await this.app.vault.cachedRead(file)).body.replace(/\s+/g, " ").trim().slice(0, 2000);
		if (!text) {
			new Notice("This note is empty.");
			return;
		}
		const ranked = (await this.rank(text, 30)).filter((r) => r.item.key !== this.zoteroKeyOf(file));
		new FindPapersModal(this.app, this, ranked, (r) => this.openLiteratureNote(r.item), `Papers related to "${file.basename}"`).open();
	}

	// ---------------------------------------------------------------- notes

	private zoteroKeyOf(file: TFile): string | undefined {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (typeof fm?.zotero_key === "string") return fm.zotero_key;
		// Notes written by the Zotero Integration plugin carry `citekey` (this plugin writes
		// `citation_key`); either one identifies the paper when Zotero provides citation keys.
		const citekey = typeof fm?.citekey === "string" ? fm.citekey : typeof fm?.citation_key === "string" ? fm.citation_key : undefined;
		if (!citekey) return undefined;
		return Object.values(this.catalog.items).find((item) => item.citationKey === citekey)?.key;
	}

	/** The open note when it is a literature note with a catalog entry. */
	private activeLiteratureNote(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return null;
		const key = this.zoteroKeyOf(file);
		return key && this.catalog.items[key] ? file : null;
	}

	/** The existing note for an item (by frontmatter key) or the path it would get. */
	private noteFor(item: PaperItem): { file: TFile | null; path: string } {
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.notesFolder));
		if (folder instanceof TFolder) {
			for (const child of folder.children) {
				if (child instanceof TFile && child.extension === "md" && this.zoteroKeyOf(child) === item.key) return { file: child, path: child.path };
			}
		}
		const path = normalizePath(`${this.settings.notesFolder}/${noteBaseName(item)}.md`);
		const existing = this.app.vault.getFileByPath(path);
		return { file: existing, path };
	}

	async openLiteratureNote(item: PaperItem): Promise<TFile | null> {
		const { file, path } = this.noteFor(item);
		let target = file;
		if (target) {
			const before = await this.app.vault.read(target);
			const after = mergeLiteratureNote(before, item);
			if (after !== before) await this.app.vault.modify(target, after);
		} else {
			const folder = normalizePath(this.settings.notesFolder);
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			target = await this.app.vault.create(path, renderLiteratureNote(item));
		}
		await this.app.workspace.getLeaf(false).openFile(target);
		return target;
	}

	// ---------------------------------------------------------------- reading

	/** The PDF's pages, or the reason it cannot be read (for a Notice or a results note). */
	private async readPdf(pdfPath: string | undefined, title: string): Promise<{ pages: string[]; numPages: number } | { error: string }> {
		if (!pdfPath) return { error: `No PDF is known for "${title}". Attach one in Zotero and sync again, or add a "pdf" field with the file path to its note's frontmatter.` };
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await readFile(expandHome(pdfPath)));
		} catch (err) {
			return { error: `Cannot read the PDF at ${expandHome(pdfPath)}: ${(err as Error).message}. Check the Zotero data directory setting.` };
		}
		const pdfjs = (await loadPdfJs()) as PdfJsLike;
		const extracted = await extractPdfPages(bytes, pdfjs);
		if (extracted.pages.every((p) => p.trim().length === 0)) return { error: "The PDF has no extractable text (a scan without OCR)." };
		return extracted;
	}

	private async pagesFor(file: TFile, item: PaperItem): Promise<{ pages: string[]; numPages: number } | null> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const pdfPath = typeof fm?.pdf === "string" && fm.pdf ? fm.pdf : item.pdfPath;
		const result = await this.readPdf(pdfPath, item.title);
		if ("error" in result) {
			new Notice(result.error, 12000);
			return null;
		}
		return result;
	}

	/** One question, the top papers by meaning, verbatim passages with pages from each PDF, in one note. */
	async findQuotes(): Promise<void> {
		const total = Object.keys(this.catalog.items).length;
		if (total === 0) {
			new Notice("The library is empty. Run \"Sync Zotero library\" first.", 8000);
			return;
		}
		const modal = new QuestionModal(this.app, `Ranks your ${total} papers by meaning, reads the top ${this.settings.quoteSearchPapers} PDFs and collects the passages that answer the question, with page numbers.`, "Find quotes across papers", "How is attention defined, in their own words?");
		modal.open();
		const question = await modal.result;
		if (!question) return;
		const ranked = (await this.rank(question, Math.max(this.settings.quoteSearchPapers * 3, 10))).filter((r) => r.item.pdfPath).slice(0, this.settings.quoteSearchPapers);
		if (ranked.length === 0) {
			new Notice("No ranked paper has a PDF the plugin can read. Attach PDFs in Zotero and sync again.", 10000);
			return;
		}
		const notice = new Notice("", 0);
		const hits: QuoteHit[] = [];
		const think = this.settings.thinking === "auto" ? undefined : this.settings.thinking === "on";
		for (const [i, { item }] of ranked.entries()) {
			notice.setMessage(`Quotes: reading paper ${i + 1} of ${ranked.length} with ${this.settings.chatModel}: ${item.title.slice(0, 60)}…`);
			const noteLink = this.noteFor(item).path.replace(/\.md$/, "");
			const pdf = await this.readPdf(item.pdfPath, item.title);
			if ("error" in pdf) {
				hits.push({ item, noteLink, quotes: [], pagesSeen: 0, numPages: 0, error: pdf.error });
				continue;
			}
			const budget = budgetPages(pdf.pages, this.settings.numCtx);
			try {
				const reply = await this.ollama.chat({
					model: this.settings.chatModel,
					messages: quotesMessages(item, budget, question),
					options: { num_ctx: this.settings.numCtx, temperature: 0.1 },
					think,
					keep_alive: "10m",
				});
				hits.push({ item, noteLink, quotes: parseQuotes(reply), pagesSeen: budget.pagesIncluded.length, numPages: pdf.numPages });
			} catch (err) {
				hits.push({ item, noteLink, quotes: [], pagesSeen: budget.pagesIncluded.length, numPages: pdf.numPages, error: this.describeModelError(err) });
			}
		}
		notice.hide();
		const folder = normalizePath(`${this.settings.notesFolder}/Quotes`);
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		const path = normalizePath(`${folder}/${quoteSearchFileName(question)}.md`);
		const content = renderQuoteSearch(question, hits, { model: this.settings.chatModel, date: today(), libraryLabel: `${total} papers` });
		const existing = this.app.vault.getAbstractFileByPath(path);
		const file = existing instanceof TFile ? (await this.app.vault.modify(existing, content), existing) : await this.app.vault.create(path, content);
		await this.app.workspace.getLeaf(false).openFile(file);
		const found = hits.filter((h) => h.quotes.length).length;
		new Notice(found ? `Quotes from ${found} of ${hits.length} papers written to ${path}.` : `No relevant passage in the ${hits.length} papers read; the note lists what was tried.`, 10000);
	}

	private describeModelError(err: unknown): string {
		const message = (err as Error).message ?? String(err);
		if (err instanceof OllamaError && /not found|no such model/i.test(message)) return `${message}. Run: ollama pull ${this.settings.chatModel}`;
		return message;
	}

	async writeReadingNotes(file: TFile): Promise<void> {
		const item = this.catalog.items[this.zoteroKeyOf(file) ?? ""];
		if (!item) return;
		const extracted = await this.pagesFor(file, item);
		if (!extracted) return;
		const budget = budgetPages(extracted.pages, this.settings.numCtx);
		const notice = new Notice(`Reading ${budget.pagesIncluded.length} of ${extracted.numPages} pages with ${this.settings.chatModel}…`, 0);
		try {
			const text = await this.ollama.chat({
				model: this.settings.chatModel,
				messages: readingNotesMessages(item, budget),
				options: { num_ctx: this.settings.numCtx, temperature: 0.2 },
				think: this.settings.thinking === "auto" ? undefined : this.settings.thinking === "on",
				keep_alive: "10m",
			});
			notice.hide();
			if (!text.trim()) {
				new Notice("The model returned nothing.");
				return;
			}
			const footer = `_Written by ${this.settings.chatModel} from ${budget.pagesIncluded.length} of ${extracted.numPages} pages on ${today()}${budget.truncated ? "; pages were sampled to fit the context window" : ""}._`;
			const current = await this.app.vault.read(file);
			await this.app.vault.modify(file, replaceSection(current, SECTION_READING, `${text.trim()}\n\n${footer}`));
			new Notice(hasPageCitations(text) ? "Reading notes written." : "Reading notes written, but the model did not cite pages; try a larger model.", 8000);
		} catch (err) {
			notice.hide();
			new Notice(`Reading notes failed: ${this.describeModelError(err)}`, 12000);
		}
	}

	async askPaper(file: TFile): Promise<void> {
		const item = this.catalog.items[this.zoteroKeyOf(file) ?? ""];
		if (!item) return;
		const modal = new QuestionModal(this.app, item.title);
		modal.open();
		const question = await modal.result;
		if (!question) return;
		const extracted = await this.pagesFor(file, item);
		if (!extracted) return;
		const budget = budgetPages(extracted.pages, this.settings.numCtx);
		const notice = new Notice(`Asking ${this.settings.chatModel}…`, 0);
		try {
			const answer = await this.ollama.chat({
				model: this.settings.chatModel,
				messages: askMessages(item, budget, question),
				options: { num_ctx: this.settings.numCtx, temperature: 0.2 },
				think: this.settings.thinking === "auto" ? undefined : this.settings.thinking === "on",
				keep_alive: "10m",
			});
			notice.hide();
			const current = await this.app.vault.read(file);
			await this.app.vault.modify(file, appendQA(current, question, answer || "_No answer._", today()));
			new Notice("Answer added under Q&A.");
		} catch (err) {
			notice.hide();
			new Notice(`Question failed: ${this.describeModelError(err)}`, 12000);
		}
	}
}

export function expandHome(p: string): string {
	const t = p.trim();
	if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) return homedir() + t.slice(1);
	return t;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export type { ZoteroError };

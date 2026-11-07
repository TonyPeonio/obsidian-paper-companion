// The paper catalog (one compact record per Zotero item), the semantic index over it, and
// ranking. Persisted by the plugin as JSON; nothing here imports `obsidian`.

import { cosine } from "./ollama";

export interface PaperItem {
	/** Zotero item key, or a stable id from an export file. */
	key: string;
	/** Changes whenever the item changes (Zotero version, or a content hash for exports). */
	version: number;
	itemType: string;
	title: string;
	/** "Last, First" or a single name per creator, authors first. */
	creators: string[];
	year?: string;
	doi?: string;
	url?: string;
	abstract: string;
	tags: string[];
	/** Collection names. */
	collections: string[];
	citationKey?: string;
	/** Absolute path of the PDF when it could be resolved. */
	pdfPath?: string;
	dateModified?: string;
}

export interface Catalog {
	version: 1;
	source: "zotero" | "export";
	updated: string;
	items: Record<string, PaperItem>;
}

export interface PaperIndex {
	version: 1;
	model: string;
	/** Item key → the catalog version that was embedded and the vector. */
	vectors: Record<string, { version: number; vec: number[] }>;
}

export const PAPER_TYPES = new Set(["journalArticle", "conferencePaper", "preprint", "book", "bookSection", "thesis", "report", "webpage", "manuscript", "document"]);

export function emptyCatalog(source: Catalog["source"]): Catalog {
	return { version: 1, source, updated: new Date(0).toISOString(), items: {} };
}

export function emptyIndex(model: string): PaperIndex {
	return { version: 1, model, vectors: {} };
}

/** What the embedding model sees for an item. */
export function embedText(item: PaperItem): string {
	return `${item.title}\n${item.abstract}`.trim();
}

/** Items that have no vector yet, or whose catalog version differs from the embedded one, or when the model changed. */
export function itemsNeedingEmbedding(catalog: Catalog, index: PaperIndex, model: string): PaperItem[] {
	if (index.model !== model) return Object.values(catalog.items);
	return Object.values(catalog.items).filter((it) => index.vectors[it.key]?.version !== it.version);
}

/** Drops vectors of items no longer in the catalog. */
export function pruneIndex(catalog: Catalog, index: PaperIndex): PaperIndex {
	const vectors: PaperIndex["vectors"] = {};
	for (const [key, v] of Object.entries(index.vectors)) if (catalog.items[key]) vectors[key] = v;
	return { ...index, vectors };
}

export interface Ranked {
	item: PaperItem;
	score: number;
	/** How the score was produced. */
	by: "semantic" | "keyword";
}

export function rankBySimilarity(queryVec: number[], catalog: Catalog, index: PaperIndex, limit = 20): Ranked[] {
	const out: Ranked[] = [];
	for (const item of Object.values(catalog.items)) {
		const v = index.vectors[item.key];
		if (!v) continue;
		out.push({ item, score: cosine(queryVec, v.vec), by: "semantic" });
	}
	return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Word-overlap scoring over title, abstract, tags and creators; title hits count double. */
export function rankByKeywords(query: string, catalog: Catalog, limit = 20): Ranked[] {
	const terms = tokens(query);
	if (terms.length === 0) return [];
	const out: Ranked[] = [];
	for (const item of Object.values(catalog.items)) {
		const title = tokens(item.title);
		const rest = tokens(`${item.abstract} ${item.tags.join(" ")} ${item.creators.join(" ")} ${item.year ?? ""}`);
		let score = 0;
		for (const t of terms) {
			if (title.some((w) => w.startsWith(t))) score += 2;
			else if (rest.some((w) => w.startsWith(t))) score += 1;
		}
		if (score > 0) out.push({ item, score: score / (terms.length * 2), by: "keyword" });
	}
	return out.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title)).slice(0, limit);
}

export function tokens(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length >= 3 && !STOP.has(w));
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "are", "was", "were", "has", "have", "into", "over", "under", "about", "between", "using", "based", "toward", "towards", "via", "per", "its", "our", "their", "than", "then", "can", "not", "all", "any"]);

/** "Last, First" → "Last"; "Full Name" → last word. */
export function lastName(creator: string): string {
	const comma = creator.indexOf(",");
	if (comma >= 0) return creator.slice(0, comma).trim();
	const parts = creator.trim().split(/\s+/);
	return parts[parts.length - 1] ?? creator;
}

/** "Smith et al. (2024)" style author label for lists. */
export function authorLabel(item: PaperItem): string {
	const names = item.creators.map(lastName).filter(Boolean);
	if (names.length === 0) return "Unknown";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} et al.`;
}

/** A stable positive integer from text, used as the version of items from export files. */
export function hashVersion(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return h >>> 0;
}

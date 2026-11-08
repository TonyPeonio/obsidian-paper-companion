// PDF text per page via pdf.js. Obsidian ships pdf.js and exposes it through `loadPdfJs()`,
// so no dependency is bundled; the loader is injected to keep this testable. Pages are kept
// apart so reading notes can cite `[p. N]`.

export interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
	/** pdf.js text matrix `[a, b, c, d, x, y]`; x and y are the item's origin on the page. */
	transform?: number[];
	width?: number;
	height?: number;
}

export interface PdfPageLike {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

export interface PdfDocumentLike {
	numPages: number;
	getPage(n: number): Promise<PdfPageLike>;
	destroy?(): Promise<void> | void;
}

export interface PdfJsLike {
	getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocumentLike> };
}

export interface PdfPages {
	/** Text of page 1 at index 0, cleaned: one line per text line, no blank lines. */
	pages: string[];
	/** Pages in the document, which may exceed `pages.length` when capped. */
	numPages: number;
}

export async function extractPdfPages(bytes: Uint8Array, pdfjs: PdfJsLike, maxPages = 400): Promise<PdfPages> {
	const doc = await pdfjs.getDocument({ data: bytes }).promise;
	const pages: string[] = [];
	try {
		const n = Math.min(doc.numPages, maxPages);
		for (let i = 1; i <= n; i++) {
			const page = await doc.getPage(i);
			const content = await page.getTextContent();
			pages.push(joinTextItems(content.items));
		}
		return { pages: dehyphenate(pages), numPages: doc.numPages };
	} finally {
		await doc.destroy?.();
	}
}

/**
 * Joins pdf.js text items into lines. Items are not words: a word is often split around a
 * ligature ("work", "fl", "ow") or a font change ("(TNF", "α", ")"), and word spaces usually
 * arrive as their own " " items. So two items are glued when the second starts where the
 * first ends on the page; a space is inserted only across a real gap (or a jump to another
 * column), or when positions are unavailable.
 */
export function joinTextItems(items: PdfTextItem[]): string {
	let text = "";
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (typeof item.str === "string") text += item.str;
		if (item.hasEOL) {
			text += "\n";
			continue;
		}
		const next = items[i + 1];
		if (next && !gluedTo(item, next)) text += " ";
	}
	return text
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l.length > 0)
		.join("\n");
}

/** A word broken over a line end: "indepen-\ndently", or a compound split at its own hyphen. */
const LINE_BREAK_HYPHEN = /(\p{Ll}{2,})-\n(\p{Ll}+)/gu;

/**
 * Puts a word the typesetter broke over a line end back together, so a passage can be quoted
 * as the paper reads: "indepen-\ndently" is one word, while "ligand-\nreceptor" is a compound
 * that keeps its hyphen. Which it is, is decided by how the document itself spells the word
 * elsewhere (papers are repetitive, so it usually does), and otherwise by whether both halves
 * stand alone as words in it. In this library the split is a broken word about nine times out
 * of ten, so an unknown word is joined without the hyphen.
 */
export function dehyphenate(pages: string[]): string[] {
	const words = new Set<string>();
	for (const page of pages) {
		const lines = page.split("\n");
		for (let i = 0; i < lines.length; i++) {
			// The half-word left by a break is no evidence of anything: skip the word that starts a
			// line continuing a hyphen, as the trailing "com-" is skipped by carrying its hyphen.
			const broken = i > 0 && /\p{Ll}{2,}-$/u.test(lines[i - 1]);
			for (const word of (broken ? lines[i].replace(/^\p{L}+/u, "") : lines[i]).toLowerCase().match(/\p{L}[\p{L}-]*/gu) ?? []) words.add(word);
		}
	}
	return pages.map((page) =>
		page.replace(LINE_BREAK_HYPHEN, (_match, left: string, right: string) => {
			const l = left.toLowerCase();
			const r = right.toLowerCase();
			const compound = words.has(`${l}-${r}`) || (!words.has(l + r) && words.has(l) && words.has(r));
			return compound ? `${left}-${right}` : `${left}${right}`;
		}),
	);
}

function gluedTo(a: PdfTextItem, b: PdfTextItem): boolean {
	if (!a.transform || !b.transform || typeof a.width !== "number") return false;
	if (/\s$/.test(a.str ?? "") || /^\s/.test(b.str ?? "")) return true;
	const gap = b.transform[4] - (a.transform[4] + a.width);
	const size = Math.max(a.height ?? 0, b.height ?? 0);
	// Glyph boxes from the same word overlap or touch within a small fraction of the font size.
	const tolerance = Math.max(0.5, size * 0.12);
	return Math.abs(gap) <= tolerance;
}

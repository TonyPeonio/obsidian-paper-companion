// PDF text per page via pdf.js. Obsidian ships pdf.js and exposes it through `loadPdfJs()`,
// so no dependency is bundled; the loader is injected to keep this testable. Pages are kept
// apart so reading notes can cite `[p. N]`.

export interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
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
			let text = "";
			for (const item of content.items) {
				if (typeof item.str === "string") text += item.str;
				text += item.hasEOL ? "\n" : " ";
			}
			pages.push(
				text
					.split("\n")
					.map((l) => l.replace(/\s+/g, " ").trim())
					.filter((l) => l.length > 0)
					.join("\n"),
			);
		}
		return { pages, numPages: doc.numPages };
	} finally {
		await doc.destroy?.();
	}
}

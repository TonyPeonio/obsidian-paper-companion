import { describe, expect, it } from "vitest";
import { dehyphenate, extractPdfPages, joinTextItems, type PdfJsLike, type PdfTextItem } from "../src/core/pdf";

/** A text item laid out on a line: `x` is the left edge, `width` as pdf.js reports it. */
const at = (str: string, x: number, width: number, extra: Partial<PdfTextItem> = {}): PdfTextItem => ({ str, transform: [10, 0, 0, 10, x, 700], width, height: 10, hasEOL: false, ...extra });

describe("joinTextItems", () => {
	it("glues the pieces of a word split around a ligature or a font change, and keeps the PDF's own spaces", () => {
		// "An end-to-end workflow for" as a Nature PDF emits it: the "fl" ligature is its own item
		// that starts exactly where "work" ends; word spaces are separate " " items.
		const items = [at("An end-to-end work", 40, 90), at("fl", 130, 5), at("ow", 135, 12), at(" ", 147, 2), at("for signi", 149, 40), at("fi", 189, 5), at("cant (TNF", 194, 40), at("α", 234, 6), at(").", 240, 8, { hasEOL: true })];
		expect(joinTextItems(items)).toBe("An end-to-end workflow for significant (TNFα).");
	});

	it("separates items across a real gap, a column jump, or a missing position", () => {
		// 2.5 pt is a word space at 10 pt; -150 means the next run sits in another column.
		expect(joinTextItems([at("Seminars", 100, 40), at("in", 142.5, 10), at("Article", 300, 30), at("26 August 2021", 150, 60, { hasEOL: true })])).toBe("Seminars in Article 26 August 2021");
		expect(joinTextItems([{ str: "no" }, { str: "positions", hasEOL: true }])).toBe("no positions");
	});

	it("keeps superscript references attached to their word like the page does", () => {
		const items = [at("QisDAX", 40, 30), { str: "45,46", transform: [6, 0, 0, 6, 70, 704], width: 10, height: 6 }, at(", which", 80, 30, { hasEOL: true })];
		expect(joinTextItems(items)).toBe("QisDAX45,46, which");
	});

	it("drops blank lines and collapses runs of whitespace", () => {
		expect(joinTextItems([{ str: "", hasEOL: true }, at("a", 0, 5), at(" ", 5, 2), at(" ", 7, 2), at("b", 9, 5, { hasEOL: true }), { str: "   ", hasEOL: true }])).toBe("a b");
	});
});

describe("dehyphenate", () => {
	it("joins a word broken over a line end, following how the document spells it elsewhere", () => {
		// "produced" appears whole further down, so "pro-/duced" was a broken word.
		const pages = ["cytokines pro-\nduced by cells", "the enzyme produced by cells"];
		expect(dehyphenate(pages)[0]).toBe("cytokines produced by cells");
		// "ligand-receptor" appears hyphenated elsewhere, so the hyphen belongs to the compound.
		expect(dehyphenate(["differences in ligand-\nreceptor engagement", "ligand-receptor interactions"])[0]).toBe("differences in ligand-receptor engagement");
	});

	it("does not treat the half-word a break leaves behind as evidence that the split is a compound", () => {
		// "plexity" is only ever the tail of the break itself, so this is one word, not "com-plexity".
		expect(dehyphenate(["as molecular com-\nplexity increases, the com-\nplexity of scoring grows"])[0]).toBe("as molecular complexity increases, the complexity of scoring grows");
		expect(dehyphenate(["a path for-\nward for demonstrations"])[0]).toBe("a path forward for demonstrations");
	});

	it("keeps the hyphen of an unknown split whose halves are both words, and drops it otherwise", () => {
		expect(dehyphenate(["a high-\nvolume run", "high accuracy and small volume"])[0]).toBe("a high-volume run");
		expect(dehyphenate(["imple-\nmenting it"])[0]).toBe("implementing it");
	});

	it("leaves hyphens that are not line breaks, and line ends that are not hyphenated, alone", () => {
		const pages = ["real-time control\nof the system", "pages 149–160\n1. Introduction", "see Fig. 2 -\nand Fig. 3"];
		expect(dehyphenate(pages)).toEqual(pages);
	});
});

describe("extractPdfPages", () => {
	it("returns one cleaned string per page in page order, capped at maxPages, and destroys the document", async () => {
		let destroyed = false;
		const pdfjs: PdfJsLike = {
			getDocument: () => ({
				promise: Promise.resolve({
					numPages: 3,
					getPage: (n: number) => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [at(`page ${n} work`, 40, 60), at("fl", 100, 5), at("ow", 105, 10, { hasEOL: true })] }) }),
					destroy: () => {
						destroyed = true;
					},
				}),
			}),
		};
		const out = await extractPdfPages(new Uint8Array(0), pdfjs, 2);
		expect(out).toEqual({ pages: ["page 1 workflow", "page 2 workflow"], numPages: 3 });
		expect(destroyed).toBe(true);
	});
});

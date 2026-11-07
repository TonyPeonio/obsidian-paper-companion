import { describe, expect, it } from "vitest";
import { parseExport } from "../src/core/exports";

describe("parseExport", () => {
	it("reads CSL JSON", () => {
		const csl = JSON.stringify([
			{ id: "lovelace2024", type: "article-journal", title: "Notes on the Engine", author: [{ family: "Lovelace", given: "Ada" }, { literal: "The Society" }], issued: { "date-parts": [[2024, 5]] }, DOI: "10.1/x", URL: "https://e.org", abstract: "An abstract.", keyword: "engines, history" },
			{ id: 2, type: "post", title: "ignored" },
		]);
		const items = parseExport(csl);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ key: "csl:lovelace2024", itemType: "journalArticle", title: "Notes on the Engine", creators: ["Lovelace, Ada", "The Society"], year: "2024", doi: "10.1/x", url: "https://e.org", abstract: "An abstract.", tags: ["engines", "history"], citationKey: "lovelace2024" });
		expect(items[0].version).toBeGreaterThan(0);
	});

	it("reads Better BibTeX JSON with citation keys and PDF attachments", () => {
		const bbt = JSON.stringify({
			config: { id: "36a3b0b5-bad0-4a04-b79b-441c7cef77db" },
			items: [
				{ itemKey: "ABCD1234", itemType: "conferencePaper", citationKey: "turing1950", title: "Computing Machinery", creators: [{ creatorType: "author", firstName: "Alan", lastName: "Turing" }], date: "1950", abstractNote: "Can machines think?", tags: [{ tag: "ai" }, "classic"], attachments: [{ title: "Snapshot", contentType: "text/html", path: "a.html" }, { title: "Full Text PDF", contentType: "application/pdf", localPath: "C:/Zotero/storage/XY/turing.pdf" }] },
				{ itemKey: "N", itemType: "attachment", title: "loose" },
			],
		});
		const items = parseExport(bbt);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ key: "bbt:ABCD1234", citationKey: "turing1950", year: "1950", creators: ["Turing, Alan"], tags: ["ai", "classic"], pdfPath: "C:/Zotero/storage/XY/turing.pdf" });
	});

	it("rejects other JSON", () => {
		expect(() => parseExport('{"hello": 1}')).toThrow(/CSL-JSON array or a Better BibTeX JSON/);
	});
});

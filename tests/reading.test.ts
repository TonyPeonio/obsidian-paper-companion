import { describe, expect, it } from "vitest";
import type { PaperItem } from "../src/core/catalog";
import { askMessages, budgetPages, hasPageCitations, readingNotesMessages } from "../src/core/reading";

const paper: PaperItem = { key: "K", version: 1, itemType: "journalArticle", title: "T", creators: ["Lovelace, Ada"], year: "1843", abstract: "", tags: [], collections: [] };

describe("budgetPages", () => {
	it("keeps every page with markers when they fit", () => {
		const b = budgetPages(["one", "two", "three"], 32768);
		expect(b.truncated).toBe(false);
		expect(b.pagesIncluded).toEqual([1, 2, 3]);
		expect(b.text).toBe("=== Page 1 ===\none\n\n=== Page 2 ===\ntwo\n\n=== Page 3 ===\nthree");
	});

	it("keeps leading pages, then samples the rest including the last page, within budget", () => {
		const pages = Array.from({ length: 40 }, (_, i) => `page ${i + 1} ` + "x".repeat(1500));
		// numCtx 8192 → about 26k chars minus reserve and overhead ≈ 17k chars ≈ 11 pages.
		const b = budgetPages(pages, 8192);
		expect(b.truncated).toBe(true);
		expect(b.text.length).toBeLessThanOrEqual(Math.floor(8192 * 3.2) - Math.floor(2000 * 3.2) - 2500 + 50);
		expect(b.pagesIncluded[0]).toBe(1);
		expect(b.pagesIncluded).toContain(40);
		expect(b.pagesIncluded.length).toBeGreaterThanOrEqual(8);
		// Leading pages are contiguous.
		const lead = b.pagesIncluded.filter((p) => p <= 6);
		expect(lead).toEqual([1, 2, 3, 4, 5, 6]);
		// Markers are in page order.
		const markers = Array.from(b.text.matchAll(/=== Page (\d+) ===/g)).map((m) => Number(m[1]));
		expect(markers).toEqual(b.pagesIncluded);
	});

	it("cuts a single oversized page instead of dropping it", () => {
		const b = budgetPages(["y".repeat(50000)], 4096);
		expect(b.pagesIncluded).toEqual([1]);
		expect(b.text).toContain("page cut to fit");
	});
});

describe("prompts", () => {
	it("ask the model for page citations and carry the pages and the question", () => {
		const b = budgetPages(["intro", "method"], 32768);
		const notes = readingNotesMessages(paper, b);
		expect(notes[0].role).toBe("system");
		expect(notes[0].content).toContain("[p. N]");
		expect(notes[0].content).toContain("### Key terms");
		expect(notes[1].content).toContain("Title: T\nAuthors: Lovelace, Ada\nYear: 1843");
		expect(notes[1].content).toContain("=== Page 2 ===\nmethod");
		const ask = askMessages(paper, { ...b, truncated: true }, "How many samples?");
		expect(ask[0].content).toContain("Only some pages were provided");
		expect(ask[1].content).toMatch(/Question: How many samples\?$/);
		expect(hasPageCitations("It computes [p. 2].")).toBe(true);
		expect(hasPageCitations("It computes.")).toBe(false);
	});
});

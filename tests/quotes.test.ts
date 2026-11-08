import { describe, expect, it } from "vitest";
import type { PaperItem } from "../src/core/catalog";
import { parseQuotes, quoteSearchFileName, quotesMessages, renderQuoteSearch } from "../src/core/quotes";
import { budgetPages } from "../src/core/reading";

const item: PaperItem = {
	key: "ABCD1234",
	version: 1,
	itemType: "journalArticle",
	title: "Attention is all you need",
	creators: ["Vaswani, Ashish", "Shazeer, Noam"],
	year: "2017",
	abstract: "",
	tags: [],
	collections: [],
	citationKey: "vaswaniAttention2017",
};

describe("parseQuotes", () => {
	it("reads straight and curly quotes with page citations in either style, dropping numbering and duplicates", () => {
		const text = [
			'1. "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks." [p. 1]',
			"- “We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.” (p. 1)",
			'- "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms." [p. 1]',
			"* Multi-head attention allows the model to jointly attend to information from different representation subspaces [pp. 4-5]",
			"- short [p. 2]",
		].join("\n");
		expect(parseQuotes(text)).toEqual([
			{ text: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.", page: 1 },
			{ text: "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.", page: 1 },
			{ text: "Multi-head attention allows the model to jointly attend to information from different representation subspaces", page: 4 },
		]);
	});

	it("returns nothing for NONE, blank or chatter-only replies", () => {
		expect(parseQuotes("NONE")).toEqual([]);
		expect(parseQuotes("  none.\n")).toEqual([]);
		expect(parseQuotes("")).toEqual([]);
		expect(parseQuotes("Sure!")).toEqual([]);
	});

	it("keeps a quote without a page as page null", () => {
		expect(parseQuotes('- "A sentence that is long enough to count as a quote."')).toEqual([{ text: "A sentence that is long enough to count as a quote.", page: null }]);
	});
});

describe("quotesMessages", () => {
	it("asks for verbatim quotes with page markers and names the paper", () => {
		const budget = budgetPages(["Page one text.", "Page two text."], 32768);
		const [system, user] = quotesMessages(item, budget, "What is the architecture?");
		expect(system.role).toBe("system");
		expect(system.content).toMatch(/word for word/);
		expect(system.content).toMatch(/NONE/);
		expect(user.content).toContain("=== Page 1 ===");
		expect(user.content).toContain("Attention is all you need");
		expect(user.content).toMatch(/Question: What is the architecture\?$/);
	});
});

describe("renderQuoteSearch and the file name", () => {
	it("puts papers with quotes first, cites each quote with its note link and page, and explains misses and errors", () => {
		const md = renderQuoteSearch(
			"How do they define attention?",
			[
				{ item, noteLink: "Papers/vaswaniAttention2017", quotes: [], pagesSeen: 10, numPages: 15 },
				{ item: { ...item, key: "K2", title: "Other", citationKey: undefined }, noteLink: "Papers/Vaswani 2017 Other", quotes: [{ text: "An attention function can be described as mapping a query and a set of key-value pairs to an output.", page: 3 }], pagesSeen: 12, numPages: 12 },
				{ item: { ...item, key: "K3", title: "Broken" }, noteLink: "Papers/Broken", quotes: [], pagesSeen: 0, numPages: 0, error: "no PDF" },
			],
			{ model: "qwen3.5:9b", date: "2026-11-07", libraryLabel: "41 papers" },
		);
		expect(md.startsWith("---\ntype: quote-search\nquestion: \"How do they define attention?\"\n")).toBe(true);
		expect(md).toContain("# How do they define attention?");
		expect(md).toContain("_1 of the 3 papers read had a relevant passage");
		const order = [md.indexOf("## [[Papers/Vaswani 2017 Other]]"), md.indexOf("## [[Papers/vaswaniAttention2017]]"), md.indexOf("## [[Papers/Broken]]")];
		expect(order[0]).toBeLessThan(order[1]);
		expect(md).toContain('> "An attention function can be described as mapping a query and a set of key-value pairs to an output."\n> — [[Papers/Vaswani 2017 Other]], p. 3');
		expect(md).toContain("_No relevant passage in the 10 of 15 pages read._");
		expect(md).toContain("_Could not read this paper: no PDF_");
	});

	it("turns the question into a safe, bounded file name", () => {
		expect(quoteSearchFileName("How do they define attention?")).toBe("How do they define attention");
		expect(quoteSearchFileName("a/b:c*d?")).not.toMatch(/[/:*?]/);
		expect(quoteSearchFileName("x".repeat(200)).length).toBeLessThanOrEqual(80);
		expect(quoteSearchFileName("???")).toBe("Quote search");
	});
});

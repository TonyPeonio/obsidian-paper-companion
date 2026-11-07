import { describe, expect, it } from "vitest";
import { authorLabel, emptyCatalog, emptyIndex, itemsNeedingEmbedding, pruneIndex, rankByKeywords, rankBySimilarity, type Catalog, type PaperItem } from "../src/core/catalog";

function item(key: string, title: string, abstract = "", over: Partial<PaperItem> = {}): PaperItem {
	return { key, version: 1, itemType: "journalArticle", title, creators: ["Lovelace, Ada"], abstract, tags: [], collections: [], ...over };
}

function catalog(...items: PaperItem[]): Catalog {
	const c = emptyCatalog("zotero");
	for (const i of items) c.items[i.key] = i;
	return c;
}

describe("itemsNeedingEmbedding / pruneIndex", () => {
	it("embeds new and changed items only, everything when the model changed, and prunes removed items", () => {
		const c = catalog(item("A", "a"), item("B", "b", "", { version: 2 }), item("C", "c"));
		const index = emptyIndex("nomic-embed-text");
		index.vectors.A = { version: 1, vec: [1, 0] };
		index.vectors.B = { version: 1, vec: [0, 1] };
		index.vectors.GONE = { version: 1, vec: [1, 1] };
		expect(itemsNeedingEmbedding(c, index, "nomic-embed-text").map((i) => i.key)).toEqual(["B", "C"]);
		expect(itemsNeedingEmbedding(c, index, "other-model")).toHaveLength(3);
		expect(Object.keys(pruneIndex(c, index).vectors)).toEqual(["A", "B"]);
	});
});

describe("ranking", () => {
	it("ranks by cosine similarity, skipping items without vectors", () => {
		const c = catalog(item("A", "a"), item("B", "b"), item("C", "c"));
		const index = emptyIndex("m");
		index.vectors.A = { version: 1, vec: [1, 0] };
		index.vectors.B = { version: 1, vec: [0.6, 0.8] };
		const out = rankBySimilarity([1, 0], c, index, 5);
		expect(out.map((r) => r.item.key)).toEqual(["A", "B"]);
		expect(out[0].score).toBeCloseTo(1);
		expect(out[1].score).toBeCloseTo(0.6);
		expect(out[0].by).toBe("semantic");
	});

	it("falls back to keyword overlap with title hits weighted double", () => {
		const c = catalog(item("A", "Graph neural networks for molecules", "We study GNNs."), item("B", "Protein folding", "Neural networks predict structure of molecules."), item("C", "Cooking pasta", "Boil water."));
		const out = rankByKeywords("neural molecules", c);
		expect(out.map((r) => r.item.key)).toEqual(["A", "B"]);
		expect(out[0].score).toBe(1);
		expect(out[1].score).toBe(0.5);
		expect(rankByKeywords("the and", c)).toEqual([]);
	});
});

describe("authorLabel", () => {
	it("formats one, two and many authors", () => {
		expect(authorLabel(item("A", "t", "", { creators: [] }))).toBe("Unknown");
		expect(authorLabel(item("A", "t"))).toBe("Lovelace");
		expect(authorLabel(item("A", "t", "", { creators: ["Lovelace, Ada", "Alan Turing"] }))).toBe("Lovelace and Turing");
		expect(authorLabel(item("A", "t", "", { creators: ["Lovelace, Ada", "Turing, Alan", "Hopper, Grace"] }))).toBe("Lovelace et al.");
	});
});

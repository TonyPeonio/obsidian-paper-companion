import { describe, expect, it } from "vitest";
import type { PaperItem } from "../src/core/catalog";
import { appendQA, mergeLiteratureNote, noteBaseName, renderLiteratureNote, replaceSection, sectionBody, SECTION_READING } from "../src/core/notes";

const paper: PaperItem = {
	key: "ABCD1234",
	version: 3,
	itemType: "journalArticle",
	title: "Notes on the Analytical Engine: A Study",
	creators: ["Lovelace, Ada", "Babbage, Charles"],
	year: "1843",
	doi: "10.1000/engine",
	abstract: "We describe the engine. It computes.",
	tags: ["history", "computing machines"],
	collections: ["Thesis"],
	pdfPath: "/z/storage/XY/engine.pdf",
};

describe("noteBaseName", () => {
	it("prefers the citation key and otherwise builds Author Year Title", () => {
		expect(noteBaseName({ ...paper, citationKey: "lovelace1843notes" })).toBe("lovelace1843notes");
		expect(noteBaseName(paper)).toBe("Lovelace 1843 Notes on the Analytical Engine A");
		expect(noteBaseName({ ...paper, creators: [], year: undefined, title: 'Odd: "chars" / <here>' })).toBe("Unknown Odd chars here");
	});
});

describe("renderLiteratureNote / mergeLiteratureNote", () => {
	it("renders frontmatter, citation, abstract and the managed sections", () => {
		const md = renderLiteratureNote(paper);
		expect(md).toMatch(/^---\ntitle: "Notes on the Analytical Engine: A Study"\ntype: "paper"\nauthors:\n  - "Lovelace, Ada"\n  - "Babbage, Charles"\nyear: "1843"\ndoi: "10.1000\/engine"\nzotero_key: "ABCD1234"\ntags:\n  - "history"\n  - "computing-machines"\npdf: "\/z\/storage\/XY\/engine.pdf"\n---\n/);
		expect(md).toContain("# Notes on the Analytical Engine: A Study\n\nLovelace, Ada; Babbage, Charles (1843). *Notes on the Analytical Engine: A Study*. https://doi.org/10.1000/engine");
		expect(md).toContain("## Abstract\n\nWe describe the engine. It computes.");
		expect(md).toContain("## Reading notes\n\n_Run");
		expect(md).toMatch(/## My notes\n\n$/);
	});

	it("is idempotent and only adds missing keys and sections, never touching the user's text", () => {
		const fresh = renderLiteratureNote(paper);
		expect(mergeLiteratureNote(fresh, paper)).toBe(fresh);
		const edited = "---\ntitle: \"My own title\"\nzotero_key: \"ABCD1234\"\n---\n\n# Mine\n\n## My notes\n\nKeep this.\n";
		const merged = mergeLiteratureNote(edited, { ...paper, citationKey: "lov43" });
		expect(merged).toContain('title: "My own title"');
		expect(merged).not.toContain("Notes on the Analytical Engine: A Study\"\ntitle");
		expect(merged).toContain('citation_key: "lov43"');
		expect(merged).toContain("year: \"1843\"");
		expect(merged).toContain("Keep this.");
		expect(merged).toContain("## Reading notes");
		expect(merged.indexOf("## My notes")).toBeLessThan(merged.indexOf("## Reading notes"));
		expect(mergeLiteratureNote(merged, { ...paper, citationKey: "lov43" })).toBe(merged);
	});
});

describe("replaceSection / sectionBody / appendQA", () => {
	const note = "# T\n\n## Abstract\n\nabs\n\n## Reading notes\n\n_placeholder_\n\n## My notes\n\nmine\n";

	it("replaces only the target section", () => {
		const out = replaceSection(note, SECTION_READING, "### Claim\n- It computes [p. 2]");
		expect(out).toBe("# T\n\n## Abstract\n\nabs\n\n## Reading notes\n\n### Claim\n- It computes [p. 2]\n\n## My notes\n\nmine\n");
		expect(sectionBody(out, "Reading notes")).toBe("### Claim\n- It computes [p. 2]");
		expect(sectionBody(out, "Nope")).toBeNull();
		expect(replaceSection("# T\n", "New", "body")).toBe("# T\n\n## New\n\nbody\n");
	});

	it("appends Q&A entries, creating the section once", () => {
		const one = appendQA(note, "What?", "That [p. 1]", "2026-11-07");
		expect(one).toMatch(/## Q&A\n\n\*\*Q \(2026-11-07\):\*\* What\?\n\n\*\*A:\*\* That \[p\. 1\]\n$/);
		const two = appendQA(one, "Why?", "Because [p. 3]", "2026-11-08");
		expect(two.match(/## Q&A/g)).toHaveLength(1);
		expect(sectionBody(two, "Q&A")).toBe("**Q (2026-11-07):** What?\n\n**A:** That [p. 1]\n\n**Q (2026-11-08):** Why?\n\n**A:** Because [p. 3]");
		expect(two).toContain("## My notes\n\nmine");
	});
});

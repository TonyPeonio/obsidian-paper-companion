// Literature notes: file names, rendering, idempotent merging, section replacement, Q&A.

import { lastName, type PaperItem } from "./catalog";

export const SECTION_ABSTRACT = "Abstract";
export const SECTION_READING = "Reading notes";
export const SECTION_MY_NOTES = "My notes";
export const SECTION_QA = "Q&A";
export const READING_PLACEHOLDER = '_Run "Paper Companion: Write reading notes" with this note open to fill this section from the PDF._';

/** Characters Obsidian and file systems reject in names. */
export function safeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}

/** `citationKey`, else "Author Year Short-title". */
export function noteBaseName(item: PaperItem): string {
	if (item.citationKey) return safeFileName(item.citationKey);
	const author = item.creators.length ? lastName(item.creators[0]) : "Unknown";
	const words = item.title.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
	return safeFileName([author, item.year, words].filter(Boolean).join(" "));
}

export function citationLine(item: PaperItem): string {
	const authors = item.creators.length ? item.creators.join("; ") : "Unknown";
	const where = item.doi ? `https://doi.org/${item.doi}` : (item.url ?? "");
	return `${authors}${item.year ? ` (${item.year})` : ""}. *${item.title}*.${where ? ` ${where}` : ""}`;
}

function yaml(v: string): string {
	return JSON.stringify(v);
}

export function frontmatterFor(item: PaperItem): Record<string, string | string[]> {
	const fm: Record<string, string | string[]> = { title: item.title, type: "paper" };
	if (item.creators.length) fm.authors = item.creators;
	if (item.year) fm.year = item.year;
	if (item.doi) fm.doi = item.doi;
	if (item.url) fm.url = item.url;
	fm.zotero_key = item.key;
	if (item.citationKey) fm.citation_key = item.citationKey;
	if (item.tags.length) fm.tags = item.tags.map((t) => t.replace(/\s+/g, "-"));
	if (item.pdfPath) fm.pdf = item.pdfPath;
	return fm;
}

export function renderFrontmatter(fm: Record<string, string | string[]>): string {
	const lines = ["---"];
	for (const [k, v] of Object.entries(fm)) {
		if (Array.isArray(v)) {
			lines.push(`${k}:`);
			for (const x of v) lines.push(`  - ${yaml(x)}`);
		} else lines.push(`${k}: ${yaml(v)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

export function renderLiteratureNote(item: PaperItem): string {
	return [
		renderFrontmatter(frontmatterFor(item)),
		"",
		`# ${item.title}`,
		"",
		citationLine(item),
		"",
		`## ${SECTION_ABSTRACT}`,
		"",
		item.abstract || "_No abstract in Zotero._",
		"",
		`## ${SECTION_READING}`,
		"",
		READING_PLACEHOLDER,
		"",
		`## ${SECTION_MY_NOTES}`,
		"",
		"",
	].join("\n");
}

/** Splits a note into its leading frontmatter block (without the fences) and body. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!m) return { frontmatter: null, body: content };
	return { frontmatter: m[1], body: content.slice(m[0].length) };
}

/** Top-level keys of a frontmatter block. */
export function frontmatterKeys(block: string): Set<string> {
	const keys = new Set<string>();
	for (const line of block.split(/\r?\n/)) {
		const m = /^([A-Za-z_][\w-]*):/.exec(line);
		if (m) keys.add(m[1]);
	}
	return keys;
}

/**
 * Brings an existing literature note up to date without touching the user's text: missing
 * frontmatter keys are added, missing managed sections are appended; nothing else changes.
 */
export function mergeLiteratureNote(existing: string, item: PaperItem): string {
	const { frontmatter, body } = splitFrontmatter(existing);
	const wanted = frontmatterFor(item);
	let fmBlock: string;
	if (frontmatter === null) {
		fmBlock = renderFrontmatter(wanted);
	} else {
		const have = frontmatterKeys(frontmatter);
		const missing: Record<string, string | string[]> = {};
		for (const [k, v] of Object.entries(wanted)) if (!have.has(k)) missing[k] = v;
		const extra = Object.keys(missing).length ? renderFrontmatter(missing).split("\n").slice(1, -1).join("\n") : "";
		fmBlock = `---\n${frontmatter}${extra ? `\n${extra}` : ""}\n---`;
	}
	let newBody = body;
	if (!hasSection(newBody, SECTION_READING)) newBody = `${newBody.replace(/\s+$/, "")}\n\n## ${SECTION_READING}\n\n${READING_PLACEHOLDER}\n`;
	if (!hasSection(newBody, SECTION_MY_NOTES)) newBody = `${newBody.replace(/\s+$/, "")}\n\n## ${SECTION_MY_NOTES}\n\n`;
	const out = `${fmBlock}\n${newBody.startsWith("\n") ? "" : "\n"}${newBody}`;
	return out === existing ? existing : out;
}

export function hasSection(content: string, heading: string): boolean {
	return new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, "m").test(content);
}

/** The body under `## heading` (to the next `## ` or `# `), or null. */
export function sectionBody(content: string, heading: string): string | null {
	const re = new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, "m");
	const m = re.exec(content);
	if (!m) return null;
	const start = m.index + m[0].length;
	const rest = content.slice(start);
	const next = /^#{1,2} /m.exec(rest);
	return (next ? rest.slice(0, next.index) : rest).trim();
}

/** Replaces the body under `## heading`, appending the section when it is missing. */
export function replaceSection(content: string, heading: string, body: string): string {
	const re = new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, "m");
	const m = re.exec(content);
	const text = body.trim();
	if (!m) return `${content.replace(/\s+$/, "")}\n\n## ${heading}\n\n${text}\n`;
	const start = m.index + m[0].length;
	const rest = content.slice(start);
	const next = /^#{1,2} /m.exec(rest);
	const after = next ? rest.slice(next.index) : "";
	return `${content.slice(0, start)}\n\n${text}\n${after ? `\n${after}` : ""}`;
}

export function appendQA(content: string, question: string, answer: string, date: string): string {
	const entry = `**Q (${date}):** ${question.trim()}\n\n**A:** ${answer.trim()}`;
	if (!hasSection(content, SECTION_QA)) return `${content.replace(/\s+$/, "")}\n\n## ${SECTION_QA}\n\n${entry}\n`;
	const current = sectionBody(content, SECTION_QA) ?? "";
	return replaceSection(content, SECTION_QA, current ? `${current}\n\n${entry}` : entry);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

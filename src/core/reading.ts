// Prompts for reading notes and questions over a paper's pages, and the page budget that
// fits them into the model's context window.

import type { PaperItem } from "./catalog";
import type { ChatMessage } from "./ollama";

export const CHARS_PER_TOKEN = 3.2;
/** Tokens kept free for the model's answer. */
export const RESERVE_TOKENS = 2000;
/** Characters the instructions and metadata take, roughly. */
const PROMPT_OVERHEAD_CHARS = 2500;

export interface PageBudget {
	/** Pages joined with `=== Page N ===` markers, in page order. */
	text: string;
	/** 1-based page numbers included. */
	pagesIncluded: number[];
	truncated: boolean;
}

/**
 * Fits pages into `numCtx`: the first pages in full (abstract, introduction, method), then the
 * remaining pages sampled evenly so the results and conclusion are still represented. Each
 * included page keeps its number so citations stay honest.
 */
export function budgetPages(pages: string[], numCtx: number, reserveTokens = RESERVE_TOKENS): PageBudget {
	const budget = Math.max(2000, Math.floor(numCtx * CHARS_PER_TOKEN) - Math.floor(reserveTokens * CHARS_PER_TOKEN) - PROMPT_OVERHEAD_CHARS);
	const marker = (n: number) => `=== Page ${n} ===\n`;
	const total = pages.reduce((n, p) => n + p.length + marker(1).length + 2, 0);
	if (total <= budget) {
		return { text: pages.map((p, i) => marker(i + 1) + p).join("\n\n"), pagesIncluded: pages.map((_, i) => i + 1), truncated: false };
	}
	// First pass: leading pages up to 60% of the budget.
	const chosen = new Set<number>();
	let used = 0;
	const lead = Math.floor(budget * 0.6);
	for (let i = 0; i < pages.length; i++) {
		const cost = pages[i].length + marker(i + 1).length + 2;
		if (used + cost > lead) break;
		chosen.add(i);
		used += cost;
	}
	if (chosen.size === 0) chosen.add(0);
	// Second pass: sample the rest evenly until the budget is full, always trying the last page first.
	const rest = pages.map((_, i) => i).filter((i) => !chosen.has(i));
	const order: number[] = [];
	if (rest.length) {
		order.push(rest[rest.length - 1]);
		for (let step = 2; order.length < rest.length; step *= 2) {
			for (let k = 1; k < step; k += 2) {
				const idx = rest[Math.floor((k / step) * rest.length)];
				if (idx !== undefined && !order.includes(idx)) order.push(idx);
			}
		}
		for (const i of rest) if (!order.includes(i)) order.push(i);
	}
	let truncated = chosen.size < pages.length;
	for (const i of order) {
		const cost = pages[i].length + marker(i + 1).length + 2;
		if (used + cost > budget) continue;
		chosen.add(i);
		used += cost;
	}
	const included = Array.from(chosen).sort((a, b) => a - b);
	truncated = included.length < pages.length;
	// A single oversized page is cut rather than dropped.
	const text = included
		.map((i) => {
			const room = budget - marker(i + 1).length;
			const body = pages[i].length > room && included.length === 1 ? pages[i].slice(0, room) + "\n(… page cut to fit the context window)" : pages[i];
			return marker(i + 1) + body;
		})
		.join("\n\n");
	return { text, pagesIncluded: included.map((i) => i + 1), truncated };
}

function paperHeader(item: PaperItem): string {
	return [`Title: ${item.title}`, item.creators.length ? `Authors: ${item.creators.join("; ")}` : "", item.year ? `Year: ${item.year}` : "", item.doi ? `DOI: ${item.doi}` : ""].filter(Boolean).join("\n");
}

export function readingNotesMessages(item: PaperItem, pages: PageBudget): ChatMessage[] {
	const system = `You write structured reading notes on a research paper for a researcher's own notes.
You are given the paper's pages, each starting with a marker like "=== Page 7 ===". Write in markdown. Do not invent anything that is not in the pages; if the pages do not say, leave the bullet out.
Every bullet MUST end with a page citation in the form [p. N], where N is the number from the marker of the page the statement comes from (several pages: [p. 3, 5]).
Output exactly these sections, each a "###" heading, bullets under each:
### Claim
One to three bullets: what the paper claims to contribute.
### Method
How they did it: approach, model, algorithm, experimental setup.
### Data
Datasets, participants, materials, sample sizes, sources.
### Results
The main quantitative and qualitative findings, with the numbers the paper gives.
### Limitations
What the authors concede, and what the pages show was not done.
### Key terms
Bullets of "**term** — definition as the paper uses it".
### Related work mentioned
Prior work the paper positions itself against, named as the paper names it.
No title, no preamble, no closing remarks.${pages.truncated ? "\nOnly some pages were provided; do not guess about the missing ones." : ""}`;
	const user = `${paperHeader(item)}\n\n${pages.text}`;
	return [
		{ role: "system", content: system },
		{ role: "user", content: user },
	];
}

export function askMessages(item: PaperItem, pages: PageBudget, question: string): ChatMessage[] {
	const system = `You answer questions about one research paper from its pages, each starting with a marker like "=== Page 7 ===".
Answer in markdown, concisely, and support every statement with a page citation [p. N] taken from the markers. When asked for a quote, passage, definition or exact wording, copy the sentence(s) verbatim from the page in quotation marks, then the citation; never paraphrase a quote. If the pages do not contain the answer, say so plainly instead of guessing.${pages.truncated ? " Only some pages were provided." : ""}`;
	const user = `${paperHeader(item)}\n\n${pages.text}\n\nQuestion: ${question.trim()}`;
	return [
		{ role: "system", content: system },
		{ role: "user", content: user },
	];
}

/** True when the model's output cites pages at all; used to warn, never to reject. */
export function hasPageCitations(text: string): boolean {
	return /\[p\.\s*\d+/.test(text);
}

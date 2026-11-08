// Runs the quote-search prompt and parser against a running Ollama, using real abstracts from a
// running Zotero as stand-in "pages" (no PDF extraction outside Obsidian).
//   npx esbuild scripts/quotes-live.ts --bundle --platform=node --format=cjs --outfile=.e2e/quotes-live.cjs && node .e2e/quotes-live.cjs "your question"
import { OllamaClient } from "../src/core/ollama";
import { parseQuotes, quotesMessages } from "../src/core/quotes";
import { budgetPages } from "../src/core/reading";
import { ZoteroClient } from "../src/core/zotero";
import { nodeRequest } from "../src/node-http";

async function main() {
	const question = process.argv[2] ?? "What problem does this work set out to solve, in the authors' words?";
	const model = process.env.MODEL ?? "qwen3.5:9b";
	const zotero = new ZoteroClient(() => process.env.ZOTERO_URL ?? "http://127.0.0.1:23119", nodeRequest);
	const ollama = new OllamaClient(() => process.env.OLLAMA_URL ?? "http://localhost:11434");
	const items = (await zotero.topItems()).filter((i) => i.abstract && i.abstract.length > 300).slice(0, Number(process.env.N ?? 3));
	console.log(`${items.length} papers with abstracts; model ${model}; question: ${question}`);
	for (const item of items) {
		// Split the abstract into two fake pages so page citations have something to point at.
		const half = Math.floor(item.abstract.length / 2);
		const cut = item.abstract.indexOf(". ", half) + 2 || half;
		const budget = budgetPages([item.abstract.slice(0, cut), item.abstract.slice(cut)], 32768);
		const t0 = Date.now();
		const reply = await ollama.chat({ model, messages: quotesMessages(item, budget, question), think: false, options: { num_ctx: 32768, temperature: 0.1 } });
		const quotes = parseQuotes(reply);
		const verbatim = quotes.filter((q) => item.abstract.replace(/\s+/g, " ").includes(q.text)).length;
		console.log(`\n## ${item.title.slice(0, 70)} (${Date.now() - t0} ms)`);
		console.log(`raw reply: ${JSON.stringify(reply.slice(0, 200))}`);
		console.log(`parsed ${quotes.length} quote(s), ${verbatim} verbatim in the source:`);
		for (const q of quotes) console.log(`  [p. ${q.page}] ${q.text.slice(0, 140)}`);
	}
}
main().catch((err) => {
	console.error("FAILED:", err instanceof Error ? err.message : err);
	process.exit(1);
});

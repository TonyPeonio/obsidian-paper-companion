// Exercises the plugin's Ollama client against a running Ollama (uses Node's global fetch).
//   npx esbuild scripts/ollama-live.ts --bundle --platform=node --format=cjs --outfile=.e2e/ollama-live.cjs && node .e2e/ollama-live.cjs
import { OllamaClient } from "../src/core/ollama";

async function main() {
	const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
	const client = new OllamaClient(() => url);
	for (const [name, run] of [
		["version", () => client.version()],
		["listModels", async () => (await client.listModels()).map((m) => m.name).slice(0, 5)],
		["embed", async () => (await client.embed(process.env.EMBED ?? "nomic-embed-text", ["protein folding with attention"]))[0].length],
		["chat", () => client.chat({ model: process.env.MODEL ?? "qwen3.5:9b", messages: [{ role: "user", content: "Say OK." }], think: false, options: { num_predict: 5 } })],
	] as [string, () => Promise<unknown>][]) {
		const t0 = Date.now();
		try {
			console.log(`${name}: OK in ${Date.now() - t0} ms →`, JSON.stringify(await run()).slice(0, 160));
		} catch (err) {
			console.log(`${name}: FAILED → ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
void main();

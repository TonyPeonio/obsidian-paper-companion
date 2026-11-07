import { describe, expect, it } from "vitest";
import { cosine, OllamaClient, OllamaError, stripThinkTags } from "../src/core/ollama";

function streamOf(lines: object[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
	return new ReadableStream({
		start(controller) {
			controller.enqueue(enc.encode(text.slice(0, 9)));
			controller.enqueue(enc.encode(text.slice(9)));
			controller.close();
		},
	});
}

const fakeFetch = (handler: (url: string, init?: RequestInit) => Response) => ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;

describe("OllamaClient", () => {
	it("streams chat content and strips think tags; embeds and lists models", async () => {
		const client = new OllamaClient(
			() => "http://x/",
			fakeFetch((url) => {
				if (url.endsWith("/api/chat")) return new Response(streamOf([{ message: { content: "<think>hm</think>Hel" } }, { message: { content: "lo" }, done: true }]));
				if (url.endsWith("/api/embed")) return new Response(JSON.stringify({ embeddings: [[1, 2]] }));
				if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "a", size: 1, capabilities: ["tools"] }] }));
				return new Response("{}", { status: 404 });
			}),
		);
		const deltas: string[] = [];
		expect(await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) })).toBe("Hello");
		expect(deltas.join("")).toBe("<think>hm</think>Hello");
		expect(await client.embed("e", ["x"])).toEqual([[1, 2]]);
		expect(await client.embed("e", [])).toEqual([]);
		expect(await client.listModels()).toEqual([{ name: "a", size: 1, capabilities: ["tools"] }]);
	});

	it("falls back to the injected POST when fetch fails and surfaces Ollama errors", async () => {
		const client = new OllamaClient(
			() => "http://x",
			fakeFetch(() => {
				throw new Error("CORS");
			}),
			async (url) => (url.endsWith("/api/chat") ? { status: 200, text: JSON.stringify({ message: { content: "fallback" } }) } : { status: 404, text: JSON.stringify({ error: "model 'm' not found" }) }),
		);
		expect(await client.chat({ model: "m", messages: [] })).toBe("fallback");
		await expect(client.version()).rejects.toThrow(OllamaError);
		await expect(client.version()).rejects.toThrow(/not found/);
	});

	it("cosine and think stripping", () => {
		expect(cosine([1, 0], [1, 0])).toBe(1);
		expect(cosine([1, 0], [0, 1])).toBe(0);
		expect(stripThinkTags("<think>a</think>  b")).toBe("b");
	});
});

// Minimal Ollama client: streaming chat (fetch) with a non-streaming fallback through an
// injected POST (the plugin passes Obsidian's `requestUrl`, which bypasses CORS but cannot
// stream), embeddings, model listing. No Obsidian import, so it is unit-tested as is.

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ModelInfo {
	name: string;
	size: number;
	capabilities?: string[];
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	options?: { num_ctx?: number; temperature?: number; top_p?: number; top_k?: number; num_predict?: number };
	keep_alive?: string;
	/** Enable reasoning for thinking-capable models. Leave undefined to use the model default. */
	think?: boolean;
	signal?: AbortSignal;
	onDelta?(content: string): void;
}

export class OllamaError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "OllamaError";
	}
}

/** Non-streaming transport used when `fetch` is blocked; `body` is undefined for GET. */
export type FallbackPost = (url: string, body: string | undefined, method: "GET" | "POST") => Promise<{ status: number; text: string }>;
type FetchLike = typeof fetch;

export class OllamaClient {
	constructor(
		private getBaseUrl: () => string,
		private fetchImpl: FetchLike = (...args) => fetch(...args),
		private fallbackPost?: FallbackPost,
	) {}

	get baseUrl(): string {
		return this.getBaseUrl().trim().replace(/\/+$/, "");
	}

	async version(): Promise<string> {
		const res = await this.getJson("/api/version");
		return typeof res.version === "string" ? res.version : "unknown";
	}

	async listModels(): Promise<ModelInfo[]> {
		const res = await this.getJson("/api/tags");
		const models = Array.isArray(res.models) ? (res.models as Record<string, unknown>[]) : [];
		return models.map((m) => ({
			name: String(m.name),
			size: Number(m.size ?? 0),
			capabilities: Array.isArray(m.capabilities) ? (m.capabilities as string[]) : undefined,
		}));
	}

	async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
		if (inputs.length === 0) return [];
		const res = await this.postJson("/api/embed", { model, input: inputs }, signal);
		const embeddings = res.embeddings;
		if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
			throw new OllamaError("Ollama returned an unexpected embeddings payload");
		}
		return embeddings as number[][];
	}

	/** Streams the reply through `onDelta`; resolves with the full text (thinking stripped). */
	async chat(req: ChatRequest): Promise<string> {
		const body: Record<string, unknown> = {
			model: req.model,
			messages: req.messages,
			stream: true,
			options: req.options ?? {},
		};
		if (req.keep_alive) body.keep_alive = req.keep_alive;
		if (req.think !== undefined) body.think = req.think;
		const url = `${this.baseUrl}/api/chat`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: req.signal,
			});
		} catch (err) {
			if (req.signal?.aborted) throw err;
			if (this.fallbackPost) {
				body.stream = false;
				const r = await this.fallbackPost(url, JSON.stringify(body), "POST");
				if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
				const json = JSON.parse(r.text) as Record<string, unknown>;
				const raw = ((json.message ?? {}) as Record<string, unknown>).content;
				const content = stripThinkTags(typeof raw === "string" ? raw : "");
				req.onDelta?.(content);
				return content;
			}
			throw new OllamaError(`Cannot reach Ollama at ${this.baseUrl}. Is it running? (${(err as Error).message})`);
		}
		if (!response.ok) throw new OllamaError(extractError(await response.text(), response.status), response.status);
		if (!response.body) throw new OllamaError("Ollama returned an empty response body");
		let text = "";
		for await (const chunk of ndjson(response.body, req.signal)) {
			if (chunk.error) throw new OllamaError(typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error));
			const m = (chunk.message ?? {}) as Record<string, unknown>;
			if (typeof m.content === "string" && m.content.length > 0) {
				text += m.content;
				req.onDelta?.(m.content);
			}
		}
		return stripThinkTags(text);
	}

	private postJson(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.json("POST", path, JSON.stringify(body), signal);
	}

	/** /api/version and /api/tags accept GET only; a POST gets "405 method not allowed". */
	private getJson(path: string): Promise<Record<string, unknown>> {
		return this.json("GET", path, undefined);
	}

	private async json(method: "GET" | "POST", path: string, payload: string | undefined, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const url = `${this.baseUrl}${path}`;
		try {
			const res = await this.fetchImpl(url, payload === undefined ? { method, signal } : { method, headers: { "Content-Type": "application/json" }, body: payload, signal });
			if (!res.ok) throw new OllamaError(extractError(await res.text(), res.status), res.status);
			return (await res.json()) as Record<string, unknown>;
		} catch (err) {
			if (err instanceof OllamaError) throw err;
			if (signal?.aborted) throw err;
			if (this.fallbackPost) {
				const r = await this.fallbackPost(url, payload, method);
				if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
				return JSON.parse(r.text) as Record<string, unknown>;
			}
			throw new OllamaError(`Cannot reach Ollama at ${this.baseUrl}. Is it running? (${(err as Error).message})`);
		}
	}
}

/** Some models leak <think>…</think> into content when thinking is not separated. */
export function stripThinkTags(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

function extractError(text: string, status: number): string {
	try {
		const json = JSON.parse(text) as Record<string, unknown> | null;
		if (json && typeof json.error === "string") return json.error;
	} catch {
		// not JSON
	}
	return text.trim() ? `${status}: ${text.trim().slice(0, 300)}` : `Ollama returned HTTP ${status}`;
}

export async function* ndjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			if (signal?.aborted) {
				await reader.cancel();
				throw new DOMException("Aborted", "AbortError");
			}
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line) yield JSON.parse(line) as Record<string, unknown>;
			}
		}
		const rest = buffer.trim();
		if (rest) yield JSON.parse(rest) as Record<string, unknown>;
	} finally {
		reader.releaseLock();
	}
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

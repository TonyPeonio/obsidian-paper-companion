import type { HttpRequest, HttpRequestOptions, HttpResponse } from "../src/core/http";

/** In-memory HTTP: a handler per URL prefix, recording every request. */
export function fakeHttp(handler: (url: string, opts: HttpRequestOptions) => Partial<HttpResponse> | undefined): HttpRequest & { calls: string[] } {
	const calls: string[] = [];
	const fn = (async (opts: HttpRequestOptions) => {
		calls.push(opts.url);
		const res = handler(opts.url, opts);
		if (!res) return { status: 404, headers: {}, text: "not found", arrayBuffer: new ArrayBuffer(0) };
		return { status: res.status ?? 200, headers: res.headers ?? {}, text: res.text ?? "", arrayBuffer: res.arrayBuffer ?? new ArrayBuffer(0) };
	}) as HttpRequest & { calls: string[] };
	fn.calls = calls;
	return fn;
}

export function zoteroItem(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		key,
		version: 10,
		data: {
			key,
			version: 10,
			itemType: "journalArticle",
			title: `Paper ${key}`,
			creators: [
				{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
				{ creatorType: "author", firstName: "Alan", lastName: "Turing" },
			],
			abstractNote: `Abstract of ${key}.`,
			date: "2024-05-01",
			DOI: `10.1000/${key}`,
			url: `https://example.org/${key}`,
			tags: [{ tag: "ml" }],
			collections: ["COL1"],
			dateModified: "2026-01-01T00:00:00Z",
			...over,
		},
	};
}

// Node's http/https as the transport for Zotero's local API.
//
// Zotero refuses any request that carries an Origin header (so web pages cannot read a
// library) by closing the connection without a reply, and Obsidian's `requestUrl` sends
// `Origin: app://obsidian.md`. Node's http module sends no Origin, so the Zotero calls go
// through it; the plugin is desktop-only, where Node is available. Nothing here imports
// `obsidian`, so the module is unit-tested against a local server.
import type { HttpRequest, HttpResponse } from "./core/http";

type NodeHttpModule = typeof import("http");

function nodeModule(name: "http" | "https"): NodeHttpModule | null {
	try {
		return require(name) as NodeHttpModule;
	} catch {
		return null;
	}
}

export function nodeHttpAvailable(): boolean {
	return nodeModule("http") !== null;
}

const TIMEOUT_MS = 30_000;

export const nodeRequest: HttpRequest = (opts) =>
	new Promise<HttpResponse>((resolve, reject) => {
		let url: URL;
		try {
			url = new URL(opts.url);
		} catch {
			reject(new Error(`Not a valid URL: ${opts.url}`));
			return;
		}
		const mod = nodeModule(url.protocol === "https:" ? "https" : "http");
		if (!mod) {
			reject(new Error("Node's http module is not available"));
			return;
		}
		const headers: Record<string, string> = { ...(opts.headers ?? {}) };
		if (opts.contentType) headers["Content-Type"] = opts.contentType;
		const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : Buffer.from(opts.body);
		if (body) headers["Content-Length"] = String(body.byteLength);
		const req = mod.request(url, { method: opts.method ?? "GET", headers, timeout: TIMEOUT_MS }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("error", reject);
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				const out: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) {
					if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
				}
				resolve({
					status: res.statusCode ?? 0,
					headers: out,
					text: buf.toString("utf8"),
					arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
				});
			});
		});
		req.on("timeout", () => req.destroy(new Error(`no reply within ${TIMEOUT_MS / 1000} s`)));
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});

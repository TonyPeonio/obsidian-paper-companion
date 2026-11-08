import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeRequest } from "../src/node-http";

let server: Server;
let base = "";
let lastHeaders: IncomingHttpHeaders = {};

beforeAll(async () => {
	server = createServer((req, res) => {
		lastHeaders = req.headers;
		let body = "";
		req.on("data", (c: Buffer) => (body += c.toString()));
		req.on("end", () => {
			res.setHeader("Total-Results", "3");
			res.setHeader("Content-Type", "application/json");
			res.statusCode = req.url?.includes("missing") ? 404 : 200;
			res.end(JSON.stringify({ url: req.url, method: req.method, body }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
});

describe("nodeRequest", () => {
	it("sends no Origin header (Zotero drops requests that carry one) and returns status, headers and text", async () => {
		const res = await nodeRequest({ url: `${base}/api/users/0/items?limit=1`, headers: { Accept: "application/json" } });
		expect(res.status).toBe(200);
		expect(res.headers["total-results"]).toBe("3");
		expect(JSON.parse(res.text)).toMatchObject({ url: "/api/users/0/items?limit=1", method: "GET" });
		expect(lastHeaders.origin).toBeUndefined();
		expect(lastHeaders.accept).toBe("application/json");
	});

	it("posts a body with its content type and reports non-2xx statuses without throwing", async () => {
		const res = await nodeRequest({ url: `${base}/missing`, method: "POST", body: '{"a":1}', contentType: "application/json" });
		expect(res.status).toBe(404);
		expect(JSON.parse(res.text)).toMatchObject({ method: "POST", body: '{"a":1}' });
		expect(lastHeaders["content-type"]).toBe("application/json");
		expect(lastHeaders["content-length"]).toBe("7");
	});

	it("rejects a URL it cannot parse", async () => {
		await expect(nodeRequest({ url: "not a url" })).rejects.toThrow(/Not a valid URL/);
	});
});

// Talks to a running Zotero through the plugin's own client and Node transport.
//   npx esbuild scripts/zotero-live.ts --bundle --platform=node --format=cjs --outfile=.e2e/zotero-live.cjs && node .e2e/zotero-live.cjs
import { nodeRequest } from "../src/node-http";
import { ZoteroClient } from "../src/core/zotero";

async function main() {
	const url = process.env.ZOTERO_URL ?? "http://127.0.0.1:23119";
	const client = new ZoteroClient(() => url, nodeRequest);
	console.log("available:", await client.available());
	const collections = await client.collections();
	console.log("collections:", collections.size, [...collections.values()].slice(0, 5));
	const anyClient = client as unknown as Record<string, unknown>;
	const names = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter((n) => n !== "constructor" && typeof anyClient[n] === "function");
	console.log("methods:", names.join(", "));
	for (const name of ["papers", "items", "topItems", "library", "fetchItems", "all"]) {
		if (typeof anyClient[name] === "function") {
			const t0 = Date.now();
			const result = await (anyClient[name] as () => Promise<unknown>)();
			const list = Array.isArray(result) ? result : result instanceof Map ? [...result.values()] : [];
			console.log(`${name}(): ${list.length} items in ${Date.now() - t0} ms`);
			for (const item of list.slice(0, 3)) console.log("  ", JSON.stringify(item).slice(0, 220));
			break;
		}
	}
}
main().catch((err) => {
	console.error("FAILED:", err instanceof Error ? err.message : err);
	process.exit(1);
});

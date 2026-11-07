import { describe, expect, it } from "vitest";
import { attachPdfs, PAGE_SIZE, resolveAttachmentPath, toPaperItem, yearOf, ZoteroClient, ZoteroError } from "../src/core/zotero";
import { fakeHttp, zoteroItem } from "./fakes";

describe("ZoteroClient", () => {
	it("paginates with limit/start until Total-Results is reached and maps items", async () => {
		const items = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => zoteroItem(`K${i}`));
		const http = fakeHttp((url) => {
			const u = new URL(url);
			if (u.pathname === "/api/users/0/items/top") {
				const start = Number(u.searchParams.get("start") ?? 0);
				expect(u.searchParams.get("limit")).toBe(String(PAGE_SIZE));
				expect(u.searchParams.get("itemType")).toBe("-attachment || note");
				return { text: JSON.stringify(items.slice(start, start + PAGE_SIZE)), headers: { "Total-Results": String(items.length) } };
			}
			if (u.pathname === "/api/users/0/collections") return { text: JSON.stringify([{ key: "COL1", data: { name: "Thesis" } }]) };
			return undefined;
		});
		const client = new ZoteroClient(() => "http://localhost:23119/", http);
		const collections = await client.collections();
		const out = await client.topItems(collections);
		expect(out).toHaveLength(PAGE_SIZE + 5);
		expect(http.calls.filter((c) => c.includes("/items/top"))).toHaveLength(2);
		expect(out[0]).toMatchObject({ key: "K0", version: 10, title: "Paper K0", creators: ["Lovelace, Ada", "Turing, Alan"], year: "2024", doi: "10.1000/K0", tags: ["ml"], collections: ["Thesis"] });
	});

	it("skips non-paper types and reads a citation key from Extra", () => {
		expect(toPaperItem(zoteroItem("N", { itemType: "note" }), new Map())).toBeNull();
		const it = toPaperItem(zoteroItem("P", { itemType: "preprint", extra: "arXiv: 1234\nCitation Key: lovelace2024paper" }), new Map());
		expect(it?.citationKey).toBe("lovelace2024paper");
		expect(toPaperItem({ key: "X", data: { itemType: "book", title: "B", creators: [{ creatorType: "editor", name: "Some Org" }] } }, new Map())?.creators).toEqual(["Some Org"]);
	});

	it("reports unreachable and HTTP errors with the setting to enable", async () => {
		const down = new ZoteroClient(
			() => "http://localhost:23119",
			async () => {
				throw new Error("ECONNREFUSED");
			},
		);
		expect(await down.available()).toBe(false);
		await expect(down.collections()).rejects.toThrow(/Allow other applications/);
		const forbidden = new ZoteroClient(
			() => "http://localhost:23119",
			fakeHttp(() => ({ status: 403, text: "Forbidden" })),
		);
		await expect(forbidden.collections()).rejects.toBeInstanceOf(ZoteroError);
	});

	it("resolves storage:, attachments: and absolute paths, and attaches the first PDF per parent", () => {
		const att = (key: string, parentItem: string, path?: string, contentType = "application/pdf") => ({ key, parentItem, path, contentType, title: "" });
		expect(resolveAttachmentPath(att("A1", "P", "storage:Paper.pdf"), "/home/t/Zotero/")).toBe("/home/t/Zotero/storage/A1/Paper.pdf");
		expect(resolveAttachmentPath(att("A2", "P", "attachments:sub/x.pdf"), "/home/t/Zotero", "/data/papers")).toBe("/data/papers/sub/x.pdf");
		expect(resolveAttachmentPath(att("A2", "P", "attachments:sub/x.pdf"), "/home/t/Zotero")).toBeUndefined();
		expect(resolveAttachmentPath(att("A3", "P", "C:\\papers\\y.pdf"), "/home/t/Zotero")).toBe("C:\\papers\\y.pdf");
		expect(resolveAttachmentPath({ key: "A4", parentItem: "P", contentType: "application/pdf", filename: "z.pdf", title: "" }, "D:/Zotero")).toBe("D:/Zotero/storage/A4/z.pdf");
		const items = [toPaperItem(zoteroItem("P"), new Map())!, toPaperItem(zoteroItem("Q"), new Map())!];
		attachPdfs(items, [att("H", "P", "storage:page.html", "text/html"), att("A1", "P", "storage:Paper.pdf"), att("A9", "P", "storage:Second.pdf"), att("L", "Q", "attachments:q.pdf")], "/z");
		expect(items[0].pdfPath).toBe("/z/storage/A1/Paper.pdf");
		expect(items[1].pdfPath).toBeUndefined();
	});

	it("extracts years from Zotero date strings", () => {
		expect(yearOf("2024-05-01")).toBe("2024");
		expect(yearOf("May 1998")).toBe("1998");
		expect(yearOf("")).toBeUndefined();
	});
});

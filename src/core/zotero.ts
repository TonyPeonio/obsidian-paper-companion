// Zotero client over the local API that Zotero 7+ serves at http://localhost:23119/api/
// when "Allow other applications on this computer to communicate with Zotero" is enabled
// (Settings → Advanced). It mirrors the Web API v3 with the personal library addressed as
// `users/0`: /items/top, /items (itemType filters), /collections, pagination with
// `limit`/`start` and a `Total-Results` header. Read-only here.

import { PAPER_TYPES, type PaperItem } from "./catalog";
import { header, type HttpRequest } from "./http";

type Json = Record<string, unknown>;

export class ZoteroError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "ZoteroError";
	}
}

export interface ZoteroAttachment {
	key: string;
	parentItem?: string;
	contentType: string;
	/** `storage:Name.pdf`, `attachments:relative/path.pdf`, or an absolute path. */
	path?: string;
	filename?: string;
	title: string;
}

export const PAGE_SIZE = 100;
const MAX_PAGES = 200;

export class ZoteroClient {
	constructor(
		private getBaseUrl: () => string,
		private http: HttpRequest,
	) {}

	get baseUrl(): string {
		return this.getBaseUrl().trim().replace(/\/+$/, "") || "http://localhost:23119";
	}

	/** True when the local API answers. */
	async available(): Promise<boolean> {
		try {
			const res = await this.http({ url: `${this.baseUrl}/api/users/0/items/top?limit=1&format=json`, method: "GET" });
			return res.status >= 200 && res.status < 300;
		} catch {
			return false;
		}
	}

	async collections(): Promise<Map<string, string>> {
		const rows = await this.getAll("/api/users/0/collections");
		const out = new Map<string, string>();
		for (const row of rows) {
			const data = (row.data ?? {}) as Json;
			if (typeof row.key === "string" && typeof data.name === "string") out.set(row.key, data.name);
		}
		return out;
	}

	/** Every top-level item that is a paper-like type, mapped to the catalog shape (without PDFs). */
	async topItems(collectionNames?: Map<string, string>): Promise<PaperItem[]> {
		const rows = await this.getAll("/api/users/0/items/top", { itemType: "-attachment || note" });
		const names = collectionNames ?? new Map<string, string>();
		const out: PaperItem[] = [];
		for (const row of rows) {
			const item = toPaperItem(row, names);
			if (item) out.push(item);
		}
		return out;
	}

	/** Every attachment in the library in one pass, so PDFs are matched to parents without a request per item. */
	async attachments(): Promise<ZoteroAttachment[]> {
		const rows = await this.getAll("/api/users/0/items", { itemType: "attachment" });
		const out: ZoteroAttachment[] = [];
		for (const row of rows) {
			const data = (row.data ?? {}) as Json;
			if (typeof row.key !== "string") continue;
			out.push({
				key: row.key,
				parentItem: typeof data.parentItem === "string" ? data.parentItem : undefined,
				contentType: typeof data.contentType === "string" ? data.contentType : "",
				path: typeof data.path === "string" ? data.path : undefined,
				filename: typeof data.filename === "string" ? data.filename : undefined,
				title: typeof data.title === "string" ? data.title : "",
			});
		}
		return out;
	}

	/** Follows `start`/`limit` pagination until the `Total-Results` header or a short page says stop. */
	private async getAll(path: string, params: Record<string, string> = {}): Promise<Json[]> {
		const out: Json[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const start = page * PAGE_SIZE;
			const res = await this.request(this.url(path, { format: "json", limit: String(PAGE_SIZE), start: String(start), ...params }));
			const body = parseJson(res.text, res.status);
			if (!Array.isArray(body)) throw new ZoteroError(`Expected a list from ${path}`);
			out.push(...(body as Json[]));
			const total = Number(header(res.headers, "total-results"));
			if (body.length < PAGE_SIZE) break;
			if (Number.isFinite(total) && total > 0 && out.length >= total) break;
		}
		return out;
	}

	private async request(url: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
		let res;
		try {
			res = await this.http({ url, method: "GET", headers: { Accept: "application/json" } });
		} catch (err) {
			throw new ZoteroError(`Cannot reach Zotero at ${this.baseUrl}: ${(err as Error).message}. Is Zotero running with "Allow other applications on this computer to communicate with Zotero" enabled (Settings → Advanced)?`);
		}
		if (res.status >= 400) throw new ZoteroError(`Zotero returned HTTP ${res.status} for ${url}: ${res.text.slice(0, 200)}`, res.status);
		return res;
	}

	private url(path: string, params: Record<string, string>): string {
		const qs = Object.entries(params)
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join("&");
		return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
	}
}

/** Maps a Zotero item (web-API JSON) to the catalog shape; null for non-paper types. */
export function toPaperItem(row: Json, collectionNames: Map<string, string>): PaperItem | null {
	const data = (row.data ?? row) as Json;
	const itemType = typeof data.itemType === "string" ? data.itemType : "";
	if (!PAPER_TYPES.has(itemType)) return null;
	const key = typeof row.key === "string" ? row.key : typeof data.key === "string" ? data.key : "";
	if (!key) return null;
	const creators = Array.isArray(data.creators) ? (data.creators as Json[]) : [];
	const authors = creators
		.filter((c) => c.creatorType === undefined || c.creatorType === "author" || c.creatorType === "editor")
		.sort((a, b) => (a.creatorType === "author" ? 0 : 1) - (b.creatorType === "author" ? 0 : 1))
		.map(creatorName)
		.filter(Boolean);
	const tags = Array.isArray(data.tags) ? (data.tags as Json[]).map((t) => (typeof t.tag === "string" ? t.tag : "")).filter(Boolean) : [];
	const collections = Array.isArray(data.collections) ? (data.collections as string[]).map((k) => collectionNames.get(k) ?? "").filter(Boolean) : [];
	const extra = typeof data.extra === "string" ? data.extra : "";
	const citeMatch = /^Citation Key:\s*(\S+)/m.exec(extra);
	return {
		key,
		version: Number(row.version ?? data.version ?? 0),
		itemType,
		title: typeof data.title === "string" ? data.title : "(untitled)",
		creators: authors,
		year: yearOf(typeof data.date === "string" ? data.date : ""),
		doi: typeof data.DOI === "string" && data.DOI ? data.DOI : undefined,
		url: typeof data.url === "string" && data.url ? data.url : undefined,
		abstract: typeof data.abstractNote === "string" ? data.abstractNote.trim() : "",
		tags,
		collections,
		citationKey: typeof data.citationKey === "string" && data.citationKey ? data.citationKey : citeMatch?.[1],
		dateModified: typeof data.dateModified === "string" ? data.dateModified : undefined,
	};
}

export function creatorName(c: Json): string {
	if (typeof c.name === "string" && c.name) return c.name;
	const last = typeof c.lastName === "string" ? c.lastName : "";
	const first = typeof c.firstName === "string" ? c.firstName : "";
	return last && first ? `${last}, ${first}` : last || first;
}

export function yearOf(date: string): string | undefined {
	const m = /\b(1[5-9]\d\d|20\d\d|21\d\d)\b/.exec(date);
	return m ? m[1] : undefined;
}

/**
 * Attaches the first PDF of each parent to its item. `storage:Name.pdf` lives in
 * `<dataDir>/storage/<attachment key>/Name.pdf`; `attachments:rel/path` is relative to the
 * linked-attachment base directory (when the user set one); absolute paths pass through.
 */
export function attachPdfs(items: PaperItem[], attachments: ZoteroAttachment[], dataDir: string, linkedBaseDir = ""): void {
	const byParent = new Map<string, ZoteroAttachment[]>();
	for (const a of attachments) {
		if (!a.parentItem || !isPdf(a)) continue;
		const list = byParent.get(a.parentItem) ?? [];
		list.push(a);
		byParent.set(a.parentItem, list);
	}
	for (const item of items) {
		for (const a of byParent.get(item.key) ?? []) {
			const resolved = resolveAttachmentPath(a, dataDir, linkedBaseDir);
			if (resolved) {
				item.pdfPath = resolved;
				break;
			}
		}
	}
}

export function isPdf(a: ZoteroAttachment): boolean {
	return a.contentType === "application/pdf" || /\.pdf$/i.test(a.path ?? "") || /\.pdf$/i.test(a.filename ?? "");
}

export function resolveAttachmentPath(a: ZoteroAttachment, dataDir: string, linkedBaseDir = ""): string | undefined {
	const data = dataDir.replace(/[\\/]+$/, "");
	const p = a.path ?? "";
	if (p.startsWith("storage:")) return `${data}/storage/${a.key}/${p.slice("storage:".length)}`;
	if (p.startsWith("attachments:")) {
		const rel = p.slice("attachments:".length);
		return linkedBaseDir ? `${linkedBaseDir.replace(/[\\/]+$/, "")}/${rel}` : undefined;
	}
	if (/^([a-zA-Z]:[\\/]|\/)/.test(p)) return p;
	if (!p && a.filename) return `${data}/storage/${a.key}/${a.filename}`;
	return undefined;
}

function parseJson(text: string, status: number): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new ZoteroError(`Zotero returned a non-JSON response (HTTP ${status}): ${text.slice(0, 200)}`, status);
	}
}

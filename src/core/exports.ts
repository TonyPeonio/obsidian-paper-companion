// Library export files, for people who do not run Zotero's local API: CSL-JSON (Zotero's
// "CSL JSON" export, a JSON array) and Better BibTeX's "Better BibTeX JSON" (an object with
// `items`, each a Zotero item plus `citationKey` and `attachments[].path`).

import { hashVersion, PAPER_TYPES, type PaperItem } from "./catalog";
import { creatorName, yearOf } from "./zotero";

type Json = Record<string, unknown>;

export function parseExport(text: string): PaperItem[] {
	const json = JSON.parse(text) as unknown;
	if (Array.isArray(json)) return json.map((row) => fromCsl(row as Json)).filter((x): x is PaperItem => x !== null);
	if (json && typeof json === "object" && Array.isArray((json as Json).items)) {
		return ((json as Json).items as Json[]).map(fromBetterBibTeX).filter((x): x is PaperItem => x !== null);
	}
	throw new Error("Not a CSL-JSON array or a Better BibTeX JSON export.");
}

const CSL_TYPES: Record<string, string> = {
	"article-journal": "journalArticle",
	"paper-conference": "conferencePaper",
	article: "preprint",
	book: "book",
	chapter: "bookSection",
	thesis: "thesis",
	report: "report",
	webpage: "webpage",
	manuscript: "manuscript",
	document: "document",
};

export function fromCsl(row: Json): PaperItem | null {
	const itemType = CSL_TYPES[typeof row.type === "string" ? row.type : ""] ?? "";
	if (!PAPER_TYPES.has(itemType)) return null;
	const title = typeof row.title === "string" ? row.title : "(untitled)";
	const authors = Array.isArray(row.author)
		? (row.author as Json[]).map((a) => (typeof a.literal === "string" ? a.literal : [a.family, a.given].filter((x) => typeof x === "string" && x).join(", "))).filter(Boolean)
		: [];
	const issued = (row.issued as Json | undefined)?.["date-parts"];
	const year = Array.isArray(issued) && Array.isArray(issued[0]) && issued[0][0] !== undefined ? String(issued[0][0]) : undefined;
	const id = typeof row.id === "string" ? row.id : typeof row.id === "number" ? String(row.id) : title;
	const abstract = typeof row.abstract === "string" ? row.abstract.trim() : "";
	const tags = typeof row.keyword === "string" ? row.keyword.split(/[,;]\s*/).filter(Boolean) : [];
	return {
		key: `csl:${id}`,
		version: hashVersion(`${title}|${abstract}|${year ?? ""}`),
		itemType,
		title,
		creators: authors,
		year,
		doi: typeof row.DOI === "string" && row.DOI ? row.DOI : undefined,
		url: typeof row.URL === "string" && row.URL ? row.URL : undefined,
		abstract,
		tags,
		collections: [],
		citationKey: typeof row["citation-key"] === "string" ? row["citation-key"] : /^[A-Za-z][\w-]{2,}$/.test(id) ? id : undefined,
	};
}

export function fromBetterBibTeX(row: Json): PaperItem | null {
	const itemType = typeof row.itemType === "string" ? row.itemType : "";
	if (!PAPER_TYPES.has(itemType)) return null;
	const title = typeof row.title === "string" ? row.title : "(untitled)";
	const creators = Array.isArray(row.creators) ? (row.creators as Json[]).map(creatorName).filter(Boolean) : [];
	const abstract = typeof row.abstractNote === "string" ? row.abstractNote.trim() : "";
	const key = typeof row.itemKey === "string" ? row.itemKey : typeof row.key === "string" ? row.key : typeof row.citationKey === "string" ? row.citationKey : title;
	const tags = Array.isArray(row.tags) ? (row.tags as (Json | string)[]).map((t) => (typeof t === "string" ? t : typeof t.tag === "string" ? t.tag : "")).filter(Boolean) : [];
	const attachments = Array.isArray(row.attachments) ? (row.attachments as Json[]) : [];
	const pathOf = (a: Json): string => (typeof a.localPath === "string" ? a.localPath : typeof a.path === "string" ? a.path : "");
	const pdf = attachments.find((a) => (typeof a.contentType === "string" && a.contentType === "application/pdf") || /\.pdf$/i.test(pathOf(a)));
	const pdfPath = pdf ? (typeof pdf.localPath === "string" ? pdf.localPath : typeof pdf.path === "string" ? pdf.path : undefined) : undefined;
	const year = yearOf(typeof row.date === "string" ? row.date : "");
	return {
		key: `bbt:${key}`,
		version: hashVersion(`${title}|${abstract}|${year ?? ""}|${pdfPath ?? ""}`),
		itemType,
		title,
		creators,
		year,
		doi: typeof row.DOI === "string" && row.DOI ? row.DOI : undefined,
		url: typeof row.url === "string" && row.url ? row.url : undefined,
		abstract,
		tags,
		collections: [],
		citationKey: typeof row.citationKey === "string" && row.citationKey ? row.citationKey : undefined,
		pdfPath,
		dateModified: typeof row.dateModified === "string" ? row.dateModified : undefined,
	};
}

export interface PaperCompanionSettings {
	/** Zotero data directory, where `storage/<key>/<file>.pdf` lives. "~" is the home folder. */
	zoteroDataDir: string;
	/** Base URL of Zotero's local API. */
	zoteroApiUrl: string;
	/** Linked-attachment base directory (Zotero → Settings → Advanced → Files and Folders), for `attachments:` paths. */
	linkedAttachmentBaseDir: string;
	/** Fallback: a CSL-JSON or Better BibTeX JSON export file, used when the local API is off. */
	exportFilePath: string;
	/** Folder for literature notes. */
	notesFolder: string;
	/** How many top-ranked papers "Find quotes across papers" reads per question. */
	quoteSearchPapers: number;
	ollamaUrl: string;
	chatModel: string;
	embeddingModel: string;
	numCtx: number;
	/** "auto" uses the model default. */
	thinking: "auto" | "on" | "off";
}

export const DEFAULT_SETTINGS: PaperCompanionSettings = {
	zoteroDataDir: "~/Zotero",
	// 127.0.0.1 rather than localhost: Zotero listens on IPv4 only, and "localhost" may try ::1 first.
	zoteroApiUrl: "http://127.0.0.1:23119",
	linkedAttachmentBaseDir: "",
	exportFilePath: "",
	notesFolder: "Papers",
	quoteSearchPapers: 5,
	ollamaUrl: "http://localhost:11434",
	chatModel: "qwen3.5:9b",
	embeddingModel: "nomic-embed-text",
	numCtx: 32768,
	thinking: "off",
};

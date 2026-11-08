import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PaperCompanionPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";

export class PaperCompanionSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PaperCompanionPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = (): Promise<void> => this.plugin.saveSettings();

		new Setting(containerEl).setName("Zotero").setHeading();

		new Setting(containerEl)
			.setName("Local API URL")
			.setDesc("Zotero 7+ serves a read-only API at this address when Settings → Advanced → \"Allow other applications on this computer to communicate with Zotero\" is on. Keep 127.0.0.1 unless Zotero runs elsewhere.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.zoteroApiUrl).setValue(s.zoteroApiUrl).onChange(async (v) => {
					s.zoteroApiUrl = v.trim() || DEFAULT_SETTINGS.zoteroApiUrl;
					await save();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					const ok = await this.plugin.zotero.available();
					new Notice(
						ok
							? `Zotero answered at ${this.plugin.zotero.baseUrl}.`
							: `No Zotero at ${this.plugin.zotero.baseUrl}. Start Zotero 7 or later and enable "Allow other applications on this computer to communicate with Zotero" (Settings → Advanced), or set an export file below.`,
						10000,
					);
				}),
			);

		new Setting(containerEl)
			.setName("Zotero data directory")
			.setDesc("Where Zotero keeps storage/<key>/<file>.pdf (Zotero → Settings → Advanced → Files and Folders). \"~\" is your home folder.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.zoteroDataDir).setValue(s.zoteroDataDir).onChange(async (v) => {
					s.zoteroDataDir = v.trim() || DEFAULT_SETTINGS.zoteroDataDir;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Linked attachment base directory")
			.setDesc("Only for libraries that use linked files (attachments: paths). Leave empty otherwise.")
			.addText((t) =>
				t.setValue(s.linkedAttachmentBaseDir).onChange(async (v) => {
					s.linkedAttachmentBaseDir = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Export file (fallback)")
			.setDesc("Path of a CSL JSON or Better BibTeX JSON export of your library, used when the local API is not reachable. Better BibTeX's auto-export keeps it current.")
			.addText((t) =>
				t.setPlaceholder("~/Zotero/library.json").setValue(s.exportFilePath).onChange(async (v) => {
					s.exportFilePath = v.trim();
					await save();
				}),
			);

		new Setting(containerEl).setName("Notes").setHeading();

		new Setting(containerEl)
			.setName("Literature notes folder")
			.setDesc("Where notes for papers are created, one per paper, named by citation key when Zotero has one.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.notesFolder).setValue(s.notesFolder).onChange(async (v) => {
					s.notesFolder = v.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.notesFolder;
					await save();
				}),
			);

		new Setting(containerEl).setName("Model (Ollama)").setHeading();

		new Setting(containerEl)
			.setName("Ollama URL")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.ollamaUrl).setValue(s.ollamaUrl).onChange(async (v) => {
					s.ollamaUrl = v.trim() || DEFAULT_SETTINGS.ollamaUrl;
					await save();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Test connection").onClick(async () => {
					try {
						const version = await this.plugin.ollama.version();
						const models = await this.plugin.ollama.listModels();
						const missing = [s.chatModel, s.embeddingModel].filter((m) => !models.some((x) => x.name === m || x.name === `${m}:latest`));
						new Notice(`Connected to Ollama ${version} (${models.length} models).${missing.length ? ` Not installed: ${missing.join(", ")}. Run: ${missing.map((m) => `ollama pull ${m}`).join(" && ")}` : ""}`, 12000);
					} catch (err) {
						new Notice(`Connection failed: ${(err as Error).message}`, 10000);
					}
				}),
			);

		new Setting(containerEl)
			.setName("Chat model")
			.setDesc("Writes reading notes and answers questions. Needs a context window large enough for a paper; qwen3.5:9b at 32k is a good start.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.chatModel).setValue(s.chatModel).onChange(async (v) => {
					s.chatModel = v.trim() || DEFAULT_SETTINGS.chatModel;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Embedding model")
			.setDesc("Indexes titles and abstracts for search by meaning. Changing it re-embeds the library on the next sync.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.embeddingModel).setValue(s.embeddingModel).onChange(async (v) => {
					s.embeddingModel = v.trim() || DEFAULT_SETTINGS.embeddingModel;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Context window (num_ctx)")
			.setDesc("Tokens the model reads at once. Pages of a paper are fitted into this; more lets more of the paper in.")
			.addText((t) =>
				t.setValue(String(s.numCtx)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n >= 4096 && n <= 262144) {
						s.numCtx = n;
						await save();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Thinking mode")
			.setDesc("Reasoning for Qwen3-style models. Off is faster; reading notes rarely need it.")
			.addDropdown((d) =>
				d
					.addOptions({ off: "Off", auto: "Model default", on: "On" })
					.setValue(s.thinking)
					.onChange(async (v) => {
						s.thinking = v === "on" ? "on" : v === "auto" ? "auto" : "off";
						await save();
					}),
			);
	}
}

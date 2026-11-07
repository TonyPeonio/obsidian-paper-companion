import { type App, Modal, Setting, SuggestModal } from "obsidian";
import { authorLabel, type Ranked } from "./core/catalog";
import type PaperCompanionPlugin from "./main";

/** Search the catalog by meaning (or keywords), pick a paper, open or create its note. */
export class FindPapersModal extends SuggestModal<Ranked> {
	constructor(
		app: App,
		private plugin: PaperCompanionPlugin,
		private fixed: Ranked[] | null,
		private onPick: (r: Ranked) => unknown,
		placeholder = "Search your Zotero library by topic, title, author…",
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "open or create the literature note" },
			{ command: "esc", purpose: "close" },
		]);
		this.limit = 30;
	}

	async getSuggestions(query: string): Promise<Ranked[]> {
		if (this.fixed) {
			const q = query.trim().toLowerCase();
			return q ? this.fixed.filter((r) => `${r.item.title} ${r.item.creators.join(" ")} ${r.item.year ?? ""}`.toLowerCase().includes(q)) : this.fixed;
		}
		return this.plugin.rank(query, 30);
	}

	renderSuggestion(r: Ranked, el: HTMLElement): void {
		el.addClass("pc-suggestion");
		el.createDiv({ cls: "pc-suggestion-title", text: r.item.title });
		const meta = `${authorLabel(r.item)}${r.item.year ? ` (${r.item.year})` : ""}${r.by === "semantic" ? ` · ${Math.round(r.score * 100)}% match` : ""}${r.item.pdfPath ? " · PDF" : ""}`;
		el.createDiv({ cls: "pc-suggestion-meta", text: meta });
		const first = r.item.abstract.split(/(?<=[.!?])\s/)[0] ?? "";
		if (first) el.createDiv({ cls: "pc-suggestion-abstract", text: first.length > 160 ? first.slice(0, 159) + "…" : first });
	}

	onChooseSuggestion(r: Ranked): void {
		void this.onPick(r);
	}
}

/** One-line question for "Ask this paper". Enter asks, Escape cancels. */
export class QuestionModal extends Modal {
	private resolve!: (q: string | null) => void;
	readonly result: Promise<string | null>;
	private done = false;
	private value = "";

	constructor(
		app: App,
		private title: string,
	) {
		super(app);
		this.result = new Promise((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Ask this paper");
		contentEl.createEl("p", { cls: "pc-modal-help", text: this.title });
		new Setting(contentEl).setName("Question").addText((t) => {
			t.setPlaceholder("What dataset did they evaluate on, and how large was it?");
			t.onChange((v) => (this.value = v));
			t.inputEl.addClass("pc-modal-input");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && this.value.trim()) {
					e.preventDefault();
					this.finish(this.value.trim());
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText("Ask")
					.setCta()
					.onClick(() => this.finish(this.value.trim() || null)),
			);
	}

	private finish(q: string | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(q);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(null);
	}
}

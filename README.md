# Paper Companion

An [Obsidian](https://obsidian.md) plugin for researchers and students with a [Zotero](https://www.zotero.org) library: **search your papers by meaning**, create a literature note for any of them, and get **page-cited reading notes and answers** from a local model. Nothing leaves your machine: Zotero and [Ollama](https://ollama.com) both run on it.

- **Mini personal paper search.** Titles and abstracts of your whole Zotero library are embedded locally; *Find papers* ranks them by meaning ("protein folding with attention", "that paper about brownouts"), with keyword search as the fallback. *Related papers to this note* ranks the library against the note you are reading.
- **Literature notes from Zotero.** One note per paper, named by its citation key, with frontmatter (authors, year, DOI, Zotero key, tags, PDF path), the citation, the abstract and sections for the plugin's reading notes and your own notes. Creating a note again only adds what is missing.
- **Reading notes that cite pages.** The PDF is read page by page and fitted into the model's context window; the model writes Claim, Method, Data, Results, Limitations, Key terms and Related work, every bullet ending in `[p. N]`.
- **Ask this paper.** One question, one page-cited answer, appended under *Q&A*.
- **No accounts, no keys, no uploads.** Zotero's local API is read without a token; Ollama is on localhost by default.

Pairs with [Local Vault Agent](https://github.com/TonyPeonio/obsidian-local-vault-agent), which can search and compile across the literature notes this plugin writes, and with [Lecture Companion](https://github.com/TonyPeonio/obsidian-lecture-companion).

## Requirements

Desktop Obsidian (the plugin reads PDFs from the Zotero storage folder on disk).

1. **Zotero 7 or later** with its local API on: Zotero → *Settings → Advanced* → tick **"Allow other applications on this computer to communicate with Zotero"**. The API answers at `http://localhost:23119/api/` (read-only, no token) while Zotero is running.
   Without it, export your library once as *CSL JSON* (or let [Better BibTeX](https://retorque.re/zotero-better-bibtex/) auto-export *Better BibTeX JSON*) and point the plugin at that file.
2. **Ollama** with a chat model and an embedding model:
   ```
   ollama pull qwen3.5:9b
   ollama pull nomic-embed-text
   ```
   The chat model needs a context window large enough for a paper; 32k is the default. Any Ollama chat model works; a larger one writes better reading notes.

## Usage

1. **Settings → Paper Companion**: check the Zotero data directory (`~/Zotero` by default; Zotero shows it under *Settings → Advanced → Files and Folders*), press *Test* next to the local API URL, and *Test connection* for Ollama.
2. Run **Sync Zotero library** (first time: a Notice counts the papers being embedded; later syncs only embed what changed).
3. Click the book icon or run **Find papers**. Type what you are looking for; press Enter on a result to open its literature note (created under `Papers/` if it does not exist yet).
4. With a literature note open: **Write reading notes** fills the *Reading notes* section from the PDF; **Ask this paper** answers a question under *Q&A*. Your *My notes* section is never touched.

### Commands

| Command | What it does |
|---|---|
| Sync Zotero library | Reads the library (local API or export file), resolves PDFs, embeds new or changed items |
| Find papers | Search by meaning; Enter opens or creates the paper's literature note |
| Related papers to this note | Ranks the library against the open note's text |
| Write reading notes | Page-cited Claim / Method / Data / Results / Limitations / Key terms / Related work from the PDF |
| Ask this paper | A question answered from the PDF with page citations, appended under Q&A |

## How it works

**Zotero.** The plugin calls `/api/users/0/items/top` (paper types only), `/api/users/0/collections` and `/api/users/0/items?itemType=attachment` on the local API, pages of 100 at a time. Each item becomes a compact catalog record (title, creators, year, DOI, URL, abstract, tags, collections, citation key when Zotero's *Extra* field or Better BibTeX provides one, and the first PDF attachment resolved to `<data dir>/storage/<key>/<file>.pdf`). The catalog is stored in the plugin's data file; nothing is written to Zotero.

**Search.** `title + abstract` of every item is embedded with the embedding model and stored with the item's version, so a later sync embeds only items that changed. A query is embedded the same way and ranked by cosine similarity; when the index is empty or Ollama is down, a keyword score over title, abstract, tags and authors is used instead (title hits count double).

**Reading.** PDF text is extracted per page with Obsidian's bundled pdf.js. Pages are fitted into the context window: the leading pages (abstract, introduction, method) in full up to 60% of the budget, then the remaining pages sampled evenly with the last page first, so results and conclusion are represented; each included page is preceded by `=== Page N ===`, which is what the citations refer to. The reading-notes prompt forbids content that is not on the pages; the footer of the section records how many pages the model saw.

**Notes.** Only the *Reading notes* and *Q&A* sections are managed; everything else in a literature note is yours. A note is matched to its paper by the `zotero_key` in its frontmatter, so renaming the file is fine.

## Privacy and network use

Two local HTTP endpoints only: Zotero's local API (`http://localhost:23119`) and the Ollama URL you set (`http://localhost:11434` by default). No telemetry, no accounts. If you point Ollama at another machine on your LAN, abstracts, PDF text and your questions go to that machine.

## If Zotero is not detected

- Zotero must be running, version 7 or later, with *Allow other applications on this computer to communicate with Zotero* enabled; the plugin's *Test* button reports what it gets.
- The port is 23119 by default; a different Zotero build may use another. Set the URL in settings.
- As a fallback, export the library to CSL JSON (File → Export Library → CSL JSON) or use Better BibTeX's auto-export, and enter the file path. PDFs are then found only when the export carries their paths (Better BibTeX JSON does).

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm test        # unit tests (vitest), no Zotero or Ollama needed
npm run build   # type-check + Obsidian review lint + production bundle
```

`src/core/` (Zotero client, export parsing, catalog and ranking, PDF pages, prompts, note rendering) has no Obsidian dependency and is unit-tested with fakes; `src/main.ts`, the settings tab and the modals are the thin Obsidian layer.

To release: bump `version` in `manifest.json` and `package.json`, add the version to `versions.json`, write `release-notes/<version>.md`, commit, then push a tag named exactly `<version>`. The release workflow builds, tests, attests and publishes the GitHub release.

## License

MIT © Tony Peonio

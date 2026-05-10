# Vault-to-Wiki Instruction

Use this instruction when vault files need to be processed into durable wiki knowledge.

## Goal

Turn one vault file into the smallest correct wiki knowledge update.

The output may be:

- no wiki change (`skip`)
- one or more page updates (`apply`)
- a type/template proposal without page writes (`propose_only`)

Do not assume any page type is the default destination.

---

## Phase 1: Read the File

### Skill Discovery

Parser skills are installed under `<workspace-root>/.agents/skills/`. Do not assume any parser skill is present — check what is actually available.

| Skill | Purpose |
|---|---|
| `pdf` | Extract text and structure from PDF files |
| `docx` | Extract text and structure from DOCX files |
| `pptx` | Extract text, slide structure, and speaker notes from PPTX files |
| `xlsx` | Extract tables and data from XLSX/CSV files |
| `document-granular-decompose` | Extract document/image fulltext through TianGong Unstructure |

When `document-granular-decompose` is available, `WIKI_PARSER_SKILLS` includes it, and `UNSTRUCTURED_API_BASE_URL` plus `UNSTRUCTURED_AUTH_TOKEN` are set, prefer it for supported document/image formats before the type-specific parser skills below. The client should request JSON with `return_txt=true`, then use the plain text from `response.txt` / `txt` as the wiki agent's primary input. Keep JSON chunks and page numbers only for debugging or provenance evidence.

When any other parser skill is available and the vault file matches its type, use the skill. Read the skill's SKILL.md for interface details before invoking.

If a parser skill fails due to missing runtime dependencies, attempt to install (e.g., `pip install`, `npm install`) and retry. If resolution fails, fall back to direct reading and note the failure in the result manifest.

### File Type Strategies

**Markdown / Plain Text (md, txt)**
Read directly. For large files (>5000 lines), read in sections. Parse YAML frontmatter separately if present.

**PDF**
Prefer the `pdf` parser skill. Without it: attempt direct read; if unreadable, skip. Use PDF metadata (title, author, date, subject) to inform decisions.

**Word Documents (docx)**
Prefer the `docx` parser skill. Without it: skip (DOCX is a ZIP/XML archive, unreliable to read directly). Use document properties when available.

**Presentations (pptx)**
Prefer the `pptx` parser skill. Speaker notes are often more valuable than slide text. Without the skill: skip.

**Spreadsheets (xlsx, csv)**
Prefer the `xlsx` skill for xlsx. CSV can be read directly (check encoding — Chinese content may use GBK/GB2312). Not all tabular data is knowledge — look for definitions, rules, or structured descriptions rather than raw dumps.

**Structured Data (json, yaml, yml)**
Read and parse directly. Evaluate whether the structure itself is the knowledge (e.g., a schema) or merely a container.

**Image Files (png, jpg, jpeg, webp)**
Use vision to read and evaluate. If the image has extractable value (diagrams, flowcharts, visualizations), save with `tiangong-wiki asset save` and reference with `tiangong-wiki asset ref`. Every image in a wiki page MUST have a textual description — images cannot be indexed.

**Images Embedded in Documents**
Use vision to understand each image in context. Extract only high-value images via the relevant parser skill. Use `tiangong-wiki asset save/ref` to manage extracted files.

### Large and Complex Files

- Read incrementally — do not load the entire file at once.
- Summarize structure first (TOC, slide titles, sheet names) to identify high-value sections.
- Not every section is worth extracting.

### Encoding and Edge Cases

- Chinese content may use GBK, GB2312, or Big5. Try alternative encodings if garbled.
- Corrupted files: skip with a clear reason.
- Password-protected or empty files: skip immediately.

---

## Phase 2: Decide

### Core Rules

1. Discover the current ontology through the wiki CLI before deciding what to write.
2. Search for relevant existing pages before creating new ones.
3. Treat all page types equally. Choose the best fit, not a hardcoded fallback.
4. Skip transient, duplicate, or low-value files.
5. Preserve provenance with `sourceRefs` and type-specific source fields defined by the chosen template.
6. `sourceRefs` may only contain existing wiki page ids. Raw file provenance belongs in the page body or a field like `vaultPath`.
7. Only write frontmatter fields declared by the chosen type (`tiangong-wiki type show <type>`). Do not invent ad-hoc fields.
8. If the type system cannot represent the knowledge cleanly, prefer `propose_only` unless template evolution is explicitly allowed.

### Runtime Discovery

Use the CLI as source of truth:

- `tiangong-wiki type list --format json`
- `tiangong-wiki type show <type> --format json`
- `tiangong-wiki type recommend --text "<summary>" --keywords "a,b,c" --limit 5 --format json`
- `tiangong-wiki find` / `tiangong-wiki fts` / `tiangong-wiki page-info`

Notes:
- Do not use guessed subcommands such as `tiangong-wiki page find`.
- `find` and `list` already emit JSON; do not append `--format json`.

### Decision Model

Choose exactly one:

- **`skip`** — the file is noise, duplicate, transient, unreadable, or already fully represented.
- **`apply`** — the file adds durable knowledge expressible with existing page types.
- **`propose_only`** — the file has durable value but the current type system is not a clean fit.

### Value Heuristics

Favors `apply`:
- Durable documents with reusable knowledge
- Files that materially strengthen or revise an existing page
- Sources that introduce a clearly distinct knowledge object

Favors `skip`:
- Temporary exports, dumps, or duplicates
- Opaque binaries with no extractable content
- Screenshots with no standalone evidence value
- Files whose substance is already covered

Favors `propose_only`:
- The file is valuable but existing types are clearly awkward or lossy
- A new type would materially improve ontology quality

### Metadata Utilization

| Metadata | Where Found | How to Use |
|---|---|---|
| Title | PDF, DOCX, PPTX properties | Inform page title and nodeId |
| Author | PDF, DOCX, PPTX properties | May indicate relevant `person` pages, inform provenance |
| Creation / modification date | Most formats | Inform `createdAt`, assess recency |
| Subject / keywords | PDF, DOCX properties | Inform tags and search during discovery |
| Slide / page count | PDF, PPTX | Gauge complexity, anticipate splitting needs |

Do not blindly copy metadata into wiki fields — use it as input alongside actual content.

---

## Phase 3: Execute

### Page Update Rules

1. Prefer updating an existing page if the source is a revision, appendix, or reinforcement.
2. Create a new page only when the knowledge object is distinct and deserves its own identity.
3. Keep edits minimal, specific, and provenance-preserving.
4. After every change:
   - `tiangong-wiki sync --path <page-id>`
   - `tiangong-wiki lint --path <page-id> --format json`

### Manifest Contract

The workflow must write a valid `result.json` manifest with these fields:

- `status`
- `decision`
- `reason`
- `threadId`
- `skillsUsed`
- `createdPageIds`
- `updatedPageIds`
- `appliedTypeNames`
- `proposedTypes`
- `actions`
- `lint`

The service layer trusts this manifest, not free-form prose.

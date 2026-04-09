# Vault File Processing

How to read, parse, and extract content from vault files of different types during the vault-to-wiki workflow.

## 1. Skill Discovery and Dependency Resolution

Before processing any vault file, discover what parser skills are available in the current workspace.

### Discovery

Parser skills are installed under `<workspace-root>/.agents/skills/`. Codex discovers them automatically through workspace-local skill discovery. Do not assume any parser skill is present — check what is actually available.

Common parser skills:

| Skill | Purpose |
|---|---|
| `pdf` | Extract text and structure from PDF files |
| `docx` | Extract text and structure from DOCX files |
| `pptx` | Extract text, slide structure, and speaker notes from PPTX files |
| `xlsx` | Extract tables and data from XLSX/CSV files |

### Using a Parser Skill

When a parser skill is available and the vault file matches its type, use the skill to process the file. The skill handles format-specific complexity (layout reconstruction, table extraction, encoding normalization) and produces clean text output suitable for analysis.

Read the skill's SKILL.md to understand its interface, required inputs, and output format before invoking it.

### Missing Dependencies

If a parser skill is installed but fails due to missing runtime dependencies (e.g., a Python library, a system binary), check the skill's SKILL.md or error output for dependency requirements. Attempt to install the missing dependency (e.g., `pip install`, `npm install`, `brew install`) and retry. If dependency resolution fails, fall back to the direct reading strategies below and note the failure in the result manifest.

## 2. File Type Processing Strategies

### Markdown / Plain Text (md, txt)

Read the file directly. No parser skill required.

- For large files (>5000 lines), read in sections rather than loading the entire file at once.
- Markdown frontmatter (YAML between `---` delimiters) may contain useful metadata — parse it separately if present.

### PDF

Prefer the `pdf` parser skill when available. PDF structure can be complex (multi-column layouts, headers/footers, embedded tables, scanned pages with OCR requirements).

Without the skill: attempt to read the file directly. If the content is unreadable or garbled, note it in the result manifest and skip.

Pay attention to PDF metadata (title, author, creation date, subject) — these can help determine the source type and inform page creation decisions.

### Word Documents (docx)

Prefer the `docx` parser skill. DOCX files contain structured content (headings, lists, tables, styles) that the skill can preserve.

Without the skill: the file is a ZIP archive containing XML. Direct reading is unreliable — skip if no skill is available and note the reason.

Document properties (title, author, last modified date, comments) are useful metadata when available.

### Presentations (pptx)

Prefer the `pptx` parser skill. Presentations contain:

- Slide titles and body text
- Speaker notes (often contain more detailed explanations than the slides themselves)
- Embedded tables and charts

When processing presentations, treat speaker notes as a primary content source — they frequently contain the reasoning and context behind the slides.

Without the skill: skip and note the reason.

### Spreadsheets (xlsx, csv)

Prefer the `xlsx` parser skill for xlsx files. CSV files can be read directly.

Key considerations for tabular data:

- **Not all tables are knowledge.** A raw data dump or transaction log is unlikely to contain extractable information units. Evaluate whether the data represents reusable knowledge before creating wiki pages.
- Look for sheets or sections that contain definitions, rules, criteria, or structured descriptions — these may have extractable value.
- Summary sheets, dashboards, and header rows often reveal the purpose and context of the data.
- For CSV: check encoding (UTF-8 vs GBK/GB2312 for Chinese content). If the content appears garbled, try alternative encodings.

### Structured Data (json, yaml, yml)

Read directly and parse as structured data. These files often represent configurations, schemas, or data models.

- Evaluate whether the structure itself is the knowledge (e.g., an API schema, a configuration specification) or merely a container for text content.
- Extract metadata from known fields when applicable.

### Image Files (png, jpg, jpeg, webp)

The processing model supports vision and can directly read and understand image content. Use this capability to analyze images in context.

**Processing flow:**

1. **Read and understand**: Use vision to read the image. Understand what it depicts and how it relates to the surrounding context (if it came from a document, consider the text around it).
2. **Evaluate value**: Does this image carry information that adds to or complements a wiki page? Architecture diagrams, flowcharts, data visualizations, annotated screenshots, and conceptual illustrations typically do. Decorative images, logos, photos with no analytical value, and UI chrome do not.
3. **Skip or preserve**:
   - If the image has no extractable value, skip it.
   - If the image has value, save it using the CLI and reference it from the relevant wiki page.

**Saving and referencing images:**

Use the `tiangong-wiki asset` commands — do NOT manually copy files or construct paths.

```bash
# Step 1: Save the image (use a descriptive kebab-case name, not the original filename)
tiangong-wiki asset save /path/to/source-image.png --name education-platform-architecture
# Returns: { "assetPath": "assets/images/education-platform-architecture.png" }

# Step 2: When writing a page that references this image, get the relative path
tiangong-wiki asset ref education-platform-architecture.png --page methods/example.md
# Returns: { "relativePath": "../assets/images/education-platform-architecture.png", "assetPath": "..." }

# Step 3: Use the relativePath in markdown
# ![Education platform architecture](../assets/images/education-platform-architecture.png)
```

Important:
- Always use the `assetPath` returned by `asset save` — the filename may differ from `--name` if a duplicate existed (e.g., `education-platform-architecture-1.png`).
- The `--name` must be kebab-case (`[a-z0-9-]`), reflecting the image content, not the original filename.
- File size limit: 20MB.

**Text description is required:**

Images cannot be indexed or searched. Every image referenced in a wiki page MUST be accompanied by a textual description that captures the essential information the image conveys. The text is the knowledge; the image is supplementary illustration.

### Images Embedded in Documents

Documents (PDF, DOCX, PPTX) may contain embedded images (figures, diagrams, charts, screenshots).

1. **Read in context**: Use vision to understand each embedded image in the context of its surrounding text (captions, paragraphs, slide notes).
2. **Decide per image**: Not every embedded image is worth extracting. Apply the same value evaluation as standalone images.
3. **Extract the image file**:
   - **PDF**: Use the pdf parser skill — `pdfimages -j input.pdf output_prefix` extracts images to disk.
   - **PPTX**: Use the pptx parser skill — `python scripts/office/unpack.py presentation.pptx unpacked/` then find images in `unpacked/ppt/media/`.
   - **DOCX**: Use the docx parser skill — `python scripts/office/unpack.py document.docx unpacked/` then find images in `unpacked/word/media/`.
   - **No parser skill available**: If the parser skill is not installed and the image cannot be extracted to disk, do NOT attempt to save the image. Provide only a textual description in the wiki page.
4. **Save and reference**: Once the image file is on disk, use `tiangong-wiki asset save` and `tiangong-wiki asset ref` as described above.
5. **Ignore**: Decorative images, logos, repeated formatting elements, and watermarks should not be extracted.

## 3. Metadata Utilization

Many file formats carry metadata that can inform processing decisions:

| Metadata | Where Found | How to Use |
|---|---|---|
| Title | PDF, DOCX, PPTX properties | Inform page title and nodeId |
| Author | PDF, DOCX, PPTX properties | May indicate relevant `person` pages, inform provenance |
| Creation / modification date | Most formats | Inform `createdAt`, assess recency |
| Subject / keywords | PDF, DOCX properties | Inform tags and search during discovery |
| Slide count / page count | PDF, PPTX | Gauge document complexity, anticipate splitting needs |

Do not blindly copy metadata into wiki fields — use it as input to your decisions alongside the actual content.

## 4. Large and Complex Files

For files that are unusually large or complex:

- **Read incrementally**: Do not attempt to load the entire file into context at once. Process sections, chapters, or slides in batches.
- **Summarize structure first**: Before diving into details, understand the overall structure (table of contents, slide titles, sheet names) to plan which sections contain extractable information.
- **Prioritize**: Not every section of a long document is worth extracting. Focus on the sections with the highest reuse value.

## 5. Encoding and Format Issues

- **Encoding**: Chinese content may use GBK, GB2312, or Big5 encoding. If content appears garbled after reading, try alternative encodings before giving up.
- **Corrupted files**: If a file cannot be read or parsed after reasonable attempts, skip it with a clear reason in the result manifest. Do not guess at content.
- **Password-protected files**: Cannot be processed. Skip with a note.
- **Empty files**: Skip immediately — no content to extract.

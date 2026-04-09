# CLI Reference

All commands are invoked through a single entry point:

```bash
# Global install
tiangong-wiki <command> [options]

# npx
npx @biaoo/tiangong-wiki <command> [options]

# Development
npm run dev -- <command> [options]
```

---

## Command Overview

| Command | Description |
| --- | --- |
| `setup` | Interactive configuration wizard — writes `.wiki.env` and scaffolds workspace |
| `doctor` | Diagnose configuration, paths, embedding, and daemon health |
| `init` | Initialize workspace assets and run the first sync |
| `sync` | Incrementally sync pages, embeddings, and vault metadata |
| `check-config` | Validate environment variables, config, and templates |
| `find` | Query pages by structured metadata filters |
| `search` | Semantic search over page summary embeddings |
| `fts` | Full-text search over title, tags, and summary text |
| `graph` | Traverse the knowledge graph from a root node |
| `page-info` | Show full metadata and edges for a single page |
| `list` | List wiki pages |
| `stat` | Show aggregate index statistics |
| `create` | Create a new page from a registered template |
| `template` | List, show, or create wiki templates |
| `type` | Inspect and recommend page types |
| `vault` | Inspect vault files and changelog entries |
| `lint` | Validate pages, references, and graph integrity |
| `export-graph` | Export graph nodes and edges as JSON |
| `export-index` | Export a human-readable Markdown index |
| `daemon` | Manage the background HTTP daemon |
| `dashboard` | Open the web dashboard in a browser |

---

## Command Details

### setup

```
tiangong-wiki setup
```

Interactive step-by-step wizard that:

- Records `WIKI_PATH`, `VAULT_PATH`, `WIKI_DB_PATH`, `WIKI_CONFIG_PATH`, `WIKI_TEMPLATES_PATH`
- Optionally configures `EMBEDDING_*` and Synology vault settings
- Writes `.wiki.env` in the current working directory
- Scaffolds `wiki/pages/`, `vault/`, `wiki.config.json`, and `templates/`

After setup, run `tiangong-wiki doctor` then `tiangong-wiki init` to complete initialization.

### doctor

```
tiangong-wiki doctor [--probe] [--format text|json]
```

| Option | Description |
| --- | --- |
| `--probe` | Additionally test remote services (embedding endpoint, Synology NAS) |
| `--format` | Output format: `text` (default) or `json` |

Checks: `.wiki.env` loading, path existence, database accessibility, config validity, template completeness, embedding configuration, and daemon status. Exit code `2` on errors.

### init

```
tiangong-wiki init [--force]
```

| Option | Description |
| --- | --- |
| `--force` | Force a full rebuild of the index |

Creates `index.db` (if needed), builds tables according to `wiki.config.json` (including dynamic columns), and runs the first full sync.

### sync

```
tiangong-wiki sync [options]
```

| Option | Description |
| --- | --- |
| `--path <pagePath>` | Sync only a single page (page-only, no vault scan) |
| `--force` | Force a full rebuild (ignore content_hash) |
| `--skip-embedding` | Skip embedding generation |
| `--process` | Process vault queue items after sync |
| `--vault-file <fileId>` | Process only one vault queue item |

When `--path` is used, vault scanning is skipped. If a global config or embedding profile change is detected, `--path` automatically upgrades to a full sync.

### check-config

```
tiangong-wiki check-config [--probe] [--format text|json]
```

Validates environment variables, `wiki.config.json`, and template files. With `--probe`, also tests embedding API connectivity.

### find

```
tiangong-wiki find [options]
```

| Option | Description |
| --- | --- |
| `--type <pageType>` | Filter by page type |
| `--status <status>` | Filter by status |
| `--visibility <vis>` | Filter by visibility |
| `--tag <tag>` | Filter by tag |
| `--node-id <nodeId>` | Filter by node ID |
| `--updated-after <date>` | Filter by updatedAt >= date |
| `--sort <column>` | Sort column |
| `--limit <n>` | Max rows (default: 50) |

Supports custom columns declared in `wiki.config.json` as additional `--<column> <value>` filters.

Output: JSON array to stdout.

### search

```
tiangong-wiki search <query> [--type <pageType>] [--limit <n>]
```

Semantic similarity search. The query is embedded via the configured embedding API and matched against `vec_pages`. Requires `EMBEDDING_*` environment variables.

Output: JSON array with `similarity` scores.

### fts

```
tiangong-wiki fts <query> [--type <pageType>] [--limit <n>]
```

Full-text search against the `pages_fts` table (title, tags, summary_text). Default limit: 20.

### graph

```
tiangong-wiki graph <root> [options]
```

| Option | Description |
| --- | --- |
| `--depth <n>` | Traversal depth (default: 1) |
| `--edge-type <type>` | Filter by edge type |
| `--direction <dir>` | `outgoing`, `incoming`, or `both` (default: both) |

Returns `{ root, nodes[], edges[] }` as JSON.

### page-info

```
tiangong-wiki page-info <pageId>
```

Returns full indexed metadata for one page: all frontmatter fields, incoming/outgoing edges, embedding status, and content hash.

### list

```
tiangong-wiki list [--type <pageType>] [--sort <column>] [--limit <n>]
```

Compact listing with title, pageType, status, updatedAt, and filePath. Default sort: `updatedAt`, default limit: 50.

### stat

```
tiangong-wiki stat
```

Aggregate statistics: total pages, breakdown by type/status, total edges, orphan count, embedding status, vault file count, last sync time, and registered template count.

### create

```
tiangong-wiki create --type <pageType> --title <title> [--node-id <nodeId>]
```

Creates a page from the corresponding template in `wiki/templates/`, fills frontmatter fields (title, createdAt, updatedAt, etc.), writes to `wiki/pages/`, and immediately indexes it.

Output: `{ created, filePath }`.

### template

```
tiangong-wiki template list [--format text|json]
tiangong-wiki template show <pageType> [--format text|json]
tiangong-wiki template lint [pageType] [--level error|warning|info] [--format text|json]
tiangong-wiki template create --type <pageType> --title <title>
```

- `list` — Show registered templates
- `show` — Display template content for a specific type
- `lint` — Validate template frontmatter, schema declarations, summaryFields, and minimum body structure
- `create` — Generate a new template file in `wiki/templates/` and register it in `wiki.config.json`

### type

```
tiangong-wiki type list [--format text|json]
tiangong-wiki type show <pageType> [--format text|json]
tiangong-wiki type recommend [--text <text>] [--keywords <kw>] [--limit <n>] [--format text|json]
```

- `list` — List all registered page types with their columns, edges, and summary fields
- `show` — Show full schema for one type
- `recommend` — Suggest page types based on vector similarity against existing pages (requires embeddings)

### vault

```
tiangong-wiki vault list [--path <prefix>] [--ext <ext>]
tiangong-wiki vault diff [--since <date>] [--path <prefix>]
tiangong-wiki vault queue [--status pending|processing|done|skipped|error]
```

- `list` — List indexed vault files; `--path` does prefix matching on relative paths
- `diff` — Show changes since the last sync (or since a given date with `--since`)
- `queue` — Show processing queue status and item details

### lint

```
tiangong-wiki lint [--path <pagePath>] [--level error|warning|info] [--format text|json]
```

Validates all pages (or a single page with `--path`) for integrity issues at three severity levels:

- **error** — Missing required fields, unregistered pageType, broken references
- **warning** — Orphan pages, empty sourceRefs, stale active pages, references to archived pages
- **info** — Unregistered frontmatter fields, draft count, pending embeddings

### export-graph

```
tiangong-wiki export-graph [--output <filePath>]
```

Exports all graph nodes (pages with node IDs) and edges as JSON. Prints to stdout by default; `--output` writes to a file.

### export-index

```
tiangong-wiki export-index [--output <filePath>] [--group-by pageType|tags]
```

Generates a human-readable Markdown index of all pages. Default grouping: `pageType`.

### daemon

```
tiangong-wiki daemon run               # Foreground (for process managers)
tiangong-wiki daemon start             # Background (detached process)
tiangong-wiki daemon stop
tiangong-wiki daemon status [--format text|json]
```

The daemon provides a local HTTP server (binds to `127.0.0.1` only) for the web dashboard and accelerated query routing. When running, query commands automatically use HTTP instead of direct database access.

### dashboard

```
tiangong-wiki dashboard [--no-open] [--format text|json]
```

Opens the web dashboard in the default browser. Starts the daemon automatically if it is not already running. Use `--no-open` to print the URL without opening a browser.

---

## Output Conventions

### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Runtime error |
| `2` | Configuration error |

### Output Formats

| Type | Commands | Default Output | Machine-Readable Option |
| --- | --- | --- | --- |
| Query | find, search, fts, graph, page-info, list, stat, vault list/diff/queue | JSON to stdout | — (default is JSON) |
| Mutation | init, sync, create, template create | JSON to stdout | — (default is JSON) |
| Wizard | setup | Interactive text | — |
| Validation | lint | Human-readable text | `--format json` |
| Export | export-graph | JSON | — |
| Export | export-index | Markdown | — |
| Info | doctor, check-config, template list/show, type list/show/recommend, daemon status, dashboard | Human-readable text | `--format json` |

### Error Output

Runtime and configuration errors are written to stderr as JSON:

```json
{ "error": "...", "type": "config | runtime | not_found | not_configured" }
```

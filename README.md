# @biaoo/wiki

[中文](./README.zh-CN.md)

An implementation of the [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern — instead of re-deriving answers from raw documents every time (like RAG), the LLM **incrementally builds and maintains a persistent wiki**: a structured, interlinked collection of Markdown pages that compounds over time. You add sources, ask questions, and explore; the AI does the summarizing, cross-referencing, and bookkeeping.

`@biaoo/wiki` provides the infrastructure for this pattern: a CLI and indexing engine that turns a directory of Markdown files into a queryable knowledge base with full-text search, semantic search, and a knowledge graph.

## Features

- **Knowledge that compounds** — every source you add and every question you ask makes the wiki richer; knowledge is compiled once and kept current, not re-derived on every query
- **Your files, your data** — plain Markdown pages you own and control; no cloud, no database server, no vendor lock-in
- **Find anything** — search by metadata, keywords, or natural language meaning across your entire knowledge base
- **See connections** — automatically maps relationships between pages into a navigable knowledge graph
- **Ingest raw materials** — drop PDFs, docs, and notes into a vault; AI reads and converts them into structured wiki pages
- **AI agents included** — ships as a [Codex / Claude Code skill](./SKILL.md) so agents can query, create, and maintain knowledge on your behalf
- **Visual dashboard** — explore your knowledge graph, browse pages, and search from an interactive web interface

## Install

```bash
npm install -g @biaoo/wiki
```

Requires Node.js >= 18.

### Use as an AI Agent Skill

`@biaoo/wiki` also ships as an [Agent Skill](./SKILL.md) for Codex and Claude Code. After installing the npm package, register it with your agent:

```bash
# Codex
npx skills add Biaoo/wiki -a codex

# Claude Code
npx skills add Biaoo/wiki -a claude-code

# Global install (available across all projects)
npx skills add Biaoo/wiki -a codex -g
```

Or use the built-in setup wizard which handles both npm install and skill registration:

```bash
wiki setup
```

## Quick Start

`wiki setup` will interactively create a `.wiki.env` file with all required environment variables (`WIKI_PATH`, `VAULT_PATH`, embedding config, etc.). See [references/env.md](./references/env.md) for the full variable reference.

```bash
# Interactive setup wizard — creates .wiki.env config and initializes workspace
wiki setup

# Verify configuration
wiki doctor

# Initialize workspace (create directories, config, templates)
wiki init

# Index your Markdown pages
wiki sync

# Query
wiki find --type concept --status active
wiki fts "Bayesian"
wiki search "convergence conditions"    # requires embedding config
wiki graph bayes-theorem --depth 2
```

## Daemon

The daemon provides a local HTTP server for the web dashboard and faster query responses. It listens on `127.0.0.1` only.

```bash
# Foreground (recommended for process managers like pm2, launchd, systemd)
wiki daemon run

# Background (convenience wrapper, spawns a detached process)
wiki daemon start

# Check status / stop
wiki daemon status
wiki daemon stop
```

When the daemon is running, query commands (`find`, `fts`, `search`, `graph`, etc.) automatically route through HTTP for better performance. If the daemon is unavailable, they fall back to direct local execution.

## CLI Overview

```
Setup         setup · doctor · check-config
Indexing      init · sync
Query         find · fts · search · graph
Inspect       list · page-info · stat · lint
Create        create · template · type
Vault         vault list|diff|queue
Export        export-graph · export-index
Daemon        daemon run|start|stop|status
Dashboard     dashboard
```

Run `wiki --help` or `wiki <command> --help` for usage. See [references/cli-interface.md](./references/cli-interface.md) for the full command reference.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Vault (raw input)                     │
│           PDFs, docs, notes, bookmarks, clippings         │
└────────────────────────┬─────────────────────────────────┘
                         │ vault diff / vault queue
                         ▼
┌──────────────────────────────────────────────────────────┐
│              Agentic Workflow (Codex SDK)                 │
│                                                          │
│  ┌─────────┐  read    ┌────────────┐  discover  ┌─────┐ │
│  │ Parser  │ ──────►  │ wiki-skill │ ────────►  │ LLM │ │
│  │ Skills  │  source  │ find / fts │  + decide  │     │ │
│  └─────────┘          └────────────┘            └─────┘ │
│  pdf · docx · pptx                                       │
│                                                          │
│  → skip / create page / update page / propose only       │
└────────────────────────┬─────────────────────────────────┘
                         │ write pages
                         ▼
┌──────────────────────────────────────────────────────────┐
│                    Markdown Pages (SSOT)                  │
│                    wiki/pages/**/*.md                     │
└────────────────────────┬─────────────────────────────────┘
                         │ wiki sync — parse frontmatter
                         ▼
┌──────────────────────────────────────────────────────────┐
│                   SQLite Index (index.db)                 │
│                                                          │
│  pages          structured metadata (dynamic columns)    │
│  pages_fts      FTS5 full-text search                    │
│  vec_pages      sqlite-vec vector embeddings             │
│  edges          knowledge graph (source → target)        │
└──┬───────────┬───────────┬───────────┬───────────────────┘
   │           │           │           │
   ▼           ▼           ▼           ▼
  find        fts       search       graph
(metadata)  (keyword)  (semantic)  (traversal)
   │           │           │           │
   └───────────┴───────────┴───────────┘
                     │
                     ▼
          JSON stdout / HTTP daemon
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   CLI / Scripts            Web Dashboard
                         (Preact + G6 graph)
```

**Vault → Pages pipeline** — Raw materials (PDFs, documents, notes) land in the vault. An agentic workflow powered by Codex SDK reads each file, discovers the current ontology via `wiki type list / find / fts`, and decides whether to skip, create a new page, or update an existing one. The result is structured Markdown pages in `wiki/pages/`.

**Dual-engine design** — Markdown pages are the single source of truth that humans and AI agents read and write directly. The SQLite database is a derived index rebuilt by `wiki sync`, providing structured queries, full-text search, vector similarity, and graph traversal that plain files cannot offer.

**Three-tier column model** — Page metadata uses a flexible column system: fixed columns (hardcoded schema), deploy columns (`wiki.config.json` custom fields applied globally), and template columns (per-pageType fields). Schema changes are handled automatically via `ALTER TABLE` — no manual migrations.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (ESM) |
| Runtime | Node.js >= 18 |
| CLI | [Commander.js](https://github.com/tj/commander.js) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Vector search | [sqlite-vec](https://github.com/asg017/sqlite-vec) |
| Dashboard | [Preact](https://preactjs.com/) + [G6](https://g6.antv.antgroup.com/) |
| Build | [Vite](https://vite.dev/) |
| Test | [Vitest](https://vitest.dev/) |

## Development

```bash
git clone https://github.com/Biaoo/wiki.git
cd wiki
npm install
npm run build

# Run CLI from source
npm run dev -- --help

# Run dashboard dev server
npm run dev:dashboard

# Run tests
npm test
```

## License

[MIT](./LICENSE)

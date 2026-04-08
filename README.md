# @biaoo/wiki

[中文](./README.zh-CN.md)

> Inspired by Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — instead of re-deriving answers from raw documents on every query (like RAG), the LLM **builds and maintains a persistent wiki** that compounds over time.

`@biaoo/wiki` is the infrastructure for this pattern: a CLI that turns a directory of Markdown files into a queryable knowledge base with full-text search, semantic search, knowledge graph, and an interactive dashboard.

## Features

| | |
|---|---|
| **Knowledge that compounds** | Every source and every question makes the wiki richer — compiled once, kept current |
| **Your files, your data** | Plain Markdown you own; no cloud, no database server, no lock-in |
| **Find anything** | Metadata filters, keyword search, and semantic search in one CLI |
| **See connections** | Relationships auto-extracted into a navigable knowledge graph |
| **Ingest raw materials** | Drop files into a vault; AI reads and converts them to structured pages |
| **AI-agent native** | Ships as a [Codex / Claude Code skill](./SKILL.md) for autonomous knowledge work |
| **Visual dashboard** | Browse the graph, inspect pages, and search from a web UI |

## Install

```bash
npm install -g @biaoo/wiki
```

<details>
<summary><strong>Use as an AI Agent Skill</strong></summary>

After installing the npm package, register it with your agent:

```bash
npx skills add Biaoo/wiki -a codex          # Codex
npx skills add Biaoo/wiki -a claude-code    # Claude Code
npx skills add Biaoo/wiki -a codex -g       # Global (cross-project)
```

Or let the setup wizard handle everything:

```bash
wiki setup
```

</details>

## Quick Start

```bash
wiki setup                                   # interactive config wizard
wiki doctor                                  # verify configuration
wiki init                                    # initialize workspace
wiki sync                                    # index Markdown pages
```

```bash
wiki find --type concept --status active     # structured query
wiki fts "Bayesian"                          # full-text search
wiki search "convergence conditions"         # semantic search
wiki graph bayes-theorem --depth 2           # graph traversal
```

```bash
wiki daemon run                              # start dashboard & HTTP API
wiki dashboard                               # open dashboard in browser
```

> Environment variables are managed via `.wiki.env` (created by `wiki setup`). See [references/env.md](./references/env.md) for the full reference.

## CLI

```
Setup         setup · doctor · check-config
Indexing      init · sync
Query         find · fts · search · graph
Inspect       list · page-info · stat · lint
Create        create · template · type
Vault         vault list | diff | queue
Export        export-graph · export-index
Daemon        daemon run | start | stop | status
Dashboard     dashboard
```

See [references/cli-interface.md](./references/cli-interface.md) for the full command reference.

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
                         │ wiki sync
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
   │           │           │           │
   └───────────┴───────────┴───────────┘
                     │
                     ▼
          JSON stdout / HTTP daemon
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   CLI / Scripts            Web Dashboard
```

**Vault → Pages** — Raw materials land in the vault. An agentic workflow reads each file, discovers the current ontology via `wiki type list / find / fts`, and decides whether to skip, create, or update a page.

**Dual engine** — Markdown files are the source of truth. SQLite is a derived index rebuilt by `wiki sync`, enabling queries that plain files cannot support.

**Flexible schema** — Three-tier column model (fixed, deploy-level, template-level) with automatic `ALTER TABLE` on config changes.

## Tech Stack

| | |
|---|---|
| Language | TypeScript (ESM) |
| Runtime | Node.js >= 18 |
| CLI | [Commander.js](https://github.com/tj/commander.js) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [sqlite-vec](https://github.com/asg017/sqlite-vec) |
| Dashboard | [Preact](https://preactjs.com/) + [G6](https://g6.antv.antgroup.com/) |
| Build | [Vite](https://vite.dev/) |
| Test | [Vitest](https://vitest.dev/) |

## Development

```bash
git clone https://github.com/Biaoo/wiki.git
cd wiki
npm install && npm run build

npm run dev -- --help        # CLI from source
npm run dev:dashboard        # dashboard dev server
npm test                     # run tests
```

## Contributing

Issues and pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

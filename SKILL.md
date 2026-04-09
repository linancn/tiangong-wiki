---
name: tiangong-wiki-skill
description: "Local-first wiki query and page-maintenance interface over Markdown knowledge pages indexed into SQLite. Use when an agent should discover existing knowledge before answering, inspect vault changes or queue state, choose how new durable knowledge fits the current ontology, or create/update wiki pages in a local knowledge workspace."
---

# Wiki Skill

## Core Goal
- Use the local wiki as the durable knowledge layer for future work, not just the current conversation.
- Query SQLite first, then read or edit the Markdown files that remain the source of truth.
- Treat page types as runtime-discovered ontology. Do not hardcode a default destination for new knowledge.

## Use When
Use `tiangong-wiki-skill` when:
- You should check whether the answer already exists in the local wiki before writing a fresh answer.
- You need to inspect the current ontology, template structure, or type recommendations before creating a page.
- A durable insight, correction, workflow, lesson, or source-derived knowledge should be preserved for reuse.
- New files appeared in `vault/` and you need to inspect `vault diff` or `vault queue` before deciding what knowledge work to do.
- You need a structured view of the graph, stale content, orphan pages, provenance, or general workspace health.
- You need to create or update a page and immediately re-index it.

## Retrieval Strategy
- Exact metadata, type, tag, status, node id, or dynamic column filter: `tiangong-wiki find`
- Keyword or short literal clue: `tiangong-wiki fts`
- Fuzzy natural-language retrieval with embeddings configured: `tiangong-wiki search`
- Graph neighborhood, prerequisites, or multi-hop relations: `tiangong-wiki graph`
- Single-page metadata, edges, provenance, or file path: `tiangong-wiki page-info`
- Workspace inventory or health: `tiangong-wiki list`, `tiangong-wiki stat`, `tiangong-wiki lint`
- Ontology discovery: `tiangong-wiki type list`, `tiangong-wiki type show`, `tiangong-wiki type recommend`
- Vault ingestion status: `tiangong-wiki vault diff`, `tiangong-wiki vault list`, `tiangong-wiki vault queue`

## Knowledge Capture Workflow
Use this when new knowledge should become part of the wiki.

1. Query for close existing pages with `tiangong-wiki find`, `tiangong-wiki fts`, or `tiangong-wiki search`.
2. Discover the current ontology with:
   - `tiangong-wiki type list --format json`
   - `tiangong-wiki type show <type> --format json`
   - `tiangong-wiki type recommend --text "<summary>" --keywords "a,b,c" --format json`
3. Update the best existing page when the knowledge object already exists.
4. Create a new page only when the knowledge object is distinct and the current ontology supports it cleanly.
5. Edit the Markdown file directly.
6. Run `tiangong-wiki sync --path <page-id>`.
7. Run `tiangong-wiki lint --path <page-id> --format json`.

```bash
tiangong-wiki find --type method --tag evidence
tiangong-wiki type list --format json
tiangong-wiki type recommend --text "A repeatable workflow for evidence review" --keywords "workflow,procedure" --limit 5 --format json
tiangong-wiki create --type method --title "Evidence Review Workflow"
tiangong-wiki sync --path methods/evidence-review-workflow.md
tiangong-wiki lint --path methods/evidence-review-workflow.md --format json
```

## Vault Review Workflow
Use this when `vault/` may contain source files that should influence wiki knowledge.

1. Run `tiangong-wiki sync` to refresh indexes, vault metadata, and queue state.
2. Inspect recent vault changes with `tiangong-wiki vault diff`.
3. Inspect queue state with `tiangong-wiki vault queue`.
4. Discover the ontology through `tiangong-wiki type list/show/recommend` before deciding what to create or update.
5. Preserve provenance with `sourceRefs` and any source-specific fields required by the chosen page type.
6. Remember that `source-summary` is only one possible type. A vault file may lead to `skip`, an update to an existing page, a new page of any registered type, or a proposal to evolve the ontology.

```bash
tiangong-wiki sync
tiangong-wiki vault diff
tiangong-wiki vault queue
tiangong-wiki type list --format json
tiangong-wiki type recommend --text "Operational brief about evidence review" --keywords "operations,evidence" --limit 5 --format json
tiangong-wiki find --type method --tag evidence
```

## Maintenance Rules
- Do not assume any single page type is the default landing zone for vault files.
- Prefer updating the best existing page before creating near-duplicates.
- Use CLI discovery instead of static assumptions about templates or registered types.
- If the current ontology is not a clean fit, consider template evolution deliberately; do not improvise undocumented structure.
- After every mutation, re-index and lint the changed page before trusting query results.

## Layer Boundary
- `SKILL.md` describes the on-demand skill interface used by agents during queries and manual knowledge maintenance.
- Automatic vault-to-wiki processing, daemon scheduling, queue retries, NAS polling, and workflow artifacts belong to the service layer.
- Service-layer operations are documented in `references/service-admin.md`.

## Environment Contract
Required:
- `WIKI_PATH`

Optional for semantic retrieval or vector-based type recommendation:
- `EMBEDDING_BASE_URL`
- `EMBEDDING_API_KEY`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSIONS`

Automatic vault processing uses additional `WIKI_AGENT_*` variables, but those belong to the service layer rather than the skill interface. Read `references/service-admin.md` when operating the daemon or queue worker.

## Output Contract
- Query commands return JSON to stdout.
- Mutating commands return JSON summaries or created file paths to stdout.
- `lint`, `check-config`, `template list/show`, `type list/show/recommend`, and `daemon status` support text or JSON output where documented.
- Errors are emitted as structured JSON to stderr with `type=config|runtime|not_found|not_configured`.

## References
- `references/cli-interface.md`
- `references/data-model.md`
- `references/template-design-guide.md`
- `references/runtime.md`
- `references/env.md`
- `references/wiki-maintenance-instruction.md`
- `references/vault-to-wiki-instruction.md`
- `references/vault-file-processing.md`
- `references/service-admin.md`

## Assets
- `assets/wiki.config.default.json`
- `assets/templates/`

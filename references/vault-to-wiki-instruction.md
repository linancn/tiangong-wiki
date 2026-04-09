# Vault To Wiki Instruction

Use this instruction when a vault queue item must be processed into durable wiki knowledge.

## Goal

Turn one vault file into the smallest correct wiki knowledge update.

The output may be:

- no wiki change (`skip`)
- one or more page updates (`apply`)
- a type/template proposal without page writes (`propose_only`)

Do not assume any page type is the default destination.

## Core Rules

1. Discover the current ontology through the wiki CLI before deciding what to write.
2. Search for relevant existing pages before creating new ones.
3. Treat all page types equally. Choose the best fit from the current wiki, not a hardcoded fallback.
4. Skip transient, duplicate, or low-value files.
5. Preserve provenance with `sourceRefs` and any type-specific source fields already defined by the chosen template.
6. `sourceRefs` may only contain existing wiki page ids. Do not put raw vault file paths there; keep raw file provenance in the page body or a dedicated source field such as `vaultPath` when the chosen type supports it.
7. Only write type-specific frontmatter fields that are declared by the chosen type in `tiangong-wiki type show <type>` or the template file. Do not invent ad-hoc fields.
8. If the existing type system cannot represent the knowledge cleanly, prefer `propose_only` unless template evolution is explicitly allowed.

## Runtime Discovery

Use the CLI as the source of truth for the current ontology and page set.

Prefer:

- `tiangong-wiki type list --format json`
- `tiangong-wiki type show <type> --format json`
- `tiangong-wiki type recommend --text "<summary>" --keywords "a,b,c" --limit 5 --format json`
- `tiangong-wiki find`
- `tiangong-wiki fts`
- `tiangong-wiki page-info`

Notes:

- Do not use guessed subcommands such as `tiangong-wiki page find`.
- `tiangong-wiki find` and `tiangong-wiki list` already emit JSON; do not append `--format json`.

Do not rely on static prompt snapshots of types, templates, or pages.

## Decision Model

Choose exactly one decision:

- `skip`
  The file is noise, duplicate, transient, unreadable, or already fully represented.

- `apply`
  The file adds durable knowledge and you can express it with existing page types.

- `propose_only`
  The file has durable value, but the current type system is not a clean fit and automatic template evolution is not allowed.

## Value Heuristics

Favors `apply`:

- durable documents with reusable knowledge
- files that materially strengthen or revise an existing page
- sources that introduce a clearly distinct knowledge object worth revisiting

Favors `skip`:

- temporary exports, dumps, or duplicates
- opaque binaries with no useful extractable content
- screenshots or images with no standalone evidence value
- files whose substance is already covered by current pages

Favors `propose_only`:

- the file is valuable
- existing types are clearly awkward or lossy
- creating a new type would materially improve ontology quality

## Page Update Rules

When applying changes:

1. Prefer updating an existing page if the source is a revision, appendix, or direct reinforcement of that page.
2. Create a new page only when the knowledge object is distinct and deserves its own identity.
3. Keep edits minimal, specific, and provenance-preserving.
4. For every changed page, run:
   - `tiangong-wiki sync --path <page>`
   - `tiangong-wiki lint --path <page> --format json`

## Manifest Contract

The workflow must write a valid `result.json` manifest.

Minimum expectations:

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

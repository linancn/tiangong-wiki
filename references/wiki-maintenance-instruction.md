# Wiki Maintenance Instruction

Use this instruction when the agent is responsible for maintaining wiki knowledge pages, not only querying them.

The deterministic layer is the CLI and SQLite index.
The judgment layer is the agent: deciding whether knowledge is durable, which page type fits, and whether an existing page should be updated instead of creating a duplicate.

## Maintenance Goals
- Keep the wiki useful for future tasks, not bloated with one-off chatter.
- Prefer updating the best existing page before creating near-duplicates.
- Preserve provenance with `sourceRefs` and graph relations with `relatedPages` or page-type edge fields.
- Re-index every edited page immediately.

## Daily Maintenance Loop
1. Run `wiki sync`.
2. Run `wiki stat`.
3. Run `wiki lint`.
4. Review `error` findings first.
5. Review `warning` findings that indicate stale, orphaned, or weakly connected knowledge.
6. Use `wiki find`, `wiki fts`, `wiki search`, or `wiki graph` to locate the best target page.
7. Edit Markdown in `wiki/pages/`.
8. Run `wiki sync --path <page-id>`.
9. Re-run `wiki lint --path <page-id>` when the change is localized.

## PageType Selection Table
| pageType | Use When | Typical Trigger | Notes |
| --- | --- | --- | --- |
| `concept` | A stable concept, model, or principle should be reusable later | New synthesis from multiple sources | Best for durable understanding |
| `misconception` | A wrong mental model was corrected | User or agent had a clear before/after correction | Record the failure mode and prevention cues |
| `bridge` | Knowledge transfers from one domain to another | Cross-project or cross-discipline analogy | Use when the value is the transfer itself |
| `source-summary` | The source itself deserves a reusable digest page | A source document should remain a first-class knowledge object | Preserve `vaultPath` and `sourceType`; this is not the default destination for every vault file |
| `lesson` | A specific incident produced a durable lesson | Failure, success, or surprise with actionable aftermath | Keep the event and future action linked |
| `method` | A repeatable process or recipe proved useful | Same process worked more than once | Capture applicability and evidence |
| `person` | Someone's role, preferences, or influence matters again later | Recurring collaborator or decision-maker | Keep factual and context-specific |
| `achievement` | A milestone, credential, or verifiable result matters | Award, publication, certification, milestone | Useful for profile and reporting reuse |
| `resume` | A reusable positioning page is needed for different audiences | Tailored summary for applications or intros | Keep it current and audience-aware |
| `research-note` | Investigation is ongoing and incomplete | Exploratory work with open questions | Prefer this over `concept` when not settled yet |
| `faq` | The same question recurs often | Third repeat or clear repeating pattern | Optimize for rapid reuse |

## Update Vs Create Decision Flow
1. Start with a retrieval pass.
2. If you know the target page type or node id, use `wiki find`.
3. If you only know a phrase, use `wiki fts`.
4. If the intent is fuzzy and embeddings are available, use `wiki search`.
5. Inspect the top candidate with `wiki page-info`.
6. When creating something new, inspect the ontology with `wiki type list`, `wiki type show`, or `wiki type recommend`.
7. Update the existing page when one of these is true:
   - The new material extends the same node or page intent.
   - The existing page already answers at least 70% of the need.
   - The new source mainly adds evidence, examples, or corrections.
8. Create a new page when one of these is true:
   - The new knowledge has a distinct node id or clear separate title.
   - The value is a new relation type, such as a new `bridge` or `misconception`.
   - Updating the old page would mix two independent concepts.

## Create Workflow
1. Confirm no suitable active page exists.
2. Choose the page type from the table above.
3. Run `wiki create --type <pageType> --title "<title>" [--node-id <nodeId>]`.
4. Open the created Markdown file and fill the frontmatter-specific fields.
5. Fill every body section in the template with concrete content, not placeholders.
6. Add `sourceRefs` and `relatedPages` where appropriate.
7. Run `wiki sync --path <page-id>`.
8. Run `wiki lint --path <page-id> --format json`.

## Update Workflow
1. Find the existing page.
2. Edit the Markdown file directly.
3. Update `updatedAt`.
4. Add or revise `sourceRefs`.
5. Add or revise `relatedPages` and page-type relation fields such as `prerequisites` or `correctedConcepts`.
6. Preserve existing durable content unless it is wrong or superseded.
7. Run `wiki sync --path <page-id>`.
8. Run `wiki lint --path <page-id>`.

## Archive Decision Rules
Archive by setting `status: archived` when at least one of these is true:
- The page has not been updated for more than 6 months and has no incoming links.
- A newer page fully supersedes it and the old one only remains for traceability.
- The project, context, or relationship it described has clearly ended and no longer transfers.

Do not delete archived pages just because they are old.
Archived pages remain valuable as provenance or historical context.

## Do Not Create A Wiki Page When
- The task is a one-off fact lookup with no likely future reuse.
- The note is only a transient debugging scratchpad or temporary execution log.
- The content is still too vague to classify and belongs in a short-lived working draft elsewhere.

## Query Command Selection During Maintenance
- Exact metadata filter: `wiki find`
- Keyword hunt: `wiki fts`
- Fuzzy intent: `wiki search`
- One page inspection: `wiki page-info`
- Network exploration: `wiki graph`
- Workspace overview: `wiki stat`

## Graph-Driven Exploration
Use graph traversal when you suspect there is existing context around a concept but a simple keyword search is too shallow.

Typical uses:
- Discover prerequisites before expanding a concept page.
- Find bridge pages that connect two contexts.
- Detect whether a new page would be orphaned.
- Inspect whether a correction should point to an existing concept through `correctedConcepts`.

Example flow:
```text
1. wiki graph bayesian-theorem --depth 2
2. Inspect prerequisite and bridge edges
3. If a required prerequisite page is missing, create or update it
4. If the new concept overlaps an existing subgraph, update the connected page instead of making an isolated duplicate
```

## Page-Type Specific Guidance
### concept
- Use for durable understanding, definitions, formulas, and reusable intuition.
- Fill prerequisites, examples, confusions, and open questions.

### misconception
- Use when the key value is the correction itself.
- Record the original wrong model, the turning point, and how to avoid relapse.

### bridge
- Use when the key value is transfer between source and target contexts.
- Keep `fromConcepts` and `toConcepts` accurate so graph traversal remains useful.

### source-summary
- Use when the source file itself should remain a reusable knowledge object with explicit provenance.
- Do not treat this as the automatic fallback for every vault file.
- Capture the relationship between the source and existing concept pages.

### lesson
- Use when a concrete event produced a durable rule or warning.
- Prefer `lesson` over `method` when the story of the event matters.

### method
- Use when steps, applicability, and evidence matter more than one incident.
- Update the page as new usage records accumulate.

### person
- Use factual, respectful, context-aware notes.
- Avoid speculative or irrelevant personal data.

### achievement
- Keep evidence and issuer information explicit.
- Reuse this page later from `resume` or reporting workflows.

### resume
- Keep audience and tailoring notes current.
- Update after new achievements, projects, or capability changes.

### research-note
- Prefer this when the work is ongoing and open-ended.
- Promote mature insights into `concept` or `method` pages later if needed.

### faq
- Optimize for fast reuse.
- Keep the short answer crisp, then elaborate underneath.

## Memory To Wiki
Use this flow when recurring memory entries have become reusable knowledge:

```text
1. Review the memory entry
2. Ask: is this still valuable after the current day or week?
3. wiki find --type concept --node-id <candidate-node>
4. If a page exists, update it
5. If not, create the appropriate concept, lesson, method, or faq page
6. wiki sync --path <page-id>
```

## Profile To Wiki
Use this flow when structured profile data should appear in wiki pages:

```text
1. Read the relevant profile data
2. Decide whether it belongs in achievement, resume, or person pages
3. Update frontmatter and body content with verifiable details
4. Preserve provenance through sourceRefs when appropriate
5. wiki sync --path <page-id>
```

## Quality Checklist Before Finishing
- Page type matches the actual reuse pattern.
- `updatedAt` changed if the page changed.
- `sourceRefs` is non-empty when knowledge came from sources.
- Graph-related fields are populated where relevant.
- The page is not an accidental orphan unless that is intentional.
- `wiki lint` returns no errors for the changed page.

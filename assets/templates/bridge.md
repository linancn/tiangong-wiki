---
pageType: bridge
title: Bridge Title
nodeId: bridge-slug
status: draft
visibility: private
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
fromCourse:
toCourse:
transferType:
fromConcepts: []
toConcepts: []
---

## Source Knowledge

Identify the origin domain, course, or knowledge system. Link to existing concept or method pages that represent the source-side knowledge being transferred. When a source-side concept already has a node in the wiki, record its nodeId in frontmatter `fromConcepts` instead of leaving the mapping only in prose.

## Target Scenario

Describe the target problem, domain, or context where the source knowledge is being applied. State the constraints and requirements specific to the target that make direct transfer non-trivial.

## Transfer Mapping

Describe how each source-side concept or method maps to its target-side equivalent. Use explicit A → B mappings where possible. For each mapping, note what adapts cleanly and what requires modification. Use the body to explain the mapping, and keep `fromConcepts` / `toConcepts` in sync for the key nodes so the graph retains the structure.

## Invalid Transfers

State the conditions under which this bridge breaks down. Which assumptions from the source domain do not hold in the target? What would go wrong if the transfer were applied without these caveats?

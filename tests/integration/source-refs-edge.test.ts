import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  runCliJson,
  writePage,
  writeVaultFile,
} from "../helpers.js";

describe("sourceRefs edge derivation", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("creates sourced_from edges only for wiki page references, not vault markdown paths", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writeVaultFile(workspace, "reports/q1-summary.md", "# Q1\n\nA markdown file stored in vault.");

    writePage(
      workspace,
      "concepts/evidence-tracking.md",
      `---
pageType: concept
title: Evidence Tracking
nodeId: evidence-tracking
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - evidence
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Evidence tracking keeps claims linked to durable supporting material.
`,
    );

    writePage(
      workspace,
      "source-summaries/q1-summary.md",
      `---
pageType: source-summary
title: Q1 Summary
nodeId: q1-summary
status: active
visibility: private
sourceRefs:
  - concepts/evidence-tracking.md
  - vault/reports/q1-summary.md
relatedPages: []
tags:
  - quarter
createdAt: 2026-04-06
updatedAt: 2026-04-06
sourceType: md
vaultPath: reports/q1-summary.md
keyFindings:
  - Keep evidence links current
---

## 来源信息

Q1 summary is a durable internal note.

## 核心内容

It connects evidence tracking to quarterly review habits.

## 关键结论

- Keep evidence links current.

## 与已有知识的关系

This summary should point back to the concept page.

## 重要引用

"Keep evidence with the claim."
`,
    );

    runCliJson<{ inserted: number }>(["sync"], workspace.env);

    const pageInfo = runCliJson<{
      outgoingEdges: Array<{ edgeType: string; target: string }>;
    }>(["page-info", "source-summaries/q1-summary.md"], workspace.env);

    expect(pageInfo.outgoingEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: "sourced_from",
          target: "concepts/evidence-tracking.md",
        }),
      ]),
    );
    expect(
      pageInfo.outgoingEdges.filter((edge) => edge.edgeType === "sourced_from"),
    ).toHaveLength(1);
    expect(pageInfo.outgoingEdges.some((edge) => edge.target.startsWith("vault/"))).toBe(false);
  });
});

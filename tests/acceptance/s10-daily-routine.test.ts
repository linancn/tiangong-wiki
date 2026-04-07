import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  readFile,
  runCli,
  runCliJson,
  writePage,
  writeVaultFile,
} from "../helpers.js";

describe("acceptance: S10 daily routine", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("supports a full maintenance routine from sync through lint and export without corrupting vault diff", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    for (let index = 1; index <= 20; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const updatedAt = index === 20 ? "2025-01-01" : "2026-04-06";
      writePage(
        workspace,
        `concepts/routine-${suffix}.md`,
        `---
pageType: concept
title: Routine ${suffix}
nodeId: routine-${suffix}
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - routine
createdAt: 2026-04-06
updatedAt: ${updatedAt}
confidence: high
masteryLevel: medium
prerequisites: []
---

Routine page ${suffix} supports a daily maintenance workflow.
`,
      );
    }

    writeVaultFile(workspace, "imports/new-paper.pdf", "New paper about Bayesian product decisions.");
    writeVaultFile(workspace, "imports/new-notes.md", "# Notes\n\nFresh meeting notes.");

    const sync = runCliJson<{ vault: { changes: number } }>(["sync"], workspace.env);
    expect(sync.vault.changes).toBeGreaterThanOrEqual(2);

    const statBefore = runCliJson<{ totalPages: number; byType: Record<string, number> }>(
      ["stat"],
      workspace.env,
    );
    expect(statBefore.totalPages).toBe(20);
    expect(statBefore.byType.concept).toBe(20);

    const diffBefore = runCliJson<{ totalChanges: number; changes: Array<{ fileId: string }> }>(
      ["vault", "diff"],
      workspace.env,
    );
    expect(diffBefore.totalChanges).toBe(2);
    expect(diffBefore.changes.map((item) => item.fileId).sort()).toEqual([
      "imports/new-notes.md",
      "imports/new-paper.pdf",
    ]);

    const vaultList = runCliJson<Array<{ id: string }>>(
      ["vault", "list", "--path", "imports/"],
      workspace.env,
    );
    expect(vaultList).toHaveLength(2);

    const created = runCliJson<{ created: string }>(
      ["create", "--type", "source-summary", "--title", "新导入的论文"],
      workspace.env,
    );
    writePage(
      workspace,
      created.created,
      `---
pageType: source-summary
title: 新导入的论文
nodeId: imported-paper
status: active
visibility: private
sourceRefs:
  - vault/imports/new-paper.pdf
relatedPages:
  - concepts/routine-01.md
tags:
  - imports
createdAt: 2026-04-06
updatedAt: 2026-04-06
sourceType: pdf
vaultPath: imports/new-paper.pdf
keyFindings:
  - Fresh paper summarized
---

## 来源信息

这是一份新导入论文的摘要页面。

## 核心内容

论文强调用证据驱动产品决策。

## 关键结论

- Fresh paper summarized

## 与已有知识的关系

它可以支持 routine-01 这类概念沉淀。

## 重要引用

Bayesian product decisions.
`,
    );

    runCliJson(["sync", "--path", created.created], workspace.env);

    const lint = runCliJson<{
      errors: Array<unknown>;
      warnings: Array<{ check: string }>;
    }>(["lint", "--format", "json"], workspace.env);
    expect(lint.errors).toHaveLength(0);
    expect(lint.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "stale_page" })]),
    );

    const exportPath = `${workspace.wikiRoot}/index.md`;
    runCli(["export-index", "--output", exportPath], workspace.env);
    const exported = readFile(exportPath);
    expect(exported).toContain("# Wiki Index");
    expect(exported).toContain("Routine 01");
    expect(exported).toContain("新导入的论文");

    const diffAfter = runCliJson<{ totalChanges: number }>(["vault", "diff"], workspace.env);
    expect(diffAfter.totalChanges).toBe(2);

    const statAfter = runCliJson<{ totalPages: number; byType: Record<string, number> }>(
      ["stat"],
      workspace.env,
    );
    expect(statAfter.totalPages).toBe(21);
    expect(statAfter.byType["source-summary"]).toBe(1);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  runCliJson,
  writePage,
  writeVaultFile,
} from "../helpers.js";

describe("acceptance: S7 lint validation", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("reports missing vault refs, missing page refs, and orphan pages", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writeVaultFile(workspace, "reports/q1-summary.pdf", "Quarterly summary");
    writePage(
      workspace,
      "source-summaries/a.md",
      `---
pageType: source-summary
title: Summary A
nodeId: summary-a
status: active
visibility: private
sourceRefs:
  - vault/reports/q1-summary.pdf
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
sourceType: pdf
vaultPath: reports/q1-summary.pdf
keyFindings:
  - Reference should break later
---

## 来源信息

Summary A points at a vault file that will be deleted.
`,
    );
    writePage(
      workspace,
      "concepts/b.md",
      `---
pageType: concept
title: Concept B
nodeId: concept-b
status: active
visibility: shared
sourceRefs: []
relatedPages:
  - concepts/nonexistent.md
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Concept B has a missing related page.
`,
    );
    writePage(
      workspace,
      "concepts/c.md",
      `---
pageType: concept
title: Concept C
nodeId: concept-c
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Concept C is intentionally orphaned.
`,
    );

    runCliJson(["sync"], workspace.env);
    rmSync(`${workspace.vaultPath}/reports/q1-summary.pdf`, { force: true });
    runCliJson(["sync"], workspace.env);

    const lint = runCliJson<{
      errors: Array<{ check: string; page: string }>;
      warnings: Array<{ check: string; page: string }>;
      summary: { errors: number; warnings: number };
    }>(["lint", "--format", "json"], workspace.env);

    expect(lint.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "vault_ref_exists", page: "source-summaries/a.md" }),
        expect.objectContaining({ check: "page_ref_exists", page: "concepts/b.md" }),
      ]),
    );
    expect(lint.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "orphan_page", page: "concepts/c.md" }),
      ]),
    );
    expect(lint.summary.errors).toBeGreaterThanOrEqual(2);
    expect(lint.summary.warnings).toBeGreaterThanOrEqual(1);
  });
});

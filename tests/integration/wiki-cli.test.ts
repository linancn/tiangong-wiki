import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  readFile,
  readJson,
  runCli,
  writePage,
  writeVaultFile,
} from "../helpers.js";

describe("wiki CLI integration", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("covers init, sync, find, fts, graph, vault, lint, exports, config drift, sync --path, and stat", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    writeVaultFile(workspace, "projects/phoenix/spec.pdf", "spec-v1");
    writeVaultFile(workspace, "imports/old-draft.txt", "old-draft");

    const initResult = readJson<{ initialized: boolean }>(
      runCli(["init"], workspace.env).stdout,
    );
    expect(initResult.initialized).toBe(true);

    writePage(
      workspace,
      "concepts/probability-basics.md",
      `---
pageType: concept
title: Probability Basics
nodeId: probability-basics
status: active
visibility: shared
sourceRefs:
  - vault/projects/phoenix/spec.pdf
relatedPages: []
tags:
  - probability
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: high
prerequisites: []
---

Probability basics describe events, outcomes, and uncertainty.
`,
    );
    writePage(
      workspace,
      "concepts/bayes-theorem.md",
      `---
pageType: concept
title: Bayes Theorem
nodeId: bayes-theorem
status: active
visibility: shared
sourceRefs:
  - vault/projects/phoenix/spec.pdf
  - concepts/probability-basics.md
relatedPages:
  - concepts/probability-basics.md
tags:
  - probability
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites:
  - probability-basics
---

Bayes theorem updates beliefs after observing new evidence.
`,
    );
    writePage(
      workspace,
      "bridges/probability-to-product.md",
      `---
pageType: bridge
title: Probability to Product Decisions
nodeId: probability-product-bridge
status: active
visibility: private
sourceRefs:
  - concepts/bayes-theorem.md
relatedPages:
  - concepts/bayes-theorem.md
tags:
  - transfer
createdAt: 2026-04-06
updatedAt: 2026-04-06
fromCourse: statistics
toCourse: product
transferType: decision-making
fromConcepts:
  - bayes-theorem
toConcepts:
  - probability-basics
---

Use probabilistic thinking to update product bets after user feedback.
`,
    );
    writePage(
      workspace,
      "source-summaries/phoenix-spec.md",
      `---
pageType: source-summary
title: Phoenix Spec v1
nodeId: phoenix-spec-v1
status: active
visibility: private
sourceRefs:
  - vault/projects/phoenix/spec.pdf
relatedPages:
  - concepts/bayes-theorem.md
tags:
  - phoenix
createdAt: 2026-04-06
updatedAt: 2026-04-06
sourceType: pdf
vaultPath: projects/phoenix/spec.pdf
keyFindings:
  - Update decision rules from evidence
---

The Phoenix specification explains how to revise plans with incoming evidence.
`,
    );

    const firstSync = readJson<{ inserted: number }>(runCli(["sync"], workspace.env).stdout);
    expect(firstSync.inserted).toBe(4);

    writeVaultFile(workspace, "projects/phoenix/spec.pdf", "spec-v2");
    writeVaultFile(workspace, "projects/phoenix/notes.md", "new notes");
    // removed
    writePage(
      workspace,
      "concepts/bayes-theorem.md",
      `---
pageType: concept
title: Bayes Theorem
nodeId: bayes-theorem
status: active
visibility: shared
sourceRefs:
  - vault/projects/phoenix/spec.pdf
  - concepts/probability-basics.md
relatedPages:
  - concepts/probability-basics.md
tags:
  - probability
createdAt: 2026-04-06
updatedAt: 2026-04-07
confidence: high
masteryLevel: medium
courseId: ML-2026
prerequisites:
  - probability-basics
---

Bayes theorem updates beliefs after observing new evidence and is useful in classification.
`,
    );

    const configPath = `${workspace.wikiRoot}/wiki.config.json`;
    const config = JSON.parse(readFile(configPath)) as Record<string, unknown>;
    config.customColumns = { courseId: "text" };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    rmSync(`${workspace.vaultPath}/imports/old-draft.txt`, { force: true });

    const secondSync = readJson<{ updated: number; vault: { changes: number } }>(
      runCli(["sync"], workspace.env).stdout,
    );
    expect(secondSync.updated).toBeGreaterThanOrEqual(1);
    expect(secondSync.vault.changes).toBe(3);

    const findResult = readJson<Array<{ id: string; courseId?: string }>>(
      runCli(["find", "--type", "concept", "--course-id", "ML-2026"], workspace.env).stdout,
    );
    expect(findResult.map((item) => item.id)).toContain("concepts/bayes-theorem.md");

    const ftsResult = readJson<Array<{ id: string }>>(runCli(["fts", "classification"], workspace.env).stdout);
    expect(ftsResult[0]?.id).toBe("concepts/bayes-theorem.md");

    const graphResult = readJson<{
      edges: Array<{ edgeType: string; source: string; target: string }>;
    }>(runCli(["graph", "bayes-theorem", "--depth", "2"], workspace.env).stdout);
    expect(graphResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edgeType: "prerequisite", target: "probability-basics" }),
      ]),
    );

    const vaultList = readJson<Array<{ id: string }>>(runCli(["vault", "list", "--path", "projects/phoenix/"], workspace.env).stdout);
    expect(vaultList.map((item) => item.id)).toEqual(
      expect.arrayContaining(["projects/phoenix/spec.pdf", "projects/phoenix/notes.md"]),
    );

    const vaultDiffBeforePathSync = readJson<{ totalChanges: number; changes: Array<{ action: string }> }>(
      runCli(["vault", "diff"], workspace.env).stdout,
    );
    expect(vaultDiffBeforePathSync.totalChanges).toBe(3);

    const lintResult = readJson<{
      errors: Array<unknown>;
    }>(runCli(["lint", "--format", "json"], workspace.env).stdout);
    expect(lintResult.errors).toHaveLength(0);

    const exportGraph = readJson<{ nodes: number; edges: number }>(
      runCli(["export-graph", "--output", `${workspace.wikiRoot}/graph.json`], workspace.env).stdout,
    );
    expect(exportGraph.nodes).toBeGreaterThan(0);
    expect(readFile(`${workspace.wikiRoot}/graph.json`)).toContain("bayes-theorem");

    runCli(["export-index", "--output", `${workspace.wikiRoot}/index.md`], workspace.env);
    expect(readFile(`${workspace.wikiRoot}/index.md`)).toContain("# Wiki Index");

    writePage(
      workspace,
      "concepts/bayes-theorem.md",
      `---
pageType: concept
title: Bayes Theorem
nodeId: bayes-theorem
status: active
visibility: shared
sourceRefs:
  - vault/projects/phoenix/spec.pdf
  - concepts/probability-basics.md
relatedPages:
  - concepts/probability-basics.md
tags:
  - probability
createdAt: 2026-04-06
updatedAt: 2026-04-08
confidence: high
masteryLevel: medium
courseId: ML-2026
prerequisites:
  - probability-basics
---

Bayes theorem updates beliefs after observing new evidence and helps product experimentation.
`,
    );
    runCli(["sync", "--path", "concepts/bayes-theorem.md"], workspace.env);
    const vaultDiffAfterPathSync = readJson<{ totalChanges: number }>(
      runCli(["vault", "diff"], workspace.env).stdout,
    );
    expect(vaultDiffAfterPathSync.totalChanges).toBe(vaultDiffBeforePathSync.totalChanges);

    const statResult = readJson<{ totalPages: number; registeredTemplates: number }>(
      runCli(["stat"], workspace.env).stdout,
    );
    expect(statResult.totalPages).toBe(4);
    expect(statResult.registeredTemplates).toBe(11);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  runCliJson,
  updateWikiConfig,
  writePage,
} from "../helpers.js";

describe("path sync upgrade behavior", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("upgrades sync --path to a full sync when config drift introduces a new custom column", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    const pages = [
      ["concepts/probability.md", "probability", "phoenix"],
      ["concepts/bayes.md", "bayes", "phoenix"],
      ["concepts/likelihood.md", "likelihood", null],
      ["lessons/review-loop.md", "review-loop", null],
      ["methods/evidence-led-search.md", "evidence-led-search", null],
    ] as const;

    for (const [relativeId, nodeId, projectId] of pages) {
      const extraProject = projectId ? `projectId: ${projectId}\n` : "";
      writePage(
        workspace,
        relativeId,
        `---
pageType: ${relativeId.split("/")[0].replace(/s$/, "")}
title: ${nodeId}
nodeId: ${nodeId}
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - test
createdAt: 2026-04-06
updatedAt: 2026-04-06
${extraProject}${
          relativeId.startsWith("concepts/")
            ? "confidence: high\nmasteryLevel: medium\nprerequisites: []\n"
            : relativeId.startsWith("lessons/")
              ? "context: review\nseverity: medium\nactionable: true\n"
              : "domain: research\neffectiveness: medium\napplicableTo: literature-review\n"
        }---

Body for ${nodeId}.
`,
      );
    }

    runCliJson<{ inserted: number }>(["sync"], workspace.env);

    updateWikiConfig(workspace, (config) => {
      const customColumns = (config.customColumns ?? {}) as Record<string, unknown>;
      config.customColumns = {
        ...customColumns,
        projectId: "text",
      };
      return config;
    });

    const sync = runCliJson<{
      mode: string;
      upgradedToFullSync: boolean;
      configChanged: boolean;
      updated: number;
    }>(["sync", "--path", "concepts/bayes.md"], workspace.env);

    expect(sync.mode).toBe("full");
    expect(sync.upgradedToFullSync).toBe(true);
    expect(sync.configChanged).toBe(true);
    expect(sync.updated).toBe(5);

    const findResult = runCliJson<Array<{ id: string }>>(
      ["find", "--project-id", "phoenix"],
      workspace.env,
    );
    expect(findResult.map((item) => item.id).sort()).toEqual([
      "concepts/bayes.md",
      "concepts/probability.md",
    ]);

    const rows = queryDb<Record<string, unknown>>(
      workspace,
      "SELECT id, project_id AS projectId FROM pages ORDER BY id",
    );
    expect(rows.filter((row) => row.projectId === null)).toHaveLength(3);
  });

  it("syncs a renamed page without tripping the node_id unique constraint when nodeId is unchanged", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writePage(
      workspace,
      "concepts/original.md",
      `---
pageType: concept
title: Renamed Concept
nodeId: renamed-concept
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - rename
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Original body.
`,
    );

    runCliJson<{ inserted: number }>(["sync"], workspace.env);

    writePage(
      workspace,
      "archive/renamed.md",
      `---
pageType: concept
title: Renamed Concept
nodeId: renamed-concept
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - rename
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Original body.
`,
    );
    rmSync(path.join(workspace.wikiPath, "concepts", "original.md"), { force: true });

    const sync = runCliJson<{ inserted: number; deleted: number; updated: number }>(["sync"], workspace.env);

    expect(sync.inserted).toBe(1);
    expect(sync.updated).toBe(0);
    expect(sync.deleted).toBe(1);

    const rows = queryDb<{ id: string; nodeId: string | null }>(
      workspace,
      "SELECT id, node_id AS nodeId FROM pages ORDER BY id",
    );
    expect(rows).toEqual([{ id: "archive/renamed.md", nodeId: "renamed-concept" }]);
  });
});

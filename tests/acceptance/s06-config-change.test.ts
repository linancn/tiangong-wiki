import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  runCliJson,
  updateWikiConfig,
  writePage,
} from "../helpers.js";

describe("acceptance: S6 config change", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("backfills existing pages after adding a new custom column", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    const pages = [
      ["concepts/a.md", "A", "a-node", "phoenix"],
      ["concepts/b.md", "B", "b-node", "phoenix"],
      ["concepts/c.md", "C", "c-node", null],
      ["lessons/d.md", "D", "d-node", null],
      ["methods/e.md", "E", "e-node", null],
    ] as const;

    for (const [relativeId, title, nodeId, projectId] of pages) {
      const projectLine = projectId ? `projectId: ${projectId}\n` : "";
      const extra = relativeId.startsWith("concepts/")
        ? "confidence: high\nmasteryLevel: medium\nprerequisites: []\n"
        : relativeId.startsWith("lessons/")
          ? "context: review\nseverity: medium\nactionable: true\n"
          : "domain: experiments\neffectiveness: medium\napplicableTo: reviews\n";
      writePage(
        workspace,
        relativeId,
        `---
pageType: ${relativeId.split("/")[0].replace(/s$/, "")}
title: ${title}
nodeId: ${nodeId}
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - config
createdAt: 2026-04-06
updatedAt: 2026-04-06
${projectLine}${extra}---

${title} page body.
`,
      );
    }

    runCliJson(["sync"], workspace.env);

    updateWikiConfig(workspace, (config) => {
      const customColumns = (config.customColumns ?? {}) as Record<string, unknown>;
      config.customColumns = {
        ...customColumns,
        projectId: "text",
      };
      return config;
    });

    const sync = runCliJson<{
      configChanged: boolean;
      updated: number;
    }>(["sync"], workspace.env);
    expect(sync.configChanged).toBe(true);
    expect(sync.updated).toBe(5);

    const phoenixPages = runCliJson<Array<{ id: string }>>(
      ["find", "--project-id", "phoenix"],
      workspace.env,
    );
    expect(phoenixPages).toHaveLength(2);

    const rows = queryDb<Record<string, unknown>>(
      workspace,
      "SELECT id, project_id AS projectId FROM pages ORDER BY id",
    );
    expect(rows.filter((row) => row.projectId === null)).toHaveLength(3);

    const stat = runCliJson<{ registeredTemplates: number; totalPages: number }>(["stat"], workspace.env);
    expect(stat.registeredTemplates).toBe(11);
    expect(stat.totalPages).toBe(5);
  });
});

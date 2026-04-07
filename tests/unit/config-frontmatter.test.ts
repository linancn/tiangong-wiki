import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/core/config.js";
import { parsePage } from "../../src/core/frontmatter.js";
import { bootstrapRuntimeAssets, cleanupWorkspace, createWorkspace, writePage } from "../helpers.js";

describe("config and frontmatter", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("loads the default config and parses a concept page", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    const config = loadConfig(path.join(workspace.wikiRoot, "wiki.config.json"));
    const filePath = writePage(
      workspace,
      "concepts/bayes-theorem.md",
      `---
pageType: concept
title: Bayes Theorem
nodeId: bayes-theorem
status: active
visibility: shared
sourceRefs:
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
extraField: keep-me
---

Bayes theorem updates a probability distribution after new evidence.
`,
    );

    const result = parsePage(filePath, workspace.wikiPath, config);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.parsed.page.id).toBe("concepts/bayes-theorem.md");
    expect(result.parsed.page.nodeId).toBe("bayes-theorem");
    expect(result.parsed.columnValues.confidence).toBe("high");
    expect(result.parsed.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edgeType: "prerequisite", target: "probability-basics" }),
        expect.objectContaining({ edgeType: "related", target: "concepts/probability-basics.md" }),
      ]),
    );
    expect(result.parsed.page.extra).toMatchObject({
      sourceRefs: ["concepts/probability-basics.md"],
      relatedPages: ["concepts/probability-basics.md"],
      prerequisites: ["probability-basics"],
      extraField: "keep-me",
    });
  });

  it("returns a structured error for unknown page types", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    const config = loadConfig(path.join(workspace.wikiRoot, "wiki.config.json"));
    const filePath = writePage(
      workspace,
      "misc/bad.md",
      `---
pageType: unknown
title: Bad Page
---
`,
    );

    const result = parsePage(filePath, workspace.wikiPath, config);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("unknown_page_type");
  });
});

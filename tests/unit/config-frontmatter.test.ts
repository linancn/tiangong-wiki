import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_VAULT_FILE_TYPES, loadConfig } from "../../src/core/config.js";
import { parsePage } from "../../src/core/frontmatter.js";
import { bootstrapRuntimeAssets, cleanupWorkspace, createWorkspace, updateWikiConfig, writePage } from "../helpers.js";

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
    expect(config.fts.tokenizer).toBe("default");
    expect(config.vaultFileTypes).toEqual([...DEFAULT_VAULT_FILE_TYPES]);
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

  it("normalizes custom vault file types in wiki.config.json", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    updateWikiConfig(workspace, (config) => {
      config.vaultFileTypes = [".PDF", " txt ", "pdf", "YAML"];
    });

    const config = loadConfig(path.join(workspace.wikiRoot, "wiki.config.json"));
    expect(config.vaultFileTypes).toEqual(["pdf", "txt", "yaml"]);
  });

  it("validates fts tokenizer mode in wiki.config.json", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    updateWikiConfig(workspace, (config) => {
      config.fts = { tokenizer: "simple" };
    });

    const config = loadConfig(path.join(workspace.wikiRoot, "wiki.config.json"));
    expect(config.fts.tokenizer).toBe("simple");

    updateWikiConfig(workspace, (current) => {
      current.fts = { tokenizer: "unsupported" };
    });

    expect(() => loadConfig(path.join(workspace.wikiRoot, "wiki.config.json"))).toThrow(
      'fts.tokenizer must be "default" or "simple"',
    );
  });

  it("normalizes ISO date strings and falls back missing dates to today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:34:56Z"));

    try {
      const workspace = createWorkspace();
      workspaces.push(workspace);
      bootstrapRuntimeAssets(workspace);

      const config = loadConfig(path.join(workspace.wikiRoot, "wiki.config.json"));
      const filePath = writePage(
        workspace,
        "concepts/date-normalized.md",
        `---
pageType: concept
title: Date Normalized
nodeId: date-normalized
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06T08:09:10.000Z
confidence: high
masteryLevel: medium
prerequisites: []
---

Date normalization should strip time and populate updatedAt when omitted.
`,
      );

      const result = parsePage(filePath, workspace.wikiPath, config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.parsed.page.createdAt).toBe("2026-04-06");
      expect(result.parsed.page.updatedAt).toBe("2026-04-07");
    } finally {
      vi.useRealTimers();
    }
  });
});

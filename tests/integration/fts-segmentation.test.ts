import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  dbScalar,
  readJson,
  readMeta,
  runCli,
  workspaceDbPath,
  writePage,
} from "../helpers.js";

describe("FTS segmentation integration", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("supports Chinese queries, preserves natural summaries, and migrates legacy FTS tables", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writePage(
      workspace,
      "concepts/dev-env.md",
      `---
pageType: concept
title: 开发环境配置
nodeId: dev-env-setup
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - 开发
  - AI
createdAt: 2026-04-07
updatedAt: 2026-04-07
confidence: high
masteryLevel: high
prerequisites: []
---

开发环境配置说明，适合 AI 工程项目。
`,
    );
    writePage(
      workspace,
      "concepts/classification.md",
      `---
pageType: concept
title: Classification Guide
nodeId: classification-guide
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - machine-learning
createdAt: 2026-04-07
updatedAt: 2026-04-07
confidence: high
masteryLevel: medium
prerequisites: []
---

Classification models support product decisions with fresh evidence.
`,
    );

    const initResult = readJson<{ initialized: boolean; sync: { inserted: number } }>(
      runCli(["init"], workspace.env).stdout,
    );
    expect(initResult.initialized).toBe(true);
    expect(initResult.sync.inserted).toBe(2);

    const chineseResult = readJson<Array<{ id: string }>>(runCli(["fts", "开发"], workspace.env).stdout);
    expect(chineseResult.map((item) => item.id)).toContain("concepts/dev-env.md");

    const chineseSubstringResult = readJson<Array<{ id: string }>>(
      runCli(["fts", "环境"], workspace.env).stdout,
    );
    expect(chineseSubstringResult.map((item) => item.id)).toContain("concepts/dev-env.md");

    const aiResult = readJson<Array<{ id: string }>>(runCli(["fts", "AI"], workspace.env).stdout);
    expect(aiResult.map((item) => item.id)).toContain("concepts/dev-env.md");

    const englishResult = readJson<Array<{ id: string }>>(
      runCli(["fts", "classification"], workspace.env).stdout,
    );
    expect(englishResult.map((item) => item.id)).toContain("concepts/classification.md");

    const naturalSummary = dbScalar<string>(
      workspace,
      "SELECT summary_text FROM pages WHERE id = ?",
      ["concepts/dev-env.md"],
    );
    expect(naturalSummary).toContain("开发环境配置说明");
    expect(naturalSummary).not.toContain("开发 环境");

    const segmentedSummary = dbScalar<string>(
      workspace,
      `
        SELECT pages_fts.summary_text
        FROM pages_fts
        JOIN pages ON pages.rowid = pages_fts.rowid
        WHERE pages.id = ?
      `,
      ["concepts/dev-env.md"],
    );
    expect(segmentedSummary).toMatch(/开发\s+环境/);

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.exec(`
        DROP TABLE pages_fts;
        CREATE VIRTUAL TABLE pages_fts USING fts5(
          title,
          tags,
          summary_text,
          content='pages',
          content_rowid='rowid'
        );
        INSERT INTO pages_fts(pages_fts) VALUES('rebuild');
        DELETE FROM sync_meta WHERE key = 'fts_index_version';
      `);
    } finally {
      db.close();
    }

    const migratedResult = readJson<Array<{ id: string }>>(runCli(["fts", "开发"], workspace.env).stdout);
    expect(migratedResult.map((item) => item.id)).toContain("concepts/dev-env.md");
    expect(readMeta(workspace, "fts_index_version")).toBe("2");

    const migratedSegmentedSummary = dbScalar<string>(
      workspace,
      `
        SELECT pages_fts.summary_text
        FROM pages_fts
        JOIN pages ON pages.rowid = pages_fts.rowid
        WHERE pages.id = ?
      `,
      ["concepts/dev-env.md"],
    );
    expect(migratedSegmentedSummary).toMatch(/开发\s+环境/);
  });
});

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  runCli,
  workspaceDbPath,
  writeVaultFile,
} from "../helpers.js";

const WORKFLOW_COLUMNS = [
  "thread_id",
  "workflow_version",
  "decision",
  "result_manifest_path",
  "last_error_at",
  "retry_after",
  "created_page_ids",
  "updated_page_ids",
  "applied_type_names",
  "proposed_type_names",
  "skills_used",
];

describe("queue schema workflow fields", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("upgrades an existing queue table in place and keeps init/sync idempotent", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    writeVaultFile(workspace, "imports/spec.pdf", "durable spec");

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vault_processing_queue (
          file_id TEXT PRIMARY KEY,
          status TEXT DEFAULT 'pending',
          priority INTEGER DEFAULT 0,
          queued_at TEXT NOT NULL,
          processed_at TEXT,
          result_page_id TEXT,
          error_message TEXT,
          attempts INTEGER DEFAULT 0
        );
      `);
    } finally {
      db.close();
    }

    runCli(["init"], workspace.env);

    const columns = queryDb<{ name: string }>(workspace, "PRAGMA table_info(vault_processing_queue)");
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(WORKFLOW_COLUMNS));

    const syncAgain = JSON.parse(runCli(["sync"], workspace.env).stdout) as {
      inserted: number;
      updated: number;
      deleted: number;
    };
    expect(syncAgain).toMatchObject({
      inserted: 0,
      updated: 0,
      deleted: 0,
    });
  });

  it("persists workflow state columns on queue rows", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/spec.pdf", "durable spec");

    runCli(["init"], workspace.env);

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.prepare(
        `
          UPDATE vault_processing_queue
          SET
            thread_id = @threadId,
            workflow_version = @workflowVersion,
            decision = @decision,
            result_manifest_path = @resultManifestPath,
            last_error_at = @lastErrorAt,
            retry_after = @retryAfter,
            created_page_ids = @createdPageIds,
            updated_page_ids = @updatedPageIds,
            applied_type_names = @appliedTypeNames,
            proposed_type_names = @proposedTypeNames,
            skills_used = @skillsUsed
          WHERE file_id = @fileId
        `,
      ).run({
        fileId: "imports/spec.pdf",
        threadId: "thread-123",
        workflowVersion: "2026-04-07",
        decision: "apply",
        resultManifestPath: "/tmp/result.json",
        lastErrorAt: "2026-04-07T12:00:00+08:00",
        retryAfter: "2026-04-07T12:05:00+08:00",
        createdPageIds: JSON.stringify(["concepts/spec.md"]),
        updatedPageIds: JSON.stringify(["methods/review.md"]),
        appliedTypeNames: JSON.stringify(["concept", "method"]),
        proposedTypeNames: JSON.stringify(["lab-report"]),
        skillsUsed: JSON.stringify(["wiki-skill", "pdf"]),
      });
    } finally {
      db.close();
    }

    const rows = queryDb<Record<string, string | null>>(
      workspace,
      `
        SELECT
          thread_id AS threadId,
          workflow_version AS workflowVersion,
          decision,
          result_manifest_path AS resultManifestPath,
          created_page_ids AS createdPageIds,
          updated_page_ids AS updatedPageIds,
          applied_type_names AS appliedTypeNames,
          proposed_type_names AS proposedTypeNames,
          skills_used AS skillsUsed
        FROM vault_processing_queue
        WHERE file_id = ?
      `,
      ["imports/spec.pdf"],
    );
    expect(rows[0]).toEqual({
      threadId: "thread-123",
      workflowVersion: "2026-04-07",
      decision: "apply",
      resultManifestPath: "/tmp/result.json",
      createdPageIds: '["concepts/spec.md"]',
      updatedPageIds: '["methods/review.md"]',
      appliedTypeNames: '["concept","method"]',
      proposedTypeNames: '["lab-report"]',
      skillsUsed: '["wiki-skill","pdf"]',
    });
  });
});

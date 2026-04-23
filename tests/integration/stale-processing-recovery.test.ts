import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";

import { FakeCodexWorkflowRunner } from "../../src/core/codex-workflow.js";
import { loadRuntimeConfig } from "../../src/core/runtime.js";
import { processVaultQueueBatch } from "../../src/core/vault-processing.js";
import { ensureWorkflowArtifactSet } from "../../src/core/workflow-context.js";
import {
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  runCli,
  waitFor,
  workspaceDbPath,
  writeVaultFile,
} from "../helpers.js";

function baseEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    WIKI_AGENT_ENABLED: "true",
    WIKI_AGENT_API_KEY: "test-agent-key",
    WIKI_AGENT_MODEL: "gpt-5.4",
    WIKI_AGENT_BATCH_SIZE: "1",
    ...extraEnv,
  };
}

function staleTimestamp(): string {
  return "2000-01-01T00:00:00+00:00";
}

function currentTimestamp(): string {
  return "2099-01-01T00:00:00+00:00";
}

function skippedManifest(threadId: string, reason: string) {
  return {
    status: "skipped",
    decision: "skip",
    reason,
    threadId,
    skillsUsed: ["tiangong-wiki-skill"],
    createdPageIds: [],
    updatedPageIds: [],
    appliedTypeNames: [],
    proposedTypes: [],
    actions: [],
    lint: [],
  };
}

describe("stale processing recovery", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("clears stale execution fields when an errored item is reclaimed for processing", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/dirty.pdf", "Dirty queue item.");
    runCli(["init"], workspace.env);

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.prepare(
        `
          UPDATE vault_processing_queue
          SET
            status = 'error',
            claimed_at = @claimedAt,
            started_at = @startedAt,
            processed_at = @processedAt,
            result_page_id = @resultPageId,
            error_message = @errorMessage,
            attempts = 1,
            thread_id = @threadId,
            workflow_version = @workflowVersion,
            decision = @decision,
            result_manifest_path = @resultManifestPath,
            last_error_at = @lastErrorAt,
            last_error_code = @lastErrorCode,
            retry_after = @retryAfter,
            created_page_ids = @createdPageIds,
            updated_page_ids = @updatedPageIds,
            applied_type_names = @appliedTypeNames,
            proposed_type_names = @proposedTypeNames,
            skills_used = @skillsUsed
          WHERE file_id = @fileId
        `,
      ).run({
        fileId: "imports/dirty.pdf",
        claimedAt: staleTimestamp(),
        startedAt: staleTimestamp(),
        processedAt: staleTimestamp(),
        resultPageId: "source-summaries/dirty.md",
        errorMessage: "old failure",
        threadId: "stale-thread",
        workflowVersion: "2026-04-07",
        decision: "apply",
        resultManifestPath: "/tmp/stale-result.json",
        lastErrorAt: staleTimestamp(),
        lastErrorCode: "queue_full",
        retryAfter: staleTimestamp(),
        createdPageIds: JSON.stringify(["source-summaries/dirty.md"]),
        updatedPageIds: JSON.stringify(["people/example.md"]),
        appliedTypeNames: JSON.stringify(["source-summary"]),
        proposedTypeNames: JSON.stringify(["report"]),
        skillsUsed: JSON.stringify(["pdf"]),
      });
    } finally {
      db.close();
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new FakeCodexWorkflowRunner(async ({ threadId }) => {
      await gate;
      return skippedManifest(threadId, "Delayed completion.");
    });

    const batchPromise = processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    await waitFor(() => {
      const rows = queryDb<Record<string, string | null>>(
        workspace,
        `
          SELECT
            status,
            heartbeat_at AS heartbeatAt,
            processing_owner_id AS processingOwnerId,
            processed_at AS processedAt,
            result_page_id AS resultPageId,
            error_message AS errorMessage,
            decision,
            last_error_code AS lastErrorCode,
            created_page_ids AS createdPageIds
          FROM vault_processing_queue
          WHERE file_id = 'imports/dirty.pdf'
        `,
      );
      return rows[0]?.status === "processing" && typeof rows[0]?.processingOwnerId === "string";
    });

    const row = queryDb<Record<string, string | null>>(
      workspace,
      `
        SELECT
          status,
          heartbeat_at AS heartbeatAt,
          processing_owner_id AS processingOwnerId,
          processed_at AS processedAt,
          result_page_id AS resultPageId,
          error_message AS errorMessage,
          decision,
          last_error_code AS lastErrorCode,
          created_page_ids AS createdPageIds
        FROM vault_processing_queue
        WHERE file_id = 'imports/dirty.pdf'
      `,
    )[0];
    expect(row).toEqual(
      expect.objectContaining({
        status: "processing",
        processedAt: null,
        resultPageId: null,
        errorMessage: null,
        decision: null,
        lastErrorCode: null,
        createdPageIds: null,
      }),
    );
    expect(row?.heartbeatAt).toBeTruthy();
    expect(row?.processingOwnerId).toBeTruthy();

    release();
    await batchPromise;
  });

  it("recovers a stale processing item from an existing result manifest without rerunning the workflow", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/recover.pdf", "Recoverable queue item.");
    runCli(["init"], workspace.env);

    const runtime = loadRuntimeConfig(workspace.env);
    const artifacts = ensureWorkflowArtifactSet(runtime.paths, {
      queueItemId: "imports/recover.pdf",
      queueItem: { fileId: "imports/recover.pdf", threadId: "stale-thread" },
    });
    writeFileSync(artifacts.resultPath, `${JSON.stringify(skippedManifest("stale-thread", "Recovered from disk."), null, 2)}\n`, "utf8");

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.prepare(
        `
          UPDATE vault_processing_queue
          SET
            status = 'processing',
            claimed_at = @claimedAt,
            started_at = @startedAt,
            heartbeat_at = @heartbeatAt,
            processing_owner_id = @processingOwnerId,
            thread_id = @threadId,
            result_manifest_path = @resultManifestPath
          WHERE file_id = @fileId
        `,
      ).run({
        fileId: "imports/recover.pdf",
        claimedAt: staleTimestamp(),
        startedAt: staleTimestamp(),
        heartbeatAt: staleTimestamp(),
        processingOwnerId: "stale-owner",
        threadId: "stale-thread",
        resultManifestPath: artifacts.resultPath,
      });
    } finally {
      db.close();
    }

    const runner = new FakeCodexWorkflowRunner(async () => {
      throw new Error("workflow should not run for recovered stale items");
    });

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      processed: 1,
      skipped: 1,
      done: 0,
      errored: 0,
      items: [expect.objectContaining({ fileId: "imports/recover.pdf", status: "skipped" })],
    });
    expect(runner.calls).toHaveLength(0);

    const row = queryDb<Record<string, string | null>>(
      workspace,
      `
        SELECT
          status,
          heartbeat_at AS heartbeatAt,
          processing_owner_id AS processingOwnerId
        FROM vault_processing_queue
        WHERE file_id = 'imports/recover.pdf'
      `,
    )[0];
    expect(row).toEqual({
      status: "skipped",
      heartbeatAt: null,
      processingOwnerId: null,
    });
  });

  it("requeues a stale processing item without a recoverable result and processes it in the same batch", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/requeue.pdf", "Needs requeue.");
    runCli(["init"], workspace.env);

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.prepare(
        `
          UPDATE vault_processing_queue
          SET
            status = 'processing',
            claimed_at = @claimedAt,
            started_at = @startedAt,
            heartbeat_at = @heartbeatAt,
            processing_owner_id = @processingOwnerId,
            thread_id = @threadId,
            result_manifest_path = @resultManifestPath
          WHERE file_id = @fileId
        `,
      ).run({
        fileId: "imports/requeue.pdf",
        claimedAt: staleTimestamp(),
        startedAt: staleTimestamp(),
        heartbeatAt: staleTimestamp(),
        processingOwnerId: "stale-owner",
        threadId: "stale-thread",
        resultManifestPath: "/tmp/missing-result.json",
      });
    } finally {
      db.close();
    }

    const runner = new FakeCodexWorkflowRunner(async ({ threadId }) => skippedManifest(threadId, "Reprocessed after stale recovery."));

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      processed: 1,
      skipped: 1,
      items: [expect.objectContaining({ fileId: "imports/requeue.pdf", status: "skipped" })],
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      mode: "start",
      queueItemId: "imports/requeue.pdf",
    });

    const row = queryDb<Record<string, string | null>>(
      workspace,
      `
        SELECT
          status,
          heartbeat_at AS heartbeatAt,
          processing_owner_id AS processingOwnerId,
          decision
        FROM vault_processing_queue
        WHERE file_id = 'imports/requeue.pdf'
      `,
    )[0];
    expect(row).toEqual({
      status: "skipped",
      heartbeatAt: null,
      processingOwnerId: null,
      decision: "skip",
    });
  });

  it("does not recover a processing item when its heartbeat is still fresh", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/live.pdf", "Live processing item.");
    runCli(["init"], workspace.env);

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.prepare(
        `
          UPDATE vault_processing_queue
          SET
            status = 'processing',
            claimed_at = @claimedAt,
            started_at = @startedAt,
            heartbeat_at = @heartbeatAt,
            processing_owner_id = @processingOwnerId,
            thread_id = @threadId
          WHERE file_id = @fileId
        `,
      ).run({
        fileId: "imports/live.pdf",
        claimedAt: staleTimestamp(),
        startedAt: staleTimestamp(),
        heartbeatAt: currentTimestamp(),
        processingOwnerId: "other-live-owner",
        threadId: "live-thread",
      });
    } finally {
      db.close();
    }

    const runner = new FakeCodexWorkflowRunner(async () => {
      throw new Error("workflow should not run when no queue item is claimable");
    });

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      processed: 0,
      skipped: 0,
      done: 0,
      errored: 0,
      items: [],
    });

    const row = queryDb<Record<string, string | null>>(
      workspace,
      `
        SELECT
          status,
          heartbeat_at AS heartbeatAt,
          processing_owner_id AS processingOwnerId,
          thread_id AS threadId
        FROM vault_processing_queue
        WHERE file_id = 'imports/live.pdf'
      `,
    )[0];
    expect(row).toEqual({
      status: "processing",
      heartbeatAt: currentTimestamp(),
      processingOwnerId: "other-live-owner",
      threadId: "live-thread",
    });
    expect(runner.calls).toHaveLength(0);
  });
});

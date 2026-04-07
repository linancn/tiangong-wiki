import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { FakeCodexWorkflowRunner } from "../../src/core/codex-workflow.js";
import { runSyncCommand, type SyncCommandResult } from "../../src/operations/write.js";
import {
  cleanupWorkspace,
  createWorkspace,
  runCli,
  runCliJson,
  waitFor,
  workspaceDbPath,
  writeVaultFile,
} from "../helpers.js";

function baseEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    WIKI_AGENT_ENABLED: "true",
    WIKI_AGENT_API_KEY: "test-agent-key",
    WIKI_AGENT_MODEL: "gpt-5.4",
    WIKI_AGENT_BACKEND: "codex-workflow",
    WIKI_AGENT_BATCH_SIZE: "10",
    ...extraEnv,
  };
}

function createSkipRunner() {
  return new FakeCodexWorkflowRunner(({ queueItemId, threadId }) => ({
    status: "skipped",
    decision: "skip",
    reason: `Skipped ${queueItemId}.`,
    threadId,
    skillsUsed: ["wiki-skill"],
    createdPageIds: [],
    updatedPageIds: [],
    appliedTypeNames: [],
    proposedTypes: [],
    actions: [],
    lint: [],
  }));
}

describe("sync --process", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(async () => {
    while (workspaces.length > 0) {
      const workspace = workspaces.pop()!;
      runCli(["daemon", "stop"], workspace.env, { allowFailure: true });
      await waitFor(() => true, 1, 1).catch(() => undefined);
      cleanupWorkspace(workspace);
    }
  });

  it("processes all pending queue items after sync through the shared sync command operation", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    runCli(["init"], workspace.env);
    writeVaultFile(workspace, "imports/spec.pdf", "Durable spec content.");
    writeVaultFile(workspace, "imports/notes.md", "# Notes\n\nDurable notes.");

    const runner = createSkipRunner();
    const result = await runSyncCommand(workspace.env, {
      process: true,
      workflowRunner: runner,
    });

    expect(result.queueProcess).toEqual(
      expect.objectContaining({
        enabled: true,
        requestedFileId: null,
        processed: 2,
        done: 0,
        skipped: 2,
        errored: 0,
        noopReason: null,
      }),
    );
    expect(runner.calls.map((call) => call.queueItemId).sort()).toEqual(["imports/notes.md", "imports/spec.pdf"]);

    const queue = runCliJson<{
      totalPending: number;
      totalSkipped: number;
      items: Array<{ fileId: string; status: string }>;
    }>(["vault", "queue"], workspace.env);
    expect(queue.totalPending).toBe(0);
    expect(queue.totalSkipped).toBe(2);
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: "imports/spec.pdf", status: "skipped" }),
        expect.objectContaining({ fileId: "imports/notes.md", status: "skipped" }),
      ]),
    );
  });

  it("supports --vault-file targeting and handles skipped, missing, and processing queue states", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    runCli(["init"], workspace.env);
    writeVaultFile(workspace, "imports/spec.pdf", "Durable spec content.");
    writeVaultFile(workspace, "imports/notes.md", "# Notes\n\nDurable notes.");
    runCli(["sync"], workspace.env);

    const runner = createSkipRunner();
    const targeted = await runSyncCommand(workspace.env, {
      process: true,
      vaultFileId: "imports/spec.pdf",
      workflowRunner: runner,
    });
    expect(targeted.queueProcess).toEqual(
      expect.objectContaining({
        enabled: true,
        requestedFileId: "imports/spec.pdf",
        processed: 1,
        skipped: 1,
        currentStatus: "skipped",
        noopReason: null,
      }),
    );
    expect(runner.calls.map((call) => call.queueItemId)).toEqual(["imports/spec.pdf"]);

    const queueAfterTargeted = runCliJson<{
      totalPending: number;
      totalSkipped: number;
      items: Array<{ fileId: string; status: string }>;
    }>(["vault", "queue"], workspace.env);
    expect(queueAfterTargeted.totalPending).toBe(1);
    expect(queueAfterTargeted.totalSkipped).toBe(1);
    expect(queueAfterTargeted.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: "imports/spec.pdf", status: "skipped" }),
        expect.objectContaining({ fileId: "imports/notes.md", status: "pending" }),
      ]),
    );

    const noop = await runSyncCommand(workspace.env, {
      process: true,
      vaultFileId: "imports/spec.pdf",
      workflowRunner: runner,
    });
    expect(noop.queueProcess).toEqual(
      expect.objectContaining({
        enabled: true,
        requestedFileId: "imports/spec.pdf",
        processed: 0,
        currentStatus: "skipped",
        noopReason: "already_skipped",
      }),
    );

    await expect(
      runSyncCommand(workspace.env, {
        process: true,
        vaultFileId: "imports/missing.pdf",
        workflowRunner: runner,
      }),
    ).rejects.toMatchObject({
      type: "not_found",
    });

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.prepare(
        `
          UPDATE vault_processing_queue
          SET status = 'processing'
          WHERE file_id = 'imports/notes.md'
        `,
      ).run();
    } finally {
      db.close();
    }

    await expect(
      runSyncCommand(workspace.env, {
        process: true,
        vaultFileId: "imports/notes.md",
        workflowRunner: runner,
      }),
    ).rejects.toMatchObject({
      type: "runtime",
    });
  });

  it("rejects invalid CLI parameter combinations", () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    const missingProcess = runCli(["sync", "--vault-file", "imports/spec.pdf"], workspace.env, {
      allowFailure: true,
    });
    expect(missingProcess.status).toBe(2);
    expect(missingProcess.stderr).toContain("--vault-file requires --process");

    const conflictingFlags = runCli(
      ["sync", "--process", "--path", "concepts/spec.md", "--vault-file", "imports/spec.pdf"],
      workspace.env,
      { allowFailure: true },
    );
    expect(conflictingFlags.status).toBe(2);
    expect(conflictingFlags.stderr).toContain("--process cannot be combined with --path");
  });

  it("routes sync --process through the daemon /sync endpoint when the daemon is running", async () => {
    const workspace = createWorkspace(
      baseEnv({
        WIKI_SYNC_INTERVAL: "0",
        WIKI_TEST_FAKE_WORKFLOW_MODE: "skip",
      }),
    );
    workspaces.push(workspace);

    runCli(["init"], workspace.env);
    writeVaultFile(workspace, "imports/spec.pdf", "Durable spec content.");
    writeVaultFile(workspace, "imports/notes.md", "# Notes\n\nDurable notes.");

    const started = runCliJson<{ status: string; pid: number }>(["daemon", "start"], workspace.env);
    expect(started.status).toBe("started");

    await waitFor(() => {
      const status = runCliJson<{ running: boolean }>(["daemon", "status", "--format", "json"], workspace.env);
      return status.running;
    });

    const targeted = runCliJson<SyncCommandResult>(
      ["sync", "--process", "--vault-file", "imports/spec.pdf"],
      workspace.env,
    );
    expect(targeted.queueProcess).toEqual(
      expect.objectContaining({
        enabled: true,
        requestedFileId: "imports/spec.pdf",
        processed: 1,
        skipped: 1,
        currentStatus: "skipped",
      }),
    );

    const queueAfterTargeted = runCliJson<{
      totalPending: number;
      totalSkipped: number;
      items: Array<{ fileId: string; status: string }>;
    }>(["vault", "queue"], workspace.env);
    expect(queueAfterTargeted.totalPending).toBe(1);
    expect(queueAfterTargeted.totalSkipped).toBe(1);

    const remaining = runCliJson<SyncCommandResult>(["sync", "--process"], workspace.env);
    expect(remaining.queueProcess).toEqual(
      expect.objectContaining({
        enabled: true,
        requestedFileId: null,
        processed: 1,
        skipped: 1,
        errored: 0,
      }),
    );

    const finalQueue = runCliJson<{
      totalPending: number;
      totalSkipped: number;
    }>(["vault", "queue"], workspace.env);
    expect(finalQueue.totalPending).toBe(0);
    expect(finalQueue.totalSkipped).toBe(2);
  });
});

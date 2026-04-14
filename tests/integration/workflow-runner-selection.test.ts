import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  FakeCodexWorkflowRunner,
  type CodexWorkflowHandle,
  type CodexWorkflowInput,
  type CodexWorkflowRunner,
} from "../../src/core/codex-workflow.js";
import { resolveRuntimePaths } from "../../src/core/paths.js";
import { processVaultQueueBatch } from "../../src/core/vault-processing.js";
import { readWorkflowResult, type WorkflowResultManifest } from "../../src/core/workflow-result.js";
import { ensureWikiSkillInstall } from "../../src/core/workspace-skills.js";
import { AppError } from "../../src/utils/errors.js";
import {
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  runCli,
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

describe("workflow runner selection", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("routes codex-workflow items through the workflow runner for apply and skip results", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/spec.pdf", "Durable spec content.");
    writeVaultFile(workspace, "imports/noise.txt", "tmp");

    runCli(["init"], workspace.env);

    const runner = new FakeCodexWorkflowRunner(({ queueItemId, threadId }) => {
      if (queueItemId.endsWith("spec.pdf")) {
        return {
          status: "done",
          decision: "apply",
          reason: "Captured the durable spec.",
          threadId,
          skillsUsed: ["tiangong-wiki-skill", "pdf"],
          createdPageIds: ["concepts/spec.md"],
          updatedPageIds: [],
          appliedTypeNames: ["concept"],
          proposedTypes: [],
          actions: [
            {
              kind: "create_page",
              pageType: "concept",
              pageId: "concepts/spec.md",
              title: "Spec",
              summary: "Created a concept page from the spec.",
            },
          ],
          lint: [
            {
              pageId: "concepts/spec.md",
              errors: 0,
              warnings: 0,
            },
          ],
        };
      }

      return {
        status: "skipped",
        decision: "skip",
        reason: "The file is too noisy.",
        threadId,
        skillsUsed: ["tiangong-wiki-skill"],
        createdPageIds: [],
        updatedPageIds: [],
        appliedTypeNames: [],
        proposedTypes: [],
        actions: [],
        lint: [],
      };
    });

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      enabled: true,
      processed: 2,
      done: 1,
      skipped: 1,
      errored: 0,
    });
    expect(runner.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "start", queueItemId: "imports/spec.pdf" }),
        expect.objectContaining({ mode: "start", queueItemId: "imports/noise.txt" }),
      ]),
    );

    const queueRows = queryDb<Record<string, string | null>>(
      workspace,
      `
        SELECT
          file_id AS fileId,
          status,
          decision,
          thread_id AS threadId,
          result_manifest_path AS resultManifestPath,
          created_page_ids AS createdPageIds
        FROM vault_processing_queue
        ORDER BY file_id
      `,
    );
    expect(queueRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: "imports/spec.pdf",
          status: "done",
          decision: "apply",
          createdPageIds: '["concepts/spec.md"]',
        }),
        expect.objectContaining({
          fileId: "imports/noise.txt",
          status: "skipped",
          decision: "skip",
        }),
      ]),
    );
    expect(queueRows.every((row) => typeof row.threadId === "string" && row.threadId.length > 0)).toBe(true);
    expect(queueRows.every((row) => typeof row.resultManifestPath === "string" && row.resultManifestPath.length > 0)).toBe(true);
  });

  it("prepares workflow input from workspace root so workspace-local skills are discoverable", async () => {
    const workspace = createWorkspace(baseEnv({ WIKI_AGENT_BATCH_SIZE: "1" }));
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/spec.pdf", "Durable spec content.");

    runCli(["init"], workspace.env);

    const runtimePaths = resolveRuntimePaths(workspace.env);
    ensureWikiSkillInstall(workspace.wikiPath, runtimePaths.packageRoot);
    const parserSkillDir = path.join(workspace.root, ".agents", "skills", "pdf");
    mkdirSync(parserSkillDir, { recursive: true });
    writeFileSync(path.join(parserSkillDir, "SKILL.md"), "---\nname: pdf\ndescription: parser\n---\n", "utf8");

    const observedInputs: CodexWorkflowInput[] = [];
    const runner = new FakeCodexWorkflowRunner(({ threadId, input }) => {
      observedInputs.push(input);
      return {
        status: "done",
        decision: "apply",
        reason: "Captured the durable spec.",
        threadId,
        skillsUsed: ["tiangong-wiki-skill", "pdf"],
        createdPageIds: ["concepts/spec.md"],
        updatedPageIds: [],
        appliedTypeNames: ["concept"],
        proposedTypes: [],
        actions: [
          {
            kind: "create_page",
            pageType: "concept",
            pageId: "concepts/spec.md",
            title: "Spec",
            summary: "Created a concept page from the spec.",
          },
        ],
        lint: [{ pageId: "concepts/spec.md", errors: 0, warnings: 0 }],
      };
    });

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({ processed: 1, done: 1, errored: 0 });
    expect(observedInputs).toHaveLength(1);
    expect(observedInputs[0]?.workspaceRoot).toBe(workspace.root);
    expect(observedInputs[0]?.promptText).toContain("Workspace-local skills are available from WORKSPACE_ROOT");
    expect(observedInputs[0]?.promptText).not.toContain("SKILL_PACKAGE_ROOT=");
    expect(existsSync(path.join(workspace.root, ".agents", "skills", "tiangong-wiki-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(workspace.root, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
  });

  it("resumes existing threads and records runner failures with root causes", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/resume.pdf", "Resume this workflow.");
    writeVaultFile(workspace, "imports/fail.pdf", "Fail this workflow.");

    runCli(["init"], workspace.env);

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.prepare(
        `
          UPDATE vault_processing_queue
          SET status = 'error', thread_id = 'persisted-thread'
          WHERE file_id = 'imports/resume.pdf'
        `,
      ).run();
    } finally {
      db.close();
    }

    const runner = new FakeCodexWorkflowRunner(({ mode, queueItemId, threadId }) => {
      if (queueItemId.endsWith("fail.pdf")) {
        throw new AppError("Codex workflow stream failed", "runtime", { cause: "runner exploded" });
      }

      return {
        status: "done",
        decision: "apply",
        reason: "Resumed and completed.",
        threadId,
        skillsUsed: ["tiangong-wiki-skill"],
        createdPageIds: [],
        updatedPageIds: ["methods/resume.md"],
        appliedTypeNames: ["method"],
        proposedTypes: [],
        actions: [
          {
            kind: "update_page",
            pageType: "method",
            pageId: "methods/resume.md",
            summary: `Completed in ${mode}.`,
          },
        ],
        lint: [
          {
            pageId: "methods/resume.md",
            errors: 0,
            warnings: 0,
          },
        ],
      };
    });

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      processed: 2,
      done: 1,
      errored: 1,
    });
    expect(runner.calls).toEqual(
      expect.arrayContaining([
        { mode: "resume", queueItemId: "imports/resume.pdf", threadId: "persisted-thread" },
        expect.objectContaining({ mode: "start", queueItemId: "imports/fail.pdf" }),
      ]),
    );

    const queueRows = queryDb<Record<string, string | number | null>>(
      workspace,
      `
        SELECT
          file_id AS fileId,
          status,
          thread_id AS threadId,
          attempts,
          last_error_at AS lastErrorAt,
          result_page_id AS resultPageId,
          error_message AS errorMessage
        FROM vault_processing_queue
        ORDER BY file_id
      `,
    );
    expect(queueRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: "imports/resume.pdf",
          status: "done",
          threadId: "persisted-thread",
          resultPageId: "methods/resume.md",
        }),
        expect.objectContaining({
          fileId: "imports/fail.pdf",
          status: "error",
          attempts: 1,
          errorMessage: "Codex workflow stream failed: runner exploded",
        }),
      ]),
    );
    expect(queueRows.find((row) => row.fileId === "imports/fail.pdf")?.lastErrorAt).toBeTruthy();
  });

  it("records sandbox startup failures with explicit root-cause messaging", async () => {
    const workspace = createWorkspace(baseEnv({ WIKI_AGENT_SANDBOX_MODE: "workspace-write" }));
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/sandbox.pdf", "Sandbox failure.");

    runCli(["init"], workspace.env);

    const runner: CodexWorkflowRunner = {
      async startWorkflow(): Promise<CodexWorkflowHandle> {
        throw new AppError("Codex workflow sandbox failed to initialize", "runtime", {
          cause: "bwrap: setting up uid map: Permission denied",
        });
      },
      async resumeWorkflow(): Promise<CodexWorkflowHandle> {
        throw new Error("resumeWorkflow should not run for a fresh item");
      },
      async collectResult(): Promise<WorkflowResultManifest> {
        throw new Error("collectResult should not run after sandbox startup failure");
      },
    };

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      processed: 1,
      done: 0,
      errored: 1,
      items: [
        expect.objectContaining({
          fileId: "imports/sandbox.pdf",
          status: "error",
          reason: "Codex workflow sandbox failed to initialize: bwrap: setting up uid map: Permission denied",
        }),
      ],
    });
  });

  it("salvages a persisted result manifest after a runner failure instead of re-injecting the task", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/salvage.pdf", "Salvage this workflow run.");

    runCli(["init"], workspace.env);

    let startCalls = 0;
    const runner: CodexWorkflowRunner = {
      async startWorkflow(input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
        startCalls += 1;
        writeFileSync(
          input.queueItemPath,
          `${JSON.stringify({ fileId: input.queueItemId, threadId: "salvaged-thread" }, null, 2)}\n`,
          "utf8",
        );
        writeFileSync(
          input.resultPath,
          `${JSON.stringify(
            {
              status: "done",
              decision: "apply",
              reason: "Recovered the already-written result manifest.",
              threadId: "salvaged-thread",
              skillsUsed: ["tiangong-wiki-skill"],
              createdPageIds: ["methods/salvaged.md"],
              updatedPageIds: [],
              appliedTypeNames: ["method"],
              proposedTypes: [],
              actions: [
                {
                  kind: "create_page",
                  pageType: "method",
                  pageId: "methods/salvaged.md",
                  title: "Salvaged Workflow",
                  summary: "Recovered the page creation from result.json.",
                },
              ],
              lint: [{ pageId: "methods/salvaged.md", errors: 0, warnings: 0 }],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        throw new AppError("Codex workflow stream failed", "runtime", {
          cause: "stream closed after result.json was written",
        });
      },
      async resumeWorkflow(): Promise<CodexWorkflowHandle> {
        throw new Error("resumeWorkflow should not run during manifest salvage");
      },
      async collectResult(): Promise<WorkflowResultManifest> {
        throw new Error("collectResult should not run during manifest salvage");
      },
    };

    const logs: string[] = [];
    const result = await processVaultQueueBatch(workspace.env, {
      workflowRunner: runner,
      log: (message) => logs.push(message),
    });

    expect(result).toMatchObject({
      processed: 1,
      done: 1,
      errored: 0,
    });
    expect(startCalls).toBe(1);
    expect(logs.some((message) => message.includes("recovered persisted workflow result status=done"))).toBe(true);

    const queueRows = queryDb<Record<string, string | number | null>>(
      workspace,
      `
        SELECT
          file_id AS fileId,
          status,
          thread_id AS threadId,
          attempts,
          error_message AS errorMessage,
          result_page_id AS resultPageId
        FROM vault_processing_queue
        WHERE file_id = 'imports/salvage.pdf'
      `,
    );
    expect(queueRows).toEqual([
      expect.objectContaining({
        fileId: "imports/salvage.pdf",
        status: "done",
        threadId: "salvaged-thread",
        attempts: 0,
        errorMessage: null,
        resultPageId: "methods/salvaged.md",
      }),
    ]);
  });

  it("inline-retries runtime failures for real-workflow-like runners before marking queue errors", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/recoverable.pdf", "Recoverable workflow output.");

    runCli(["init"], workspace.env);

    const runnerCalls: Array<{ mode: "start" | "resume"; threadId: string }> = [];
    let collectCalls = 0;
    const runner: CodexWorkflowRunner = {
      inlineRetryCapable: true,
      async startWorkflow(_input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
        runnerCalls.push({ mode: "start", threadId: "recoverable-thread" });
        return { threadId: "recoverable-thread", mode: "start" };
      },
      async resumeWorkflow(threadId: string, _input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
        runnerCalls.push({ mode: "resume", threadId });
        return { threadId, mode: "resume" };
      },
      async collectResult(handle: CodexWorkflowHandle): Promise<WorkflowResultManifest> {
        collectCalls += 1;
        if (collectCalls === 1) {
          throw new AppError("Workflow result is not valid JSON", "runtime");
        }

        return {
          status: "done",
          decision: "apply",
          reason: "Recovered on inline retry.",
          threadId: handle.threadId,
          skillsUsed: ["tiangong-wiki-skill"],
          createdPageIds: ["methods/recoverable.md"],
          updatedPageIds: [],
          appliedTypeNames: ["method"],
          proposedTypes: [],
          actions: [
            {
              kind: "create_page",
              pageType: "method",
              pageId: "methods/recoverable.md",
              title: "Recoverable Workflow",
              summary: "Created the recovered page after an inline retry.",
            },
          ],
          lint: [{ pageId: "methods/recoverable.md", errors: 0, warnings: 0 }],
        };
      },
    };

    const logs: string[] = [];
    const result = await processVaultQueueBatch(workspace.env, {
      workflowRunner: runner,
      log: (message) => logs.push(message),
    });

    expect(result).toMatchObject({
      processed: 1,
      done: 1,
      errored: 0,
    });
    expect(runnerCalls).toEqual([
      { mode: "start", threadId: "recoverable-thread" },
      { mode: "resume", threadId: "recoverable-thread" },
    ]);
    expect(collectCalls).toBe(2);
    expect(logs.some((message) => message.includes("retrying workflow attempt 2/2"))).toBe(true);

    const queueRows = queryDb<Record<string, string | number | null>>(
      workspace,
      `
        SELECT
          file_id AS fileId,
          status,
          thread_id AS threadId,
          attempts,
          error_message AS errorMessage
        FROM vault_processing_queue
        WHERE file_id = 'imports/recoverable.pdf'
      `,
    );
    expect(queueRows).toEqual([
      expect.objectContaining({
        fileId: "imports/recoverable.pdf",
        status: "done",
        threadId: "recoverable-thread",
        attempts: 0,
        errorMessage: null,
      }),
    ]);
  });

  it("surfaces empty persisted result manifests distinctly from invalid JSON", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/empty-result.pdf", "Empty manifest.");

    runCli(["init"], workspace.env);

    const runner: CodexWorkflowRunner = {
      async startWorkflow(input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
        input.onThreadStarted?.("empty-thread");
        return { threadId: "empty-thread", mode: "start" };
      },
      async resumeWorkflow(): Promise<CodexWorkflowHandle> {
        throw new Error("resumeWorkflow should not run for a fresh item");
      },
      async collectResult(_handle: CodexWorkflowHandle, input: CodexWorkflowInput): Promise<WorkflowResultManifest> {
        return readWorkflowResult(input.resultPath);
      },
    };

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      processed: 1,
      done: 0,
      errored: 1,
      items: [
        expect.objectContaining({
          fileId: "imports/empty-result.pdf",
          status: "error",
          threadId: "empty-thread",
          reason: "Workflow result is empty",
        }),
      ],
    });
  });

  it("times out stuck workflow attempts, aborts the active run, and records timeout details", async () => {
    const workspace = createWorkspace(baseEnv({ WIKI_AGENT_BATCH_SIZE: "1", WIKI_WORKFLOW_TIMEOUT: "1" }));
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/stuck.pdf", "This workflow never finishes.");

    runCli(["init"], workspace.env);

    let abortReason: unknown = null;
    const runner: CodexWorkflowRunner = {
      async startWorkflow(input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
        input.onThreadStarted?.("stuck-thread");
        return await new Promise<CodexWorkflowHandle>((_, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              abortReason = input.signal?.reason ?? null;
              reject(input.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
      async resumeWorkflow(): Promise<CodexWorkflowHandle> {
        throw new Error("resumeWorkflow should not run for a fresh stuck item");
      },
      async collectResult(): Promise<WorkflowResultManifest> {
        throw new Error("collectResult should not run after a startWorkflow timeout");
      },
    };

    const logs: string[] = [];
    const result = await processVaultQueueBatch(workspace.env, {
      workflowRunner: runner,
      log: (message) => logs.push(message),
    });

    expect(result).toMatchObject({
      processed: 1,
      done: 0,
      skipped: 0,
      errored: 1,
      items: [
        expect.objectContaining({
          fileId: "imports/stuck.pdf",
          status: "error",
          threadId: "stuck-thread",
          reason: "Workflow startWorkflow timed out after 1s",
        }),
      ],
    });
    expect(abortReason).toBeInstanceOf(AppError);
    expect(logs).toEqual(
      expect.arrayContaining([
        "claimed 1 items: imports/stuck.pdf",
        expect.stringContaining("imports/stuck.pdf: start processing"),
        expect.stringContaining("imports/stuck.pdf: launching workflow mode=start attempt=1/1 timeout=1s"),
        expect.stringContaining("imports/stuck.pdf: workflow started mode=start attempt=1/1 thread=stuck-thread"),
        expect.stringContaining("imports/stuck.pdf: error thread=stuck-thread"),
      ]),
    );
    expect(logs.some((message) => message.includes("message=Workflow startWorkflow timed out after 1s"))).toBe(true);

    const queueRows = queryDb<Record<string, string | number | null>>(
      workspace,
      `
        SELECT
          file_id AS fileId,
          status,
          thread_id AS threadId,
          attempts,
          error_message AS errorMessage,
          last_error_at AS lastErrorAt,
          result_manifest_path AS resultManifestPath
        FROM vault_processing_queue
        WHERE file_id = 'imports/stuck.pdf'
      `,
    );
    expect(queueRows).toEqual([
      expect.objectContaining({
        fileId: "imports/stuck.pdf",
        status: "error",
        threadId: "stuck-thread",
        attempts: 1,
        errorMessage: "Workflow startWorkflow timed out after 1s",
      }),
    ]);
    expect(queueRows[0]?.lastErrorAt).toBeTruthy();
    expect(queueRows[0]?.resultManifestPath).toBeTruthy();
  });
});

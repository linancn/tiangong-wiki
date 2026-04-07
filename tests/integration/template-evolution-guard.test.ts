import { afterEach, describe, expect, it } from "vitest";

import { FakeCodexWorkflowRunner } from "../../src/core/codex-workflow.js";
import { processVaultQueueBatch } from "../../src/core/vault-processing.js";
import {
  cleanupWorkspace,
  createWorkspace,
  runCliJson,
  writeVaultFile,
} from "../helpers.js";

describe("template evolution guard", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("rejects create_template actions when guard is not enabled", async () => {
    const workspace = createWorkspace({
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_API_KEY: "test-agent-key",
      WIKI_AGENT_MODEL: "gpt-5.4",
      WIKI_AGENT_BACKEND: "codex-workflow",
      WIKI_AGENT_BATCH_SIZE: "10",
    });
    workspaces.push(workspace);

    runCliJson(["init"], workspace.env);
    writeVaultFile(workspace, "imports/lab-notes.md", "# Lab Notes\n\nNeed a richer experiment type.");
    runCliJson(["sync"], workspace.env);

    const runner = new FakeCodexWorkflowRunner(async ({ threadId }) => ({
      status: "done",
      decision: "apply",
      reason: "The workflow attempted to add a new lab-report template.",
      threadId,
      skillsUsed: ["wiki-skill"],
      createdPageIds: [],
      updatedPageIds: [],
      appliedTypeNames: ["lab-report"],
      proposedTypes: [],
      actions: [
        {
          kind: "create_template",
          pageType: "lab-report",
          title: "Lab Report",
          summary: "Create a new template for experiment-style notes.",
        },
      ],
      lint: [],
    }));

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      done: 0,
      errored: 1,
    });

    const queue = runCliJson<{
      items: Array<{ fileId: string; status: string; errorMessage: string | null }>;
    }>(["vault", "queue"], workspace.env);
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: "imports/lab-notes.md",
          status: "error",
          errorMessage: expect.stringContaining("Template evolution action is not allowed"),
        }),
      ]),
    );
  });

  it("allows create_template actions when apply mode is explicitly enabled", async () => {
    const workspace = createWorkspace({
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_API_KEY: "test-agent-key",
      WIKI_AGENT_MODEL: "gpt-5.4",
      WIKI_AGENT_BACKEND: "codex-workflow",
      WIKI_AGENT_BATCH_SIZE: "10",
      WIKI_AGENT_ALLOW_TEMPLATE_EVOLUTION: "true",
      WIKI_AGENT_TEMPLATE_EVOLUTION_MODE: "apply",
    });
    workspaces.push(workspace);

    runCliJson(["init"], workspace.env);
    writeVaultFile(workspace, "imports/lab-notes.md", "# Lab Notes\n\nNeed a richer experiment type.");
    runCliJson(["sync"], workspace.env);

    const runner = new FakeCodexWorkflowRunner(async ({ threadId, input }) => {
      runCliJson(["template", "create", "--type", "lab-report", "--title", "Lab Report"], input.env!);
      return {
        status: "done",
        decision: "apply",
        reason: "Created the template under explicit apply mode.",
        threadId,
        skillsUsed: ["wiki-skill"],
        createdPageIds: [],
        updatedPageIds: [],
        appliedTypeNames: ["lab-report"],
        proposedTypes: [],
        actions: [
          {
            kind: "create_template",
            pageType: "lab-report",
            title: "Lab Report",
            summary: "Create a new template for experiment-style notes.",
          },
        ],
        lint: [],
      };
    });

    const result = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(result).toMatchObject({
      done: 1,
      errored: 0,
    });

    const newType = runCliJson<{ pageType: string; file: string }>(
      ["type", "show", "lab-report", "--format", "json"],
      workspace.env,
    );
    expect(newType).toEqual(
      expect.objectContaining({
        pageType: "lab-report",
        file: "templates/lab-report.md",
      }),
    );
  });
});

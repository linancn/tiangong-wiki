import { afterEach, describe, expect, it } from "vitest";

import { FakeCodexWorkflowRunner } from "../../src/core/codex-workflow.js";
import { processVaultQueueBatch } from "../../src/core/vault-processing.js";
import {
  cleanupWorkspace,
  createWorkspace,
  runCli,
  runCliJson,
  writeVaultFile,
} from "../helpers.js";

describe("daemon workflow observability", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("surfaces codex workflow state in queue output and daemon-style logs", async () => {
    const workspace = createWorkspace({
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_API_KEY: "test-agent-key",
      WIKI_AGENT_MODEL: "gpt-5.4",
      WIKI_AGENT_BACKEND: "codex-workflow",
      WIKI_AGENT_BATCH_SIZE: "10",
    });
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/evidence-review.pdf", "Durable evidence review workflow.");
    runCli(["init"], workspace.env);

    const logs: string[] = [];
    const runner = new FakeCodexWorkflowRunner(({ threadId }) => ({
      status: "done",
      decision: "apply",
      reason: "Routed the source into the method ontology and proposed a new related type.",
      threadId,
      skillsUsed: ["wiki-skill", "pdf"],
      createdPageIds: ["methods/evidence-review.md"],
      updatedPageIds: ["concepts/evidence-ops.md"],
      appliedTypeNames: ["method", "concept"],
      proposedTypes: [
        {
          name: "evidence-brief",
          reason: "The corpus has recurring operational briefs that do not cleanly fit current types.",
          suggestedTemplateSections: ["## Summary", "## Evidence", "## Operational Guidance"],
        },
      ],
      actions: [
        {
          kind: "create_page",
          pageType: "method",
          pageId: "methods/evidence-review.md",
          title: "Evidence Review Workflow",
          summary: "Created a method page from the vault file.",
        },
        {
          kind: "update_page",
          pageType: "concept",
          pageId: "concepts/evidence-ops.md",
          summary: "Updated the existing concept with new evidence.",
        },
      ],
      lint: [
        { pageId: "methods/evidence-review.md", errors: 0, warnings: 0 },
        { pageId: "concepts/evidence-ops.md", errors: 0, warnings: 0 },
      ],
    }));

    const processed = await processVaultQueueBatch(workspace.env, {
      workflowRunner: runner,
      log: (message) => logs.push(message),
    });

    expect(processed.done).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("imports/evidence-review.pdf: done");
    expect(logs[0]).toContain("thread=fake-thread-1");
    expect(logs[0]).toContain("decision=apply");
    expect(logs[0]).toContain("skills=wiki-skill,pdf");
    expect(logs[0]).toContain("created=methods/evidence-review.md");
    expect(logs[0]).toContain("updated=concepts/evidence-ops.md");
    expect(logs[0]).toContain("proposed=evidence-brief");
    expect(logs[0]).toContain("result=");

    const queue = runCliJson<{
      items: Array<{
        fileId: string;
        status: string;
        threadId: string | null;
        decision: string | null;
        resultManifestPath: string | null;
        skillsUsed: string[];
        createdPageIds: string[];
        updatedPageIds: string[];
        proposedTypeNames: string[];
      }>;
    }>(["vault", "queue"], workspace.env);

    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: "imports/evidence-review.pdf",
          status: "done",
          threadId: "fake-thread-1",
          decision: "apply",
          skillsUsed: ["wiki-skill", "pdf"],
          createdPageIds: ["methods/evidence-review.md"],
          updatedPageIds: ["concepts/evidence-ops.md"],
          proposedTypeNames: ["evidence-brief"],
        }),
      ]),
    );

    const item = queue.items.find((entry) => entry.fileId === "imports/evidence-review.pdf");
    expect(item?.resultManifestPath).toContain("/wiki/.queue-artifacts/");
  });
});

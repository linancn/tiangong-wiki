import { afterEach, describe, expect, it } from "vitest";

import { FakeCodexWorkflowRunner } from "../../src/core/codex-workflow.js";
import { createPageFromTemplate, updatePageById } from "../../src/core/page-files.js";
import { loadRuntimeConfig } from "../../src/core/runtime.js";
import { syncWorkspace } from "../../src/core/sync.js";
import { processVaultQueueBatch } from "../../src/core/vault-processing.js";
import {
  cleanupWorkspace,
  createWorkspace,
  readPageMatter,
  runCliJson,
  writeVaultFile,
} from "../helpers.js";

describe("acceptance: decision + actions workflow", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("updates an existing method, creates a lesson, and avoids any default source-summary bias", async () => {
    const workspace = createWorkspace({
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_API_KEY: "test-agent-key",
      WIKI_AGENT_MODEL: "gpt-5.4",
      WIKI_AGENT_BACKEND: "codex-workflow",
      WIKI_AGENT_BATCH_SIZE: "10",
    });
    workspaces.push(workspace);

    runCliJson(["init"], workspace.env);

    const { paths, config } = loadRuntimeConfig(workspace.env);
    const methodPage = createPageFromTemplate(paths, config, {
      pageType: "method",
      title: "Evidence Review Workflow",
      nodeId: "evidence-review",
      frontmatterPatch: {
        status: "active",
        visibility: "shared",
        domain: "research",
        effectiveness: "medium",
        sourceRefs: [],
        relatedPages: [],
        tags: ["workflow"],
      },
      bodyMarkdown: [
        "## Summary",
        "",
        "A reusable method for reviewing evidence.",
        "",
        "## Steps",
        "",
        "- Review the source.",
      ].join("\n"),
    });
    await syncWorkspace({ targetPaths: [methodPage.pageId], env: workspace.env });

    writeVaultFile(
      workspace,
      "imports/evidence-review-notes.md",
      "# Evidence Review\n\nA repeatable workflow should also generate retrospective lessons.",
    );
    runCliJson(["sync"], workspace.env);

    const runner = new FakeCodexWorkflowRunner(async ({ threadId, input }) => {
      const runtime = loadRuntimeConfig(input.env);
      updatePageById(runtime.paths, methodPage.pageId, {
        frontmatterPatch: {
          effectiveness: "high",
          sourceRefs: ["vault/imports/evidence-review-notes.md"],
          tags: ["workflow", "evidence"],
        },
        bodyMarkdown: [
          "## Summary",
          "",
          "A reusable workflow for evidence review with stronger retrospective capture.",
          "",
          "## Steps",
          "",
          "- Review the source.",
          "- Capture durable lessons.",
        ].join("\n"),
      });

      const lessonPage = createPageFromTemplate(runtime.paths, runtime.config, {
        pageType: "lesson",
        title: "Retrospectives Belong Inside Evidence Review",
        frontmatterPatch: {
          status: "active",
          visibility: "shared",
          context: "knowledge-ingestion",
          severity: "medium",
          actionable: "yes",
          sourceRefs: ["vault/imports/evidence-review-notes.md"],
          relatedPages: [methodPage.pageId],
          tags: ["lesson", "evidence"],
        },
        bodyMarkdown: [
          "## Summary",
          "",
          "A lesson page distilled from the vault notes.",
          "",
          "## What Happened",
          "",
          "The source emphasized adding retrospective capture to the workflow.",
          "",
          "## Action",
          "",
          "- Keep lesson capture inside the method.",
        ].join("\n"),
      });

      await syncWorkspace({ targetPaths: [methodPage.pageId, lessonPage.pageId], env: input.env });

      return {
        status: "done",
        decision: "apply",
        reason: "Updated the existing method and created a connected lesson page.",
        threadId,
        skillsUsed: ["wiki-skill"],
        createdPageIds: [lessonPage.pageId],
        updatedPageIds: [methodPage.pageId],
        appliedTypeNames: ["method", "lesson"],
        proposedTypes: [],
        actions: [
          {
            kind: "update_page",
            pageId: methodPage.pageId,
            pageType: "method",
            summary: "Improved the workflow with retrospective capture.",
          },
          {
            kind: "create_page",
            pageId: lessonPage.pageId,
            pageType: "lesson",
            title: "Retrospectives Belong Inside Evidence Review",
            summary: "Created a lesson derived from the vault note.",
          },
        ],
        lint: [
          { pageId: methodPage.pageId, errors: 0, warnings: 0 },
          { pageId: lessonPage.pageId, errors: 0, warnings: 0 },
        ],
      };
    });

    const processed = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(processed).toMatchObject({
      done: 1,
      skipped: 0,
      errored: 0,
    });

    const method = readPageMatter(workspace, methodPage.pageId);
    expect(method.data.effectiveness).toBe("high");
    expect(method.data.sourceRefs).toEqual(["vault/imports/evidence-review-notes.md"]);
    expect(method.content).toContain("Capture durable lessons.");

    const lessons = runCliJson<Array<{ id: string; pageType: string }>>(
      ["find", "--type", "lesson"],
      workspace.env,
    );
    expect(lessons).toHaveLength(1);
    const lesson = readPageMatter(workspace, lessons[0].id);
    expect(lesson.data.relatedPages).toEqual([methodPage.pageId]);

    const sourceSummaries = runCliJson<Array<{ id: string }>>(["find", "--type", "source-summary"], workspace.env);
    expect(sourceSummaries).toHaveLength(0);

    const queue = runCliJson<{
      items: Array<{
        fileId: string;
        status: string;
        decision?: string | null;
        createdPageIds?: string[];
        updatedPageIds?: string[];
      }>;
    }>(["vault", "queue"], workspace.env);
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: "imports/evidence-review-notes.md",
          status: "done",
        }),
      ]),
    );

    const lint = runCliJson<{ errors: Array<unknown> }>(["lint", "--format", "json"], workspace.env);
    expect(lint.errors).toHaveLength(0);
  });
});

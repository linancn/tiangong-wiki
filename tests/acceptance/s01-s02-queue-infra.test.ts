import { afterEach, describe, expect, it } from "vitest";

import { FakeCodexWorkflowRunner } from "../../src/core/codex-workflow.js";
import { createPageFromTemplate } from "../../src/core/page-files.js";
import { loadRuntimeConfig } from "../../src/core/runtime.js";
import { syncWorkspace } from "../../src/core/sync.js";
import { processVaultQueueBatch } from "../../src/core/vault-processing.js";
import {
  cleanupWorkspace,
  createWorkspace,
  readPageMatter,
  runCli,
  runCliJson,
  writeVaultFile,
} from "../helpers.js";

function makeSummaryBody(fileId: string, extractedText: string): string {
  return [
    "## 来源信息",
    "",
    `这份来源文件是 \`${fileId}\`。`,
    "",
    "## 核心内容",
    "",
    extractedText,
    "",
    "## 关键结论",
    "",
    `- Durable takeaway from ${fileId}`,
    "",
    "## 与已有知识的关系",
    "",
    "这份来源可以作为后续知识页的证据。",
    "",
    "## 重要引用",
    "",
    extractedText,
  ].join("\n");
}

async function createSummaryFromVaultFile(
  env: NodeJS.ProcessEnv,
  title: string,
  fileId: string,
  sourceType: string | null,
  extractedText: string,
): Promise<string> {
  const runtime = loadRuntimeConfig(env);
  const created = createPageFromTemplate(runtime.paths, runtime.config, {
    pageType: "source-summary",
    title,
    frontmatterPatch: {
      status: "active",
      visibility: "shared",
      sourceType: sourceType ?? "file",
      vaultPath: fileId,
      keyFindings: [`Durable takeaway from ${fileId}`],
      sourceRefs: [`vault/${fileId}`],
      relatedPages: [],
      tags: ["imported-source"],
    },
    bodyMarkdown: makeSummaryBody(fileId, extractedText),
  });
  await syncWorkspace({ targetPaths: [created.pageId], env });
  return created.pageId;
}

function baseEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    WIKI_AGENT_ENABLED: "true",
    WIKI_AGENT_API_KEY: "test-agent-key",
    WIKI_AGENT_MODEL: "gpt-5.4",
    WIKI_AGENT_BATCH_SIZE: "10",
    ...extraEnv,
  };
}

describe("acceptance: queue infrastructure", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("fills the queue on init and processes supported files through workflow-selected pages", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/paper.pdf", "Bayes theorem improves decision quality with evidence.");
    writeVaultFile(workspace, "imports/brief.docx", "Product brief with three decision principles.");
    writeVaultFile(workspace, "imports/slides.pptx", "Slide deck about probabilistic reasoning.");
    writeVaultFile(workspace, "imports/metrics.xlsx", "Quarterly metrics and key variances.");
    writeVaultFile(workspace, "imports/notes.md", "# Notes\n\nBridge probability to product decisions.");
    writeVaultFile(workspace, "imports/diagram.png", "binary image placeholder");

    const initResult = runCliJson<{ initialized: boolean; backgroundQueueProcessingStarted: boolean }>(
      ["init"],
      workspace.env,
    );
    expect(initResult.initialized).toBe(true);
    expect(initResult.backgroundQueueProcessingStarted).toBe(false);

    const initialQueue = runCliJson<{
      totalPending: number;
      items: Array<{ fileId: string; status: string }>;
    }>(["vault", "queue"], workspace.env);
    expect(initialQueue.totalPending).toBe(6);
    expect(initialQueue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: "imports/paper.pdf", status: "pending" }),
        expect.objectContaining({ fileId: "imports/diagram.png", status: "pending" }),
      ]),
    );

    const runner = new FakeCodexWorkflowRunner(async ({ queueItemId, threadId }) => {
      if (queueItemId.endsWith(".png")) {
        return {
          status: "skipped",
          decision: "skip",
          reason: "Image-only file is not worth ingesting without dedicated OCR skills.",
          threadId,
          skillsUsed: ["wiki-skill"],
          createdPageIds: [],
          updatedPageIds: [],
          appliedTypeNames: [],
          proposedTypes: [],
          actions: [],
          lint: [],
        };
      }

      const rawTitle = queueItemId.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "source";
      const pageId = await createSummaryFromVaultFile(
        workspace.env,
        rawTitle.replace(/[-_]+/g, " "),
        queueItemId,
        queueItemId.split(".").pop() ?? null,
        `Imported durable content from ${queueItemId}.`,
      );

      return {
        status: "done",
        decision: "apply",
        reason: "Captured the durable source as a reusable page.",
        threadId,
        skillsUsed: ["wiki-skill"],
        createdPageIds: [pageId],
        updatedPageIds: [],
        appliedTypeNames: ["source-summary"],
        proposedTypes: [],
        actions: [
          {
            kind: "create_page",
            pageType: "source-summary",
            pageId,
            title: rawTitle.replace(/[-_]+/g, " "),
            summary: "Created a reusable source page from the vault file.",
          },
        ],
        lint: [{ pageId, errors: 0, warnings: 0 }],
      };
    });

    const processed = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(processed.done).toBe(5);
    expect(processed.skipped).toBe(1);
    expect(processed.errored).toBe(0);

    const queue = runCliJson<{
      totalPending: number;
      totalDone: number;
      totalSkipped: number;
      items: Array<{ fileId: string; status: string; decision: string | null; threadId: string | null }>;
    }>(["vault", "queue"], workspace.env);
    expect(queue.totalPending).toBe(0);
    expect(queue.totalDone).toBe(5);
    expect(queue.totalSkipped).toBe(1);
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: "imports/paper.pdf", status: "done", decision: "apply" }),
        expect.objectContaining({ fileId: "imports/diagram.png", status: "skipped", decision: "skip" }),
      ]),
    );
    expect(queue.items.filter((item) => item.status === "done").every((item) => Boolean(item.threadId))).toBe(true);

    const sourceSummaries = runCliJson<Array<{ id: string; pageType: string }>>(
      ["find", "--type", "source-summary"],
      workspace.env,
    );
    expect(sourceSummaries).toHaveLength(5);

    const pageInfo = runCliJson<Record<string, unknown>>(["page-info", sourceSummaries[0].id], workspace.env);
    expect(pageInfo.sourceType).toBeTruthy();
    expect(pageInfo.vaultPath).toBeTruthy();

    const lint = runCliJson<{ errors: Array<unknown> }>(["lint", "--format", "json"], workspace.env);
    expect(lint.errors).toHaveLength(0);
  });

  it("retries queue errors and honors batch size limits", async () => {
    const workspace = createWorkspace(baseEnv({ WIKI_AGENT_BATCH_SIZE: "1" }));
    workspaces.push(workspace);

    const initResult = runCliJson<{ initialized: boolean; backgroundQueueProcessingStarted: boolean }>(
      ["init"],
      workspace.env,
    );
    expect(initResult.initialized).toBe(true);
    expect(initResult.backgroundQueueProcessingStarted).toBe(false);

    writeVaultFile(workspace, "imports/retry.pdf", "Retry me on the first queue cycle.");
    writeVaultFile(workspace, "imports/stable.txt", "Stable file should remain pending until its turn.");

    const syncResult = runCliJson<{ vault: { changes: number } }>(["sync"], workspace.env);
    expect(syncResult.vault.changes).toBe(2);

    const callCounts = new Map<string, number>();
    const runner = new FakeCodexWorkflowRunner(async ({ queueItemId, threadId }) => {
      const calls = (callCounts.get(queueItemId) ?? 0) + 1;
      callCounts.set(queueItemId, calls);
      if (queueItemId.endsWith("retry.pdf") && calls === 1) {
        throw new Error("simulated first attempt failure");
      }

      const pageId = await createSummaryFromVaultFile(
        workspace.env,
        queueItemId.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "source",
        queueItemId,
        queueItemId.split(".").pop() ?? null,
        `Processed queue item ${queueItemId}.`,
      );

      return {
        status: "done",
        decision: "apply",
        reason: "Queue item processed successfully.",
        threadId,
        skillsUsed: ["wiki-skill"],
        createdPageIds: [pageId],
        updatedPageIds: [],
        appliedTypeNames: ["source-summary"],
        proposedTypes: [],
        actions: [
          {
            kind: "create_page",
            pageType: "source-summary",
            pageId,
            title: queueItemId,
            summary: "Created a source page from the queue item.",
          },
        ],
        lint: [{ pageId, errors: 0, warnings: 0 }],
      };
    });

    await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    const afterFirstRun = runCliJson<{
      totalPending: number;
      totalError: number;
      items: Array<{ fileId: string; status: string; attempts: number }>;
    }>(["vault", "queue"], workspace.env);
    expect(afterFirstRun.totalError).toBe(1);
    expect(afterFirstRun.totalPending).toBe(1);
    expect(afterFirstRun.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: "imports/retry.pdf", status: "error", attempts: 1 }),
        expect.objectContaining({ fileId: "imports/stable.txt", status: "pending" }),
      ]),
    );

    await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    const afterSecondRun = runCliJson<{ totalDone: number; totalPending: number }>(
      ["vault", "queue"],
      workspace.env,
    );
    expect(afterSecondRun.totalDone).toBe(1);
    expect(afterSecondRun.totalPending).toBe(1);

    await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    const finalQueue = runCliJson<{ totalDone: number; totalPending: number; totalError: number }>(
      ["vault", "queue"],
      workspace.env,
    );
    expect(finalQueue.totalDone).toBe(2);
    expect(finalQueue.totalPending).toBe(0);
    expect(finalQueue.totalError).toBe(0);
  });

  it("allows the workflow to choose non-source-summary page types for vault files", async () => {
    const workspace = createWorkspace(baseEnv());
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/paper.pdf", "Short but durable paper about evidence-linked summaries.");
    writeVaultFile(workspace, "imports/team-deck-a.pptx", "Slide deck A outlines a reusable wiki ingestion workflow.");

    const initResult = runCliJson<{ initialized: boolean; backgroundQueueProcessingStarted: boolean }>(
      ["init"],
      workspace.env,
    );
    expect(initResult.initialized).toBe(true);
    expect(initResult.backgroundQueueProcessingStarted).toBe(false);

    const runner = new FakeCodexWorkflowRunner(async ({ queueItemId, threadId }) => {
      const runtime = loadRuntimeConfig(workspace.env);
      if (queueItemId.endsWith("team-deck-a.pptx")) {
        const created = createPageFromTemplate(runtime.paths, runtime.config, {
          pageType: "method",
          title: "Team Deck A: Wiki Ingestion Workflow",
          frontmatterPatch: {
            status: "active",
            visibility: "shared",
            domain: "research",
            effectiveness: "medium",
            sourceRefs: [`vault/${queueItemId}`],
            relatedPages: [],
            tags: ["slides", "workflow"],
          },
          bodyMarkdown: [
            "## Summary",
            "",
            "A reusable workflow for importing evidence into the wiki.",
            "",
            "## Steps",
            "",
            "- Review the source.",
            "- Route it into the current ontology.",
          ].join("\n"),
        });
        await syncWorkspace({ targetPaths: [created.pageId], env: workspace.env });
        return {
          status: "done",
          decision: "apply",
          reason: "The slide deck describes a repeatable workflow, so method is the better fit.",
          threadId,
          skillsUsed: ["wiki-skill", "slides"],
          createdPageIds: [created.pageId],
          updatedPageIds: [],
          appliedTypeNames: ["method"],
          proposedTypes: [],
          actions: [
            {
              kind: "create_page",
              pageType: "method",
              pageId: created.pageId,
              title: "Team Deck A: Wiki Ingestion Workflow",
              summary: "Created a method page from the deck.",
            },
          ],
          lint: [{ pageId: created.pageId, errors: 0, warnings: 0 }],
        };
      }

      const pageId = await createSummaryFromVaultFile(
        workspace.env,
        "paper",
        queueItemId,
        "pdf",
        "Short but durable paper about evidence-linked summaries.",
      );
      return {
        status: "done",
        decision: "apply",
        reason: "The paper is best preserved as a source-centric page.",
        threadId,
        skillsUsed: ["wiki-skill", "pdf"],
        createdPageIds: [pageId],
        updatedPageIds: [],
        appliedTypeNames: ["source-summary"],
        proposedTypes: [],
        actions: [
          {
            kind: "create_page",
            pageType: "source-summary",
            pageId,
            title: "paper",
            summary: "Created a source-summary page from the paper.",
          },
        ],
        lint: [{ pageId, errors: 0, warnings: 0 }],
      };
    });

    const processed = await processVaultQueueBatch(workspace.env, { workflowRunner: runner });
    expect(processed.done).toBe(2);
    expect(processed.skipped).toBe(0);
    expect(processed.errored).toBe(0);

    const methods = runCliJson<Array<{ id: string }>>(["find", "--type", "method"], workspace.env);
    expect(methods).toHaveLength(1);
    const sourceSummaries = runCliJson<Array<{ id: string }>>(["find", "--type", "source-summary"], workspace.env);
    expect(sourceSummaries).toHaveLength(1);

    const queue = runCliJson<{
      items: Array<{ fileId: string; appliedTypeNames: string[]; resultPageId: string | null }>;
    }>(["vault", "queue"], workspace.env);
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: "imports/paper.pdf", appliedTypeNames: ["source-summary"] }),
        expect.objectContaining({ fileId: "imports/team-deck-a.pptx", appliedTypeNames: ["method"] }),
      ]),
    );

    const method = readPageMatter(workspace, methods[0].id);
    expect(method.content).toContain("Route it into the current ontology.");
  });
});

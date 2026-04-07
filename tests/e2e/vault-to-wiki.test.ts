import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupWorkspace,
  createWorkspace,
  readFile,
  runCliJson,
  writePage,
  writeVaultFile,
} from "../helpers.js";

const hasRealAgentConfig = Boolean(process.env.WIKI_AGENT_API_KEY && process.env.WIKI_AGENT_MODEL);
const describeIfConfigured = hasRealAgentConfig ? describe : describe.skip;

describeIfConfigured("e2e: vault to wiki with real Codex workflow", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("processes a durable vault file with live workflow artifacts and no legacy source-summary assumption", () => {
    const workspace = createWorkspace({
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_API_KEY: process.env.WIKI_AGENT_API_KEY,
      WIKI_AGENT_MODEL: process.env.WIKI_AGENT_MODEL,
      WIKI_AGENT_BATCH_SIZE: "10",
      ...(process.env.WIKI_AGENT_BASE_URL ? { WIKI_AGENT_BASE_URL: process.env.WIKI_AGENT_BASE_URL } : {}),
    });
    workspaces.push(workspace);

    writePage(
      workspace,
      "methods/evidence-review-workflow.md",
      `---
pageType: method
title: Evidence Review Workflow
nodeId: evidence-review-workflow
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - workflow
domain: research
effectiveness: medium
---

## Summary

A reusable workflow for reviewing evidence before updating durable knowledge.

## Steps

- Review the source.
- Capture the durable insight.
`,
    );

    writeVaultFile(
      workspace,
      "imports/evidence-review-notes.md",
      `# Evidence Review Workflow Revision

This note revises the existing "Evidence Review Workflow" method.

It adds three durable rules:

1. Always capture retrospective lessons after the initial evidence review.
2. Preserve provenance with explicit source references.
3. Route new knowledge through the current wiki ontology instead of defaulting to one page type.

This file should either update the existing method page or create a closely related durable page under an existing type.
`,
    );
    writeVaultFile(workspace, "imports/noise.png", "binary-image-placeholder");

    const env = workspace.env;

    const init = runCliJson<{ initialized: boolean }>(["init"], env);
    expect(init.initialized).toBe(true);

    const initialQueue = runCliJson<{
      totalPending: number;
      items: Array<{ fileId: string; status: string }>;
    }>(["vault", "queue"], env);
    expect(initialQueue.totalPending).toBe(2);

    const processed = runCliJson<{
      processed: number;
      done: number;
      skipped: number;
      errored: number;
      items: Array<{ fileId: string; status: string; decision?: string | null }>;
    }>(["process-vault-queue"], env);
    expect(processed.processed).toBe(2);
    expect(processed.errored).toBe(0);

    const queue = runCliJson<{
      items: Array<{
        fileId: string;
        status: string;
        decision: string | null;
        threadId: string | null;
        resultManifestPath: string | null;
        createdPageIds: string[];
        updatedPageIds: string[];
        resultPageId: string | null;
      }>;
    }>(["vault", "queue"], env);

    const durableItem = queue.items.find((item) => item.fileId === "imports/evidence-review-notes.md");
    expect(durableItem).toBeTruthy();
    expect(durableItem?.status).toBe("done");
    expect(durableItem?.decision).not.toBe("skip");
    expect(durableItem?.threadId).toBeTruthy();
    expect(durableItem?.resultManifestPath).toBeTruthy();

    const manifest = JSON.parse(readFile(durableItem!.resultManifestPath!)) as {
      status: string;
      decision: string;
      threadId: string;
      createdPageIds: string[];
      updatedPageIds: string[];
      actions: Array<unknown>;
      proposedTypes: Array<unknown>;
    };
    expect(manifest.threadId).toBe(durableItem?.threadId);
    expect(manifest.status).toBe("done");
    expect(manifest.decision === "apply" || manifest.decision === "propose_only").toBe(true);
    if (manifest.decision === "apply") {
      expect(manifest.actions.length).toBeGreaterThan(0);
      expect(manifest.createdPageIds.length + manifest.updatedPageIds.length).toBeGreaterThan(0);
    } else {
      expect(manifest.proposedTypes.length).toBeGreaterThan(0);
    }

    for (const pageId of [...manifest.createdPageIds, ...manifest.updatedPageIds]) {
      const info = runCliJson<Record<string, unknown>>(["page-info", pageId], env);
      expect(info.id).toBe(pageId);
    }

    const noiseItem = queue.items.find((item) => item.fileId === "imports/noise.png");
    expect(noiseItem).toBeTruthy();
    expect(noiseItem?.status).not.toBe("error");

    const lint = runCliJson<{ errors: Array<unknown> }>(["lint", "--format", "json"], env);
    expect(lint.errors).toHaveLength(0);
  });
});

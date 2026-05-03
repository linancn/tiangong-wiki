import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupWorkspace,
  createWorkspace,
  readFile,
  runCliJson,
  writePage,
  writeVaultFile,
} from "../helpers.js";

const agentAuthMode = process.env.WIKI_AGENT_AUTH_MODE === "codex-login" ? "codex-login" : "api-key";
const hasRealAgentConfig = agentAuthMode === "codex-login" || Boolean(process.env.WIKI_AGENT_API_KEY);
const describeIfConfigured = hasRealAgentConfig ? describe : describe.skip;

describeIfConfigured("e2e: vault type routing with live Codex workflow", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("routes a workflow revision into the existing ontology without relying on source-summary as the only target", () => {
    const workspace = createWorkspace({
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_AUTH_MODE: agentAuthMode,
      WIKI_AGENT_MODEL: process.env.WIKI_AGENT_MODEL ?? "gpt-5.5",
      WIKI_AGENT_BATCH_SIZE: "10",
      ...(agentAuthMode === "api-key" ? { WIKI_AGENT_API_KEY: process.env.WIKI_AGENT_API_KEY } : {}),
      ...(agentAuthMode === "codex-login" && process.env.WIKI_AGENT_CODEX_HOME
        ? { WIKI_AGENT_CODEX_HOME: process.env.WIKI_AGENT_CODEX_HOME }
        : {}),
      ...(agentAuthMode === "api-key" && process.env.WIKI_AGENT_BASE_URL
        ? { WIKI_AGENT_BASE_URL: process.env.WIKI_AGENT_BASE_URL }
        : {}),
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

A reusable workflow for reviewing evidence.

## Steps

- Review the source.
`,
    );

    writeVaultFile(
      workspace,
      "imports/evidence-review-revision.md",
      `# Revision for Evidence Review Workflow

This document is not just a source digest.
It specifically revises the existing "Evidence Review Workflow" method by adding:

- a retrospective capture step
- an evidence-to-ontology routing checkpoint
- explicit provenance requirements for future updates

Use the current ontology and existing pages to decide the best action.
`,
    );

    const env = workspace.env;
    runCliJson(["init"], env);

    const processed = runCliJson<{
      errored: number;
      items: Array<{ fileId: string; status: string }>;
    }>(["process-vault-queue"], env);
    expect(processed.errored).toBe(0);

    const queue = runCliJson<{
      items: Array<{
        fileId: string;
        status: string;
        decision: string | null;
        threadId: string | null;
        resultManifestPath: string | null;
        appliedTypeNames: string[];
        createdPageIds: string[];
        updatedPageIds: string[];
      }>;
    }>(["vault", "queue"], env);

    const item = queue.items.find((entry) => entry.fileId === "imports/evidence-review-revision.md");
    expect(item).toBeTruthy();
    expect(item?.status).toBe("done");
    expect(item?.decision).not.toBe("skip");
    expect(item?.threadId).toBeTruthy();
    expect(item?.resultManifestPath).toBeTruthy();

    const manifest = JSON.parse(readFile(item!.resultManifestPath!)) as {
      decision: string;
      appliedTypeNames: string[];
      createdPageIds: string[];
      updatedPageIds: string[];
      proposedTypes: Array<unknown>;
    };
    expect(manifest.decision === "apply" || manifest.decision === "propose_only").toBe(true);

    if (manifest.decision === "apply") {
      expect(manifest.appliedTypeNames.length).toBeGreaterThan(0);
      expect(manifest.createdPageIds.length + manifest.updatedPageIds.length).toBeGreaterThan(0);
      expect(
        manifest.appliedTypeNames.length === 1 && manifest.appliedTypeNames[0] === "source-summary",
      ).toBe(false);
    } else {
      expect(manifest.proposedTypes.length).toBeGreaterThan(0);
    }
  });
});

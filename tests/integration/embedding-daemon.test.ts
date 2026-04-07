import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  readJson,
  runCli,
  startEmbeddingServer,
  waitFor,
  writePage,
} from "../helpers.js";

describe("embedding and daemon integration", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("supports background embedding on init, semantic search, profile drift protection, and daemon lifecycle", async () => {
    const server = await startEmbeddingServer(4);
    servers.push(server);

    const workspace = createWorkspace({
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "test-embedding",
      EMBEDDING_DIMENSIONS: "4",
      WIKI_SYNC_INTERVAL: "1",
    });
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writePage(
      workspace,
      "concepts/active-inference.md",
      `---
pageType: concept
title: Active Inference
nodeId: active-inference
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - inference
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Active inference links prediction, action, and uncertainty reduction.
`,
    );

    const initOutput = readJson<{ backgroundEmbeddingStarted: boolean }>(
      runCli(["init"], workspace.env).stdout,
    );
    expect(initOutput.backgroundEmbeddingStarted).toBe(true);

    await waitFor(() => {
      const stat = readJson<{ embeddingStatus: Record<string, number> }>(runCli(["stat"], workspace.env).stdout);
      return (stat.embeddingStatus.done ?? 0) >= 1;
    });

    const searchResult = readJson<Array<{ id: string; similarity: number }>>(
      runCli(["search", "uncertainty reduction"], workspace.env).stdout,
    );
    expect(searchResult[0]?.id).toBe("concepts/active-inference.md");
    expect(searchResult[0]?.similarity).toBeGreaterThan(0);

    const profileDrift = runCli(["sync", "--skip-embedding"], { ...workspace.env, EMBEDDING_DIMENSIONS: "8" }, { allowFailure: true });
    expect(profileDrift.status).toBe(2);
    expect(profileDrift.stderr).toContain("Embedding profile changed");

    const startDaemon = readJson<{ status: string; pid: number }>(
      runCli(["daemon", "start"], workspace.env).stdout,
    );
    expect(startDaemon.status).toBe("started");

    await waitFor(() => {
      const status = readJson<{ running: boolean }>(
        runCli(["daemon", "status", "--format", "json"], workspace.env).stdout,
      );
      return status.running;
    });

    const stopDaemon = readJson<{ status: string }>(runCli(["daemon", "stop"], workspace.env).stdout);
    expect(stopDaemon.status).toBe("stopping");
  });
});

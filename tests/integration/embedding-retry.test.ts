import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  readMeta,
  runCliJson,
  startEmbeddingServer,
  writePage,
} from "../helpers.js";

describe("embedding retry behavior", () => {
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

  it("retries failed embedding batches on the next sync and only writes the profile after success", async () => {
    const server = await startEmbeddingServer({
      dimensions: 4,
      handler: (payload, state) => {
        if (state.requestCount <= 3) {
          throw new Error("simulated first batch failure");
        }

        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        return {
          data: inputs.map((input: string, index: number) => ({
            index,
            embedding: Array.from({ length: 4 }, (_, offset) => {
              const seed = [...String(input)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
              return Number(((seed + offset + 1) / 1000).toFixed(6));
            }),
          })),
        };
      },
    });
    servers.push(server);

    const workspace = createWorkspace({
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "flaky-model",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    for (let index = 1; index <= 60; index += 1) {
      const suffix = String(index).padStart(2, "0");
      writePage(
        workspace,
        `concepts/retry-${suffix}.md`,
        `---
pageType: concept
title: Retry ${suffix}
nodeId: retry-${suffix}
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - retry
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Retry page ${suffix} captures an embedding retry scenario.
`,
      );
    }

    const firstSync = runCliJson<{
      embedding: { attempted: number; succeeded: number; failed: number };
    }>(["sync"], workspace.env);
    expect(firstSync.embedding.attempted).toBe(60);
    expect(firstSync.embedding.succeeded).toBe(10);
    expect(firstSync.embedding.failed).toBe(50);
    expect(readMeta(workspace, "embedding_profile")).toBeNull();

    const afterFirst = queryDb<{ embeddingStatus: string; count: number }>(
      workspace,
      "SELECT embedding_status AS embeddingStatus, COUNT(*) AS count FROM pages GROUP BY embedding_status ORDER BY embedding_status",
    );
    expect(afterFirst).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ embeddingStatus: "done", count: 10 }),
        expect.objectContaining({ embeddingStatus: "error", count: 50 }),
      ]),
    );

    const secondSync = runCliJson<{
      embedding: { attempted: number; succeeded: number; failed: number };
    }>(["sync"], workspace.env);
    expect(secondSync.embedding.attempted).toBe(50);
    expect(secondSync.embedding.succeeded).toBe(50);
    expect(secondSync.embedding.failed).toBe(0);
    expect(readMeta(workspace, "embedding_profile")).toBeTruthy();

    const stat = runCliJson<{ embeddingStatus: Record<string, number> }>(["stat"], workspace.env);
    expect(stat.embeddingStatus.done).toBe(60);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/core/config.js";
import { openDb, setMeta } from "../../src/core/db.js";
import { EmbeddingClient } from "../../src/core/embedding.js";
import { resolveRuntimePaths } from "../../src/core/paths.js";
import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  dbScalar,
  readMeta,
  runCli,
  runCliJson,
  startEmbeddingServer,
  writePage,
} from "../helpers.js";

function seedConceptPages(workspace: ReturnType<typeof createWorkspace>, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    const suffix = String(index).padStart(2, "0");
    writePage(
      workspace,
      `concepts/concept-${suffix}.md`,
      `---
pageType: concept
title: Concept ${suffix}
nodeId: concept-${suffix}
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - embedding
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Concept ${suffix} discusses uncertainty reduction and evidence updates.
`,
    );
  }
}

describe("embedding profile behavior", () => {
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

  it("rebuilds all vectors when the embedding profile changes", async () => {
    const serverA = await startEmbeddingServer(4);
    const serverB = await startEmbeddingServer(4);
    servers.push(serverA, serverB);

    const workspace = createWorkspace({
      EMBEDDING_BASE_URL: serverA.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "model-a",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    seedConceptPages(workspace, 3);

    const firstSync = runCliJson<{ embedding: { attempted: number; succeeded: number } }>(
      ["sync"],
      workspace.env,
    );
    expect(firstSync.embedding.attempted).toBe(3);
    expect(firstSync.embedding.succeeded).toBe(3);

    const firstProfile = readMeta(workspace, "embedding_profile");
    expect(firstProfile).toBeTruthy();

    const secondEnv = {
      ...workspace.env,
      EMBEDDING_BASE_URL: serverB.url,
      EMBEDDING_MODEL: "model-b",
    };
    const secondSync = runCliJson<{
      profileChanged: boolean;
      embedding: { embedAll: boolean; attempted: number; succeeded: number };
    }>(["sync"], secondEnv);

    expect(secondSync.profileChanged).toBe(true);
    expect(secondSync.embedding.embedAll).toBe(true);
    expect(secondSync.embedding.attempted).toBe(3);
    expect(secondSync.embedding.succeeded).toBe(3);

    const secondProfile = readMeta(workspace, "embedding_profile");
    expect(secondProfile).toBeTruthy();
    expect(secondProfile).not.toBe(firstProfile);
    expect(dbScalar<number>(workspace, "SELECT COUNT(*) FROM vec_pages")).toBe(3);

    const stat = runCliJson<{ embeddingStatus: Record<string, number> }>(["stat"], secondEnv);
    expect(stat.embeddingStatus.done).toBe(3);
  });

  it("rejects --skip-embedding when the embedding profile changed and leaves vectors untouched", async () => {
    const server = await startEmbeddingServer(4);
    servers.push(server);

    const workspace = createWorkspace({
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "model-a",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    seedConceptPages(workspace, 2);

    runCliJson(["sync"], workspace.env);

    const beforeProfile = readMeta(workspace, "embedding_profile");
    const beforeLastSync = readMeta(workspace, "last_sync_at");
    const beforeVecCount = dbScalar<number>(workspace, "SELECT COUNT(*) FROM vec_pages");

    const result = runCli(
      ["sync", "--skip-embedding"],
      {
        ...workspace.env,
        EMBEDDING_MODEL: "model-b",
      },
      { allowFailure: true },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Embedding profile changed, cannot skip embedding.");
    expect(readMeta(workspace, "embedding_profile")).toBe(beforeProfile);
    expect(readMeta(workspace, "last_sync_at")).toBe(beforeLastSync);
    expect(dbScalar<number>(workspace, "SELECT COUNT(*) FROM vec_pages")).toBe(beforeVecCount);
  });

  it("accepts larger returned embedding vectors by truncating them to the configured dimensions", async () => {
    const server = await startEmbeddingServer({
      dimensions: 6,
      handler: (payload) => {
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        return {
          data: inputs.map((input: string, index: number) => {
            const seed = [...String(input)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
            return {
              index,
              embedding: Array.from({ length: 6 }, (_, offset) => Number(((seed + offset + 1) / 1000).toFixed(6))),
            };
          }),
        };
      },
    });
    servers.push(server);

    const workspace = createWorkspace({
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "oversized-model",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    seedConceptPages(workspace, 2);

    const sync = runCliJson<{ embedding: { succeeded: number; failed: number } }>(["sync"], workspace.env);
    expect(sync.embedding.succeeded).toBe(2);
    expect(sync.embedding.failed).toBe(0);
    expect(dbScalar<number>(workspace, "SELECT COUNT(*) FROM vec_pages")).toBe(2);
  });

  it("rebuilds stale vector tables when stored embedding profile matches the current env", async () => {
    const server = await startEmbeddingServer(4);
    servers.push(server);

    const workspace = createWorkspace({
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "model-a",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    seedConceptPages(workspace, 2);

    const runtimePaths = resolveRuntimePaths(workspace.env);
    const config = loadConfig(runtimePaths.configPath);
    const { db } = openDb(runtimePaths.dbPath, config, 2);
    try {
      setMeta(db, "embedding_profile", EmbeddingClient.fromEnv(workspace.env)!.profileHash);
    } finally {
      db.close();
    }

    const searchBeforeRepair = runCli(["search", "uncertainty reduction"], workspace.env, { allowFailure: true });
    expect(searchBeforeRepair.status).toBe(2);
    expect(`${searchBeforeRepair.stdout}\n${searchBeforeRepair.stderr}`).toContain(
      "run tiangong-wiki sync to rebuild vectors",
    );

    const sync = runCliJson<{ profileChanged: boolean; embedding: { embedAll: boolean; succeeded: number } }>(
      ["sync"],
      workspace.env,
    );
    expect(sync.profileChanged).toBe(true);
    expect(sync.embedding.embedAll).toBe(true);
    expect(sync.embedding.succeeded).toBe(2);
    expect(dbScalar<string>(workspace, "SELECT sql FROM sqlite_master WHERE name = 'vec_pages'")).toContain("float[4]");

    const searchAfterRepair = runCliJson<Array<{ id: string }>>(["search", "uncertainty reduction"], workspace.env);
    expect(searchAfterRepair[0]?.id).toBe("concepts/concept-01.md");
  });
});

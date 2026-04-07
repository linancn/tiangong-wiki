import { afterEach, describe, expect, it } from "vitest";

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

describe("acceptance: S9 embedding switch", () => {
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

  it("rebuilds vectors when the embedding model changes and rejects skip-embedding during drift", async () => {
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

    for (let index = 1; index <= 10; index += 1) {
      const suffix = String(index).padStart(2, "0");
      writePage(
        workspace,
        `concepts/model-${suffix}.md`,
        `---
pageType: concept
title: Model ${suffix}
nodeId: model-${suffix}
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

Model ${suffix} discusses semantic search behavior and retrieval.
`,
      );
    }

    runCliJson(["sync"], workspace.env);

    const switched = runCliJson<{
      profileChanged: boolean;
      embedding: { embedAll: boolean };
    }>(["sync"], { ...workspace.env, EMBEDDING_BASE_URL: serverB.url, EMBEDDING_MODEL: "model-b" });
    expect(switched.profileChanged).toBe(true);
    expect(switched.embedding.embedAll).toBe(true);

    const statAfterSwitch = runCliJson<{ embeddingStatus: Record<string, number> }>(
      ["stat"],
      { ...workspace.env, EMBEDDING_BASE_URL: serverB.url, EMBEDDING_MODEL: "model-b" },
    );
    expect(statAfterSwitch.embeddingStatus.done).toBe(10);

    const search = runCliJson<Array<{ id: string }>>(
      ["search", "semantic retrieval", "--limit", "5"],
      { ...workspace.env, EMBEDDING_BASE_URL: serverB.url, EMBEDDING_MODEL: "model-b" },
    );
    expect(search.length).toBeGreaterThan(0);

    const switchedBack = runCliJson<{
      profileChanged: boolean;
      embedding: { embedAll: boolean };
    }>(["sync"], workspace.env);
    expect(switchedBack.profileChanged).toBe(true);
    expect(switchedBack.embedding.embedAll).toBe(true);

    const beforeProfile = readMeta(workspace, "embedding_profile");
    const beforeVecCount = dbScalar<number>(workspace, "SELECT COUNT(*) FROM vec_pages");
    const failure = runCli(
      ["sync", "--skip-embedding"],
      { ...workspace.env, EMBEDDING_MODEL: "model-b" },
      { allowFailure: true },
    );
    expect(failure.status).toBe(2);
    expect(failure.stderr).toContain("Embedding profile changed, cannot skip embedding.");
    expect(readMeta(workspace, "embedding_profile")).toBe(beforeProfile);
    expect(dbScalar<number>(workspace, "SELECT COUNT(*) FROM vec_pages")).toBe(beforeVecCount);
  });
});

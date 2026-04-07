import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  readFile,
  runCliJson,
  startEmbeddingServer,
  writePage,
} from "../helpers.js";

describe("acceptance: S3 knowledge query", () => {
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

  it("lets an agent find, search, traverse, and inspect Bayesian knowledge", async () => {
    const server = await startEmbeddingServer({
      dimensions: 4,
      handler: (payload) => {
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        const embed = (input: string) => {
          const text = String(input);
          if (/贝叶斯|Bayes/i.test(text)) {
            return [1, 0, 0, 0];
          }
          if (/概率|probability/i.test(text)) {
            return [0.8, 0, 0, 0];
          }
          if (/机器学习|machine learning|transfer|bridge/i.test(text)) {
            return [0.7, 0, 0, 0];
          }
          return [0, 1, 0, 0];
        };

        return {
          data: inputs.map((input: string, index: number) => ({
            index,
            embedding: embed(String(input)),
          })),
        };
      },
    });
    servers.push(server);

    const workspace = createWorkspace({
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "semantic-test",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writePage(
      workspace,
      "concepts/probability-basics.md",
      `---
pageType: concept
title: 概率基础
nodeId: probability-basics
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - probability
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: high
prerequisites: []
---

概率基础解释了事件、不确定性和条件概率。
`,
    );
    writePage(
      workspace,
      "concepts/bayesian-theorem.md",
      `---
pageType: concept
title: 贝叶斯定理
nodeId: bayesian-theorem
status: active
visibility: shared
sourceRefs:
  - concepts/probability-basics.md
relatedPages:
  - concepts/probability-basics.md
tags:
  - probability
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites:
  - probability-basics
---

贝叶斯定理描述了在已有先验概率的基础上，如何根据新证据更新后验判断。
`,
    );
    writePage(
      workspace,
      "bridges/bayes-to-ml.md",
      `---
pageType: bridge
title: 贝叶斯方法到机器学习
nodeId: bayes-ml-bridge
status: active
visibility: shared
sourceRefs:
  - concepts/bayesian-theorem.md
relatedPages:
  - concepts/bayesian-theorem.md
tags:
  - ml
createdAt: 2026-04-06
updatedAt: 2026-04-06
fromCourse: statistics
toCourse: machine-learning
transferType: inference
fromConcepts:
  - bayesian-theorem
toConcepts:
  - probability-basics
---

把贝叶斯更新理解迁移到机器学习时，可以把它看成一种基于证据修正模型判断的方式。
`,
    );

    runCliJson(["sync"], workspace.env);

    const findResult = runCliJson<Array<{ id: string }>>(
      ["find", "--type", "concept", "--tag", "probability"],
      workspace.env,
    );
    expect(findResult.map((item) => item.id)).toContain("concepts/bayesian-theorem.md");

    const searchResult = runCliJson<Array<{ id: string; similarity: number }>>(
      ["search", "如何在机器学习中使用贝叶斯方法", "--limit", "3"],
      workspace.env,
    );
    expect(searchResult.slice(0, 3).map((item) => item.id)).toContain("concepts/bayesian-theorem.md");
    expect(searchResult.find((item) => item.id === "concepts/bayesian-theorem.md")?.similarity ?? 0).toBeGreaterThan(0.5);

    const graph = runCliJson<{
      nodes: Array<{ nodeId?: string }>;
      edges: Array<{ edgeType: string; source: string; target: string }>;
    }>(["graph", "bayesian-theorem", "--depth", "2"], workspace.env);
    expect(graph.nodes.map((node) => node.nodeId)).toContain("bayes-ml-bridge");
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edgeType: "bridges_from", target: "bayesian-theorem" }),
      ]),
    );

    const pageInfo = runCliJson<{
      filePath: string;
      title: string;
      outgoingEdges: Array<{ edgeType: string }>;
      incomingEdges: Array<{ edgeType: string }>;
    }>(["page-info", "concepts/bayesian-theorem.md"], workspace.env);
    expect(pageInfo.title).toBe("贝叶斯定理");
    expect(pageInfo.outgoingEdges.length).toBeGreaterThan(0);
    expect(pageInfo.incomingEdges.length).toBeGreaterThan(0);
    expect(readFile(pageInfo.filePath)).toContain("后验判断");
  });
});

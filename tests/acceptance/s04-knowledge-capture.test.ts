import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  readFile,
  runCliJson,
  writePage,
} from "../helpers.js";

describe("acceptance: S4 knowledge capture", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("creates a new concept page from the template, fills it, and indexes it immediately", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writePage(
      workspace,
      "concepts/calculus-basics.md",
      `---
pageType: concept
title: 微积分基础
nodeId: calculus-basics
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - math
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: high
prerequisites: []
---

微积分基础提供了理解梯度与导数变化率所需的数学背景。
`,
    );
    runCliJson(["sync"], workspace.env);

    const existing = runCliJson<Array<{ id: string }>>(
      ["find", "--type", "concept", "--node-id", "gradient-descent"],
      workspace.env,
    );
    expect(existing).toHaveLength(0);

    const created = runCliJson<{ created: string; filePath: string }>(
      ["create", "--type", "concept", "--title", "梯度下降法", "--node-id", "gradient-descent"],
      workspace.env,
    );
    expect(created.created.startsWith("concepts/")).toBe(true);
    expect(created.created.endsWith(".md")).toBe(true);
    expect(readFile(created.filePath)).toContain("## Definition");
    expect(readFile(created.filePath)).toContain("## Formal Specification");

    writePage(
      workspace,
      created.created,
      `---
pageType: concept
title: 梯度下降法
nodeId: gradient-descent
status: active
visibility: shared
sourceRefs: []
relatedPages:
  - concepts/calculus-basics.md
tags:
  - optimization
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites:
  - calculus-basics
---

## 核心理解

梯度下降法通过沿着损失函数下降最快的方向迭代更新参数，也就是常说的 gradient descent。

## 前置知识

需要先理解导数、梯度和步长的含义。

## 关键公式/定义

常见更新公式是 θ = θ - η∇L(θ)。

## 直觉/类比

可以把它理解成在山坡上寻找最快下山方向。

## 典型应用

它常用于机器学习模型训练和数值优化问题。

## 容易混淆

不要把它和牛顿法或坐标下降混为一谈。

## 开放问题

后续还需要补充自适应学习率方法的比较。

## 来源

来自优化课程笔记与实践经验。
`,
    );

    runCliJson(["sync", "--path", created.created], workspace.env);

    const lint = runCliJson<{ errors: Array<unknown> }>(
      ["lint", "--path", created.created, "--format", "json"],
      workspace.env,
    );
    expect(lint.errors).toHaveLength(0);

    const pageInfo = runCliJson<{ nodeId: string; title: string }>(["page-info", created.created], workspace.env);
    expect(pageInfo.nodeId).toBe("gradient-descent");
    expect(pageInfo.title).toBe("梯度下降法");

    const graph = runCliJson<{ edges: Array<{ edgeType: string; target: string }> }>(
      ["graph", "gradient-descent"],
      workspace.env,
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edgeType: "prerequisite", target: "calculus-basics" }),
      ]),
    );

    const fts = runCliJson<Array<{ id: string }>>(["fts", "gradient"], workspace.env);
    expect(fts.map((item) => item.id)).toContain(created.created);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  runCliJson,
  writePage,
} from "../helpers.js";

describe("acceptance: S8 graph traversal", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("traverses prerequisite chains and bridge relations without duplicate nodes", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writePage(
      workspace,
      "concepts/ml-basics.md",
      `---
pageType: concept
title: ML Basics
nodeId: ml-basics
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

Machine-learning basics page.
`,
    );
    writePage(
      workspace,
      "concepts/linear-regression.md",
      `---
pageType: concept
title: Linear Regression
nodeId: linear-regression
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites:
  - ml-basics
---

Linear regression depends on ML basics.
`,
    );
    writePage(
      workspace,
      "concepts/logistic-regression.md",
      `---
pageType: concept
title: Logistic Regression
nodeId: logistic-regression
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites:
  - linear-regression
---

Logistic regression extends the regression toolkit for classification.
`,
    );
    writePage(
      workspace,
      "bridges/logistic-to-basics.md",
      `---
pageType: bridge
title: Logistic Back to Basics
nodeId: logistic-basics-bridge
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
fromCourse: ml
toCourse: ml
transferType: recap
fromConcepts:
  - logistic-regression
toConcepts:
  - ml-basics
---

This bridge links logistic regression back to the foundations.
`,
    );

    runCliJson(["sync"], workspace.env);

    const prerequisiteGraph = runCliJson<{
      nodes: Array<{ nodeId?: string }>;
      edges: Array<{ edgeType: string }>;
    }>(["graph", "logistic-regression", "--edge-type", "prerequisite", "--depth", "3"], workspace.env);
    expect(prerequisiteGraph.nodes.map((node) => node.nodeId)).toEqual(
      expect.arrayContaining(["logistic-regression", "linear-regression", "ml-basics"]),
    );

    const allGraph = runCliJson<{
      nodes: Array<{ nodeId?: string; pageType?: string }>;
      edges: Array<{ edgeType: string }>;
    }>(["graph", "ml-basics", "--depth", "2"], workspace.env);
    expect(allGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edgeType: "prerequisite" }),
        expect.objectContaining({ edgeType: "bridges_to" }),
      ]),
    );
    expect(allGraph.nodes.every((node) => typeof node.pageType === "string" || typeof node.nodeId === "string")).toBe(true);

    const nodeIds = allGraph.nodes.map((node) => node.nodeId);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });
});

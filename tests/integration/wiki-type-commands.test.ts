import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  runCliJson,
  startEmbeddingServer,
  writePage,
} from "../helpers.js";

describe("wiki type commands", () => {
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

  it("lists registered types in structured form", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    runCliJson(["init"], workspace.env);

    const types = runCliJson<
      Array<{ pageType: string; file: string; columns: string[]; summaryFields: string[] }>
    >(["type", "list", "--format", "json"], workspace.env);

    expect(types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageType: "concept",
          file: "templates/concept.md",
        }),
        expect.objectContaining({
          pageType: "method",
          file: "templates/method.md",
        }),
      ]),
    );
  });

  it("shows one type with columns and edges", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    runCliJson(["init"], workspace.env);

    const typeInfo = runCliJson<{
      pageType: string;
      file: string;
      columns: Record<string, string>;
      edges: Record<string, { edgeType: string; resolve: string }>;
      summaryFields: string[];
    }>(["type", "show", "concept", "--format", "json"], workspace.env);

    expect(typeInfo).toEqual(
      expect.objectContaining({
        pageType: "concept",
        file: "templates/concept.md",
        columns: expect.objectContaining({
          confidence: "text",
          masteryLevel: "text",
        }),
        edges: expect.objectContaining({
          prerequisites: expect.objectContaining({
            edgeType: "prerequisite",
            resolve: "nodeId",
          }),
        }),
      }),
    );
  });

  it("registers template fields that appear in default source-summary, method, and resume templates", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    runCliJson(["init"], workspace.env);

    const sourceSummary = runCliJson<{
      columns: Record<string, string>;
      summaryFields: string[];
    }>(["type", "show", "source-summary", "--format", "json"], workspace.env);
    const method = runCliJson<{
      columns: Record<string, string>;
      summaryFields: string[];
    }>(["type", "show", "method", "--format", "json"], workspace.env);
    const resume = runCliJson<{
      columns: Record<string, string>;
      summaryFields: string[];
    }>(["type", "show", "resume", "--format", "json"], workspace.env);

    expect(sourceSummary.columns).toEqual(
      expect.objectContaining({
        sourceType: "text",
        vaultPath: "text",
        keyFindings: "text",
      }),
    );
    expect(sourceSummary.summaryFields).toEqual(expect.arrayContaining(["keyFindings"]));

    expect(method.columns).toEqual(
      expect.objectContaining({
        domain: "text",
        effectiveness: "text",
        applicableTo: "text",
      }),
    );
    expect(method.summaryFields).toEqual(expect.arrayContaining(["applicableTo"]));

    expect(resume.columns).toEqual(
      expect.objectContaining({
        targetAudience: "text",
        lastReviewedAt: "text",
        vaultPath: "text",
      }),
    );

    writePage(
      workspace,
      "source-summaries/aligned.md",
      `---
pageType: source-summary
title: Aligned Source Summary
nodeId: aligned-source-summary
status: active
visibility: private
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
sourceType: pdf
vaultPath: imports/aligned.pdf
keyFindings:
  - one
---

Aligned source summary body.
`,
    );
    writePage(
      workspace,
      "methods/aligned.md",
      `---
pageType: method
title: Aligned Method
nodeId: aligned-method
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
domain: research
effectiveness: medium
applicableTo:
  - literature-review
---

Aligned method body.
`,
    );
    writePage(
      workspace,
      "resumes/aligned.md",
      `---
pageType: resume
title: Aligned Resume
nodeId: aligned-resume
status: draft
visibility: private
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
targetAudience: hiring-manager
lastReviewedAt: 2026-04-06
vaultPath: imports/resume.pdf
---

Aligned resume body.
`,
    );

    runCliJson(["sync"], workspace.env);
    const lint = runCliJson<{
      info: Array<{ check: string; page: string }>;
    }>(["lint", "--format", "json"], workspace.env);

    expect(
      lint.info.filter(
        (item) =>
          item.check === "unregistered_fields" &&
          ["source-summaries/aligned.md", "methods/aligned.md", "resumes/aligned.md"].includes(item.page),
      ),
    ).toEqual([]);
  });

  it("recommends types from existing page embeddings instead of hardcoded hints", async () => {
    const server = await startEmbeddingServer({
      dimensions: 4,
      handler: (payload) => {
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        const score = (text: string, words: string[]) =>
          words.reduce((count, word) => count + (text.includes(word) ? 1 : 0), 0);

        return {
          data: inputs.map((input: string, index: number) => {
            const text = String(input).toLowerCase();
            return {
              index,
              embedding: [
                score(text, ["workflow", "procedure", "checklist", "process"]),
                score(text, ["concept", "theorem", "definition", "principle"]),
                score(text, ["research", "experiment", "hypothesis", "observation"]),
                score(text, ["question", "answer", "faq", "troubleshooting"]),
              ],
            };
          }),
        };
      },
    });
    servers.push(server);

    const workspace = createWorkspace({
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "type-recommend-model",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    writePage(
      workspace,
      "methods/evidence-review.md",
      `---
pageType: method
title: Evidence Review Workflow
nodeId: evidence-review
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - workflow
createdAt: 2026-04-06
updatedAt: 2026-04-06
domain: research
effectiveness: high
---

A repeatable workflow and checklist for evidence review and decision procedures.
`,
    );
    writePage(
      workspace,
      "concepts/bayes-theorem.md",
      `---
pageType: concept
title: Bayes Theorem
nodeId: bayes-theorem
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - concept
createdAt: 2026-04-06
updatedAt: 2026-04-06
confidence: high
masteryLevel: medium
prerequisites: []
---

A concept and theorem about belief updates and probabilistic definitions.
`,
    );
    writePage(
      workspace,
      "research-notes/ablation-note.md",
      `---
pageType: research-note
title: Ablation Research Note
nodeId: ablation-note
status: active
visibility: shared
sourceRefs: []
relatedPages: []
tags:
  - research
createdAt: 2026-04-06
updatedAt: 2026-04-06
researchTopic: ablation
stage: active
---

Research experiment note about hypothesis design and observations.
`,
    );

    runCliJson(["sync"], workspace.env);

    const recommendations = runCliJson<{
      query: { text: string; keywords: string[] };
      recommendations: Array<{ pageType: string; score: number; signals: string[]; similarPages: string[] }>;
    }>(
      [
        "type",
        "recommend",
        "--text",
        "Need a repeatable workflow and procedure for evidence review.",
        "--keywords",
        "workflow,procedure,checklist",
        "--limit",
        "3",
        "--format",
        "json",
      ],
      workspace.env,
    );

    expect(recommendations.recommendations).toHaveLength(3);
    expect(recommendations.recommendations[0]?.pageType).toBe("method");
    expect(recommendations.recommendations[0]?.similarPages).toEqual(
      expect.arrayContaining([expect.stringContaining("methods/evidence-review.md@")]),
    );
    expect(recommendations.recommendations[0]?.signals).toEqual(
      expect.arrayContaining([expect.stringContaining("supportCount:"), expect.stringContaining("maxSimilarity:")]),
    );
  });
});

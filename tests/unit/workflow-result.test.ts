import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseWorkflowResult, readWorkflowResult } from "../../src/core/workflow-result.js";

function validManifest() {
  return {
    status: "done",
    decision: "apply",
    reason: "The file adds durable knowledge.",
    threadId: "thread-123",
    skillsUsed: ["tiangong-wiki-skill", "pdf-reader"],
    createdPageIds: ["concepts/bayes-updating.md"],
    updatedPageIds: ["methods/evidence-review.md"],
    appliedTypeNames: ["concept", "method"],
    proposedTypes: [
      {
        name: "lab-report",
        reason: "Current ontology does not model experiments cleanly.",
        suggestedTemplateSections: ["Hypothesis", "Setup", "Findings"],
      },
    ],
    actions: [
      {
        kind: "update_page",
        pageId: "methods/evidence-review.md",
        pageType: "method",
        summary: "Added the new evidence from the source file.",
      },
    ],
    lint: [
      {
        pageId: "methods/evidence-review.md",
        errors: 0,
        warnings: 1,
      },
    ],
  };
}

describe("workflow result parsing", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("accepts a valid manifest", () => {
    const manifest = parseWorkflowResult(validManifest());
    expect(manifest.threadId).toBe("thread-123");
    expect(manifest.actions[0]?.kind).toBe("update_page");
    expect(manifest.proposedTypes[0]?.name).toBe("lab-report");
  });

  it("rejects a manifest without threadId", () => {
    const manifest = validManifest();
    delete (manifest as { threadId?: string }).threadId;
    expect(() => parseWorkflowResult(manifest)).toThrowError("result.threadId must be a non-empty string");
  });

  it("rejects a manifest without decision", () => {
    const manifest = validManifest();
    delete (manifest as { decision?: string }).decision;
    expect(() => parseWorkflowResult(manifest)).toThrowError("result.decision must be a non-empty string");
  });

  it("rejects a manifest with malformed actions", () => {
    const manifest = validManifest();
    manifest.actions = [
      {
        kind: "update_page",
        pageType: "method",
      } as unknown as (typeof manifest.actions)[number],
    ];
    expect(() => parseWorkflowResult(manifest)).toThrowError("result.actions[0].summary must be a non-empty string");
  });

  it("rejects apply decisions that produce no actions", () => {
    const manifest = validManifest();
    manifest.actions = [];
    expect(() => parseWorkflowResult(manifest)).toThrowError(
      "result.actions must contain at least one action when decision=apply",
    );
  });

  it("rejects empty result files with a dedicated error", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-result-empty-"));
    tempDirs.push(dir);
    const resultPath = path.join(dir, "result.json");
    writeFileSync(resultPath, "", "utf8");

    expect(() => readWorkflowResult(resultPath)).toThrowError("Workflow result is empty");
  });

  it("rejects malformed result files as invalid JSON", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-result-invalid-"));
    tempDirs.push(dir);
    const resultPath = path.join(dir, "result.json");
    writeFileSync(resultPath, "{not-json", "utf8");

    expect(() => readWorkflowResult(resultPath)).toThrowError("Workflow result is not valid JSON");
  });
});

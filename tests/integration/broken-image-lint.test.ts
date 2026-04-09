import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  runCli,
  runCliJson,
  writePage,
  type Workspace,
} from "../helpers.js";

interface LintResult {
  errors: Array<{ page: string; check: string; message: string }>;
  warnings: Array<{ page: string; check: string; message: string }>;
  info: Array<{ page: string; check: string; message: string }>;
  summary: { pages: number; errors: number; warnings: number; info: number };
}

function writeImage(ws: Workspace, relativePath: string): void {
  const absPath = path.join(ws.wikiRoot, relativePath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, Buffer.alloc(64, 0x89));
}

function makePage(title: string, body: string): string {
  return [
    "---",
    `pageType: concept`,
    `title: "${title}"`,
    `nodeId: ${title.toLowerCase().replace(/\s+/g, "-")}`,
    "status: draft",
    "visibility: private",
    "sourceRefs: []",
    "relatedPages: []",
    "tags: []",
    "createdAt: 2026-04-09",
    "updatedAt: 2026-04-09",
    "confidence: medium",
    "masteryLevel: medium",
    "prerequisites: []",
    "---",
    "",
    body,
  ].join("\n");
}

describe("broken_image_ref lint check", () => {
  const workspaces: Workspace[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("no warning for existing image", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    writeImage(ws, "assets/images/diagram.png");
    writePage(
      ws,
      "concepts/test.md",
      makePage("Test", "## Content\n\n![diagram](../../assets/images/diagram.png)"),
    );
    runCli(["sync"], ws.env);

    const result = runCliJson<LintResult>(["lint", "--format", "json"], ws.env);
    const brokenRefs = result.warnings.filter((w) => w.check === "broken_image_ref");
    expect(brokenRefs).toHaveLength(0);
  });

  it("warns for broken image reference", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    writePage(
      ws,
      "concepts/test.md",
      makePage("Test", "## Content\n\n![missing](../../assets/images/nonexistent.png)"),
    );
    runCli(["sync"], ws.env);

    const result = runCliJson<LintResult>(["lint", "--format", "json"], ws.env);
    const brokenRefs = result.warnings.filter((w) => w.check === "broken_image_ref");
    expect(brokenRefs).toHaveLength(1);
    expect(brokenRefs[0].message).toContain("nonexistent.png");
  });

  it("skips external URLs", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    writePage(
      ws,
      "concepts/test.md",
      makePage(
        "Test",
        "## Content\n\n![ext](https://example.com/img.png)\n\n![ext2](http://example.com/img.png)",
      ),
    );
    runCli(["sync"], ws.env);

    const result = runCliJson<LintResult>(["lint", "--format", "json"], ws.env);
    const brokenRefs = result.warnings.filter((w) => w.check === "broken_image_ref");
    expect(brokenRefs).toHaveLength(0);
  });

  it("skips data URIs and anchors", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    writePage(
      ws,
      "concepts/test.md",
      makePage("Test", "## Content\n\n![b64](data:image/png;base64,abc)\n\n![anchor](#section)"),
    );
    runCli(["sync"], ws.env);

    const result = runCliJson<LintResult>(["lint", "--format", "json"], ws.env);
    const brokenRefs = result.warnings.filter((w) => w.check === "broken_image_ref");
    expect(brokenRefs).toHaveLength(0);
  });

  it("handles image with title syntax", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    writeImage(ws, "assets/images/arch.png");
    writePage(
      ws,
      "concepts/test.md",
      makePage("Test", '## Content\n\n![arch](../../assets/images/arch.png "Architecture diagram")'),
    );
    runCli(["sync"], ws.env);

    const result = runCliJson<LintResult>(["lint", "--format", "json"], ws.env);
    const brokenRefs = result.warnings.filter((w) => w.check === "broken_image_ref");
    expect(brokenRefs).toHaveLength(0);
  });

  it("resolves multi-level relative paths", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    writeImage(ws, "assets/images/deep.png");
    writePage(
      ws,
      "methods/deep/nested/test.md",
      makePage("Test", "## Content\n\n![img](../../../../assets/images/deep.png)"),
    );
    runCli(["sync"], ws.env);

    const result = runCliJson<LintResult>(["lint", "--format", "json"], ws.env);
    const brokenRefs = result.warnings.filter((w) => w.check === "broken_image_ref");
    expect(brokenRefs).toHaveLength(0);
  });

  it("handles URL-encoded paths", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    writeImage(ws, "assets/images/my diagram.png");
    writePage(
      ws,
      "concepts/test.md",
      makePage("Test", "## Content\n\n![img](../../assets/images/my%20diagram.png)"),
    );
    runCli(["sync"], ws.env);

    const result = runCliJson<LintResult>(["lint", "--format", "json"], ws.env);
    const brokenRefs = result.warnings.filter((w) => w.check === "broken_image_ref");
    expect(brokenRefs).toHaveLength(0);
  });
});

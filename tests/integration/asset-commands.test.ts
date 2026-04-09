import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  readJson,
  runCli,
  runCliJson,
  type Workspace,
} from "../helpers.js";

function writeTestImage(filePath: string, sizeBytes = 64): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x89));
}

describe("asset save", () => {
  const workspaces: Workspace[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("saves a file and returns assetPath", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const imgPath = path.join(ws.root, "photo.png");
    writeTestImage(imgPath);

    const result = runCliJson<{ assetPath: string }>(["asset", "save", imgPath], ws.env);
    expect(result.assetPath).toBe("assets/images/photo.png");
  });

  it("uses --name for custom slug", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const imgPath = path.join(ws.root, "IMG_20260401.png");
    writeTestImage(imgPath);

    const result = runCliJson<{ assetPath: string }>(
      ["asset", "save", imgPath, "--name", "arch-diagram"],
      ws.env,
    );
    expect(result.assetPath).toBe("assets/images/arch-diagram.png");
  });

  it("deduplicates with suffix", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const imgPath = path.join(ws.root, "photo.png");
    writeTestImage(imgPath);

    const r1 = runCliJson<{ assetPath: string }>(["asset", "save", imgPath], ws.env);
    expect(r1.assetPath).toBe("assets/images/photo.png");

    writeTestImage(imgPath, 128); // different content
    const r2 = runCliJson<{ assetPath: string }>(["asset", "save", imgPath], ws.env);
    expect(r2.assetPath).toBe("assets/images/photo-1.png");

    writeTestImage(imgPath, 256);
    const r3 = runCliJson<{ assetPath: string }>(["asset", "save", imgPath], ws.env);
    expect(r3.assetPath).toBe("assets/images/photo-2.png");
  });

  it("creates assets/images/ directory automatically", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const imgPath = path.join(ws.root, "test.jpg");
    writeTestImage(imgPath);

    const result = runCliJson<{ assetPath: string }>(["asset", "save", imgPath], ws.env);
    expect(result.assetPath).toBe("assets/images/test.jpg");
  });

  it("errors on non-existent source file", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const result = runCli(["asset", "save", "/nonexistent/file.png"], ws.env, { allowFailure: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("errors on invalid slug", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const imgPath = path.join(ws.root, "test.png");
    writeTestImage(imgPath);

    const result = runCli(
      ["asset", "save", imgPath, "--name", "Has Spaces!"],
      ws.env,
      { allowFailure: true },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid asset name");
  });

  it("errors on unsupported type", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const imgPath = path.join(ws.root, "test.png");
    writeTestImage(imgPath);

    const result = runCli(
      ["asset", "save", imgPath, "--type", "video"],
      ws.env,
      { allowFailure: true },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported asset type");
  });

  it("normalizes slug from source filename", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const imgPath = path.join(ws.root, "My Screenshot (2).PNG");
    writeTestImage(imgPath);

    const result = runCliJson<{ assetPath: string }>(["asset", "save", imgPath], ws.env);
    // Should normalize to kebab-case, lowercase ext preserved from original
    expect(result.assetPath).toMatch(/^assets\/images\/my-screenshot-2\.png$/);
  });
});

describe("asset ref", () => {
  const workspaces: Workspace[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("returns relativePath for exact match", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    // Place an asset file
    const assetDir = path.join(ws.wikiRoot, "assets", "images");
    mkdirSync(assetDir, { recursive: true });
    writeTestImage(path.join(assetDir, "diagram.png"));

    const result = runCliJson<{ relativePath: string; assetPath: string }>(
      ["asset", "ref", "diagram.png", "--page", "methods/example.md"],
      ws.env,
    );
    // pages/methods/ → wikiRoot/assets/images/ = ../../assets/images/
    expect(result.relativePath).toBe("../../assets/images/diagram.png");
    expect(result.assetPath).toBe("assets/images/diagram.png");
  });

  it("handles full asset path input", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const assetDir = path.join(ws.wikiRoot, "assets", "images");
    mkdirSync(assetDir, { recursive: true });
    writeTestImage(path.join(assetDir, "diagram.png"));

    const result = runCliJson<{ relativePath: string; assetPath: string }>(
      ["asset", "ref", "assets/images/diagram.png", "--page", "methods/example.md"],
      ws.env,
    );
    expect(result.relativePath).toBe("../../assets/images/diagram.png");
  });

  it("computes correct depth for nested pages", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const assetDir = path.join(ws.wikiRoot, "assets", "images");
    mkdirSync(assetDir, { recursive: true });
    writeTestImage(path.join(assetDir, "diagram.png"));

    const result = runCliJson<{ relativePath: string }>(
      ["asset", "ref", "diagram.png", "--page", "methods/deep/nested/example.md"],
      ws.env,
    );
    // pages/methods/deep/nested/ → wikiRoot/assets/images/ = ../../../../assets/images/
    expect(result.relativePath).toBe("../../../../assets/images/diagram.png");
  });

  it("computes correct path for root-level page", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const assetDir = path.join(ws.wikiRoot, "assets", "images");
    mkdirSync(assetDir, { recursive: true });
    writeTestImage(path.join(assetDir, "diagram.png"));

    const result = runCliJson<{ relativePath: string }>(
      ["asset", "ref", "diagram.png", "--page", "example.md"],
      ws.env,
    );
    // pages/ → wikiRoot/assets/images/ = ../assets/images/
    expect(result.relativePath).toBe("../assets/images/diagram.png");
  });

  it("returns candidates when exact not found but similar exist", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const assetDir = path.join(ws.wikiRoot, "assets", "images");
    mkdirSync(assetDir, { recursive: true });
    writeTestImage(path.join(assetDir, "diagram-1.png"));
    writeTestImage(path.join(assetDir, "diagram-2.png"));

    const result = runCliJson<{ match: string; candidates: Array<{ assetPath: string }> }>(
      ["asset", "ref", "diagram.png", "--page", "methods/example.md"],
      ws.env,
    );
    expect(result.match).toBe("candidates");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].assetPath).toBe("assets/images/diagram-1.png");
    expect(result.candidates[1].assetPath).toBe("assets/images/diagram-2.png");
  });

  it("errors when asset not found at all", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const result = runCli(
      ["asset", "ref", "nonexistent.png", "--page", "methods/example.md"],
      ws.env,
      { allowFailure: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});

describe("asset round-trip", () => {
  const workspaces: Workspace[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("save then ref produces a valid path", () => {
    const ws = createWorkspace();
    workspaces.push(ws);
    bootstrapRuntimeAssets(ws);

    const imgPath = path.join(ws.root, "arch.png");
    writeTestImage(imgPath);

    const saved = runCliJson<{ assetPath: string }>(
      ["asset", "save", imgPath, "--name", "architecture"],
      ws.env,
    );
    expect(saved.assetPath).toBe("assets/images/architecture.png");

    const ref = runCliJson<{ relativePath: string; assetPath: string }>(
      ["asset", "ref", "architecture.png", "--page", "concepts/platform.md"],
      ws.env,
    );
    // pages/concepts/ → wikiRoot/assets/images/ = ../../assets/images/
    expect(ref.relativePath).toBe("../../assets/images/architecture.png");
    expect(ref.assetPath).toBe("assets/images/architecture.png");
  });
});

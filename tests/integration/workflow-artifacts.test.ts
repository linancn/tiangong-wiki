import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupWorkspace, createWorkspace, readFile } from "../helpers.js";
import { resolveRuntimePaths } from "../../src/core/paths.js";
import {
  ensureWorkflowArtifactSet,
  getWorkflowArtifactSet,
  toWorkflowArtifactId,
} from "../../src/core/workflow-context.js";

describe("workflow artifacts", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("derives a stable artifact directory under wiki/.queue-artifacts", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    const paths = resolveRuntimePaths(workspace.env);

    const first = getWorkflowArtifactSet(paths, "imports/reports/spec v2.pdf");
    const second = getWorkflowArtifactSet(paths, "imports/reports/spec v2.pdf");

    expect(first.artifactId).toBe(second.artifactId);
    expect(first.rootDir).toBe(second.rootDir);
    expect(first.rootDir.startsWith(paths.queueArtifactsPath)).toBe(true);
    expect(toWorkflowArtifactId("imports/reports/spec v2.pdf")).toContain("--");
  });

  it("creates only the minimal workflow artifact files", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    const paths = resolveRuntimePaths(workspace.env);

    const artifacts = ensureWorkflowArtifactSet(paths, {
      queueItemId: "imports/spec.pdf",
      queueItem: {
        fileId: "imports/spec.pdf",
        status: "pending",
        queuedAt: "2026-04-07T12:00:00+08:00",
      },
      promptMarkdown: "# Minimal Prompt\n\nUse runtime discovery.",
    });

    expect(readFile(artifacts.queueItemPath)).toContain('"fileId": "imports/spec.pdf"');
    expect(readFile(artifacts.promptPath)).toContain("Use runtime discovery.");
    expect(readFile(artifacts.resultPath)).toBe("");

    const relativeEntries = [
      artifacts.queueItemPath,
      artifacts.promptPath,
      artifacts.resultPath,
      artifacts.skillArtifactsPath,
    ].map((entry) => entry.replace(`${artifacts.rootDir}/`, ""));

    expect(relativeEntries).toEqual([
      "queue-item.json",
      "prompt.md",
      "result.json",
      "skill-artifacts",
    ]);
  });

  it("creates a wiki wrapper that forwards to the next wiki binary on PATH", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    const paths = resolveRuntimePaths(workspace.env);

    const artifacts = ensureWorkflowArtifactSet(paths, {
      queueItemId: "imports/spec.pdf",
      queueItem: {
        fileId: "imports/spec.pdf",
        status: "pending",
      },
    });

    const realWikiBinDir = path.join(workspace.root, "real-wiki-bin");
    mkdirSync(realWikiBinDir, { recursive: true });
    const realWikiPath = path.join(realWikiBinDir, "wiki");
    writeFileSync(
      realWikiPath,
      ['#!/bin/sh', 'printf "real wiki:%s\\n" "$*"', ""].join("\n"),
      "utf8",
    );
    chmodSync(realWikiPath, 0o755);

    const wrapperPath = path.join(artifacts.skillArtifactsPath, "wiki");
    const result = spawnSync(wrapperPath, ["sync", "--path", "concepts/bayes-theorem.md"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [artifacts.skillArtifactsPath, realWikiBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
        WIKI_CLI_WRAPPER: wrapperPath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("real wiki:sync --path concepts/bayes-theorem.md");
  });
});

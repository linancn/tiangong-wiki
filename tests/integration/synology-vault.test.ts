import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FakeCodexWorkflowRunner } from "../../src/core/codex-workflow.js";
import { createPageFromTemplate, updatePageById } from "../../src/core/page-files.js";
import { loadRuntimeConfig } from "../../src/core/runtime.js";
import { syncWorkspace } from "../../src/core/sync.js";
import { processVaultQueueBatch } from "../../src/core/vault-processing.js";
import {
  cleanupWorkspace,
  createWorkspace,
  readFile,
  runCliJson,
} from "../helpers.js";

function makeScript(workspaceRoot: string, name: string, content: string): string {
  const scriptPath = path.join(workspaceRoot, name);
  writeFileSync(scriptPath, content, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("synology vault polling", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("indexes vault files through the Synology polling branch when using mtime hashing", () => {
    const workspace = createWorkspace({
      VAULT_SOURCE: "synology",
      VAULT_SYNOLOGY_REMOTE_PATH: "/vault",
      VAULT_HASH_MODE: "mtime",
    });
    workspaces.push(workspace);

    const scriptPath = makeScript(
      workspace.root,
      "fake_synology.py",
      `#!/usr/bin/env python3
import json
import sys

folder = sys.argv[sys.argv.index("--folder") + 1]
if folder == "/vault":
    payload = {"data": {"files": [
        {"name": "projects", "path": "/vault/projects", "isdir": True},
        {"name": "imports", "path": "/vault/imports", "isdir": True}
    ]}}
elif folder == "/vault/projects":
    payload = {"data": {"files": [
        {"name": "brief.pdf", "path": "/vault/projects/brief.pdf", "isdir": False, "size": 12, "additional": {"size": 12, "time": {"mtime": 1700000000}}}
    ]}}
elif folder == "/vault/imports":
    payload = {"data": {"files": [
        {"name": "notes.txt", "path": "/vault/imports/notes.txt", "isdir": False, "size": 9, "additional": {"size": 9, "time": {"mtime": 1700000001}}}
    ]}}
else:
    payload = {"data": {"files": []}}
print(json.dumps(payload))
`,
    );

    const init = runCliJson<{ initialized: boolean }>(
      ["init"],
      { ...workspace.env, SYNOLOGY_FILE_STATION_SCRIPT: scriptPath },
    );
    expect(init.initialized).toBe(true);

    const vaultList = runCliJson<Array<{ id: string }>>(
      ["vault", "list"],
      { ...workspace.env, SYNOLOGY_FILE_STATION_SCRIPT: scriptPath },
    );
    expect(vaultList.map((item) => item.id)).toEqual(
      expect.arrayContaining(["projects/brief.pdf", "imports/notes.txt"]),
    );
  });

  it("paginates through large Synology directories", () => {
    const workspace = createWorkspace({
      VAULT_SOURCE: "synology",
      VAULT_SYNOLOGY_REMOTE_PATH: "/vault",
      VAULT_HASH_MODE: "mtime",
    });
    workspaces.push(workspace);

    const scriptPath = makeScript(
      workspace.root,
      "fake_synology_paginated.py",
      `#!/usr/bin/env python3
import json
import sys

def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

folder = arg("--folder", "")
offset = int(arg("--offset", "0"))
limit = int(arg("--limit", "100"))

if folder == "/vault":
    payload = {"data": {"files": [
        {"name": "imports", "path": "/vault/imports", "isdir": True}
    ]}}
elif folder == "/vault/imports":
    files = []
    for index in range(offset, min(offset + limit, 1201)):
        files.append({
            "name": f"doc-{index:04d}.pdf",
            "path": f"/vault/imports/doc-{index:04d}.pdf",
            "isdir": False,
            "size": index + 10,
            "additional": {"size": index + 10, "time": {"mtime": 1700000000 + index}}
        })
    payload = {"data": {"files": files}}
else:
    payload = {"data": {"files": []}}

print(json.dumps(payload))
`,
    );

    runCliJson(["init"], { ...workspace.env, SYNOLOGY_FILE_STATION_SCRIPT: scriptPath });

    const vaultList = runCliJson<Array<{ id: string }>>(
      ["vault", "list"],
      { ...workspace.env, SYNOLOGY_FILE_STATION_SCRIPT: scriptPath },
    );
    expect(vaultList).toHaveLength(1201);
    expect(vaultList[0]?.id).toBe("imports/doc-0000.pdf");
    expect(vaultList.at(-1)?.id).toBe("imports/doc-1200.pdf");
  });

  it("downloads and refreshes Synology cache files for content hashing and queue processing", async () => {
    const workspace = createWorkspace({
      VAULT_SOURCE: "synology",
      VAULT_SYNOLOGY_REMOTE_PATH: "/vault",
      VAULT_HASH_MODE: "content",
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_API_KEY: "test-agent-key",
      WIKI_AGENT_MODEL: "gpt-5.4",
      WIKI_AGENT_BATCH_SIZE: "0",
    });
    workspaces.push(workspace);

    const statePath = path.join(workspace.root, "synology-state.json");
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          files: {
            "/vault/report.pdf": {
              size: 9,
              mtime: 1700000000,
              content: "version-1",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const scriptPath = makeScript(
      workspace.root,
      "fake_synology_stateful.py",
      `#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

state_path = os.environ["FAKE_SYNOLOGY_STATE"]
state = json.loads(Path(state_path).read_text())
files = state["files"]

def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

command = sys.argv[1]
if command == "list":
    folder = arg("--folder", "")
    payload_files = []
    for remote_path, info in files.items():
        parent = remote_path.rsplit("/", 1)[0] or "/"
        if folder == parent:
            payload_files.append({
                "name": remote_path.split("/")[-1],
                "path": remote_path,
                "isdir": False,
                "size": info["size"],
                "additional": {"size": info["size"], "time": {"mtime": info["mtime"]}}
            })
    print(json.dumps({"data": {"files": payload_files}}))
elif command == "download":
    remote_path = arg("--path", "")
    output = arg("--output", "")
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(files[remote_path]["content"], encoding="utf8")
    print(json.dumps({"success": True, "path": remote_path, "output": output}))
else:
    raise SystemExit(f"unsupported command: {command}")
`,
    );

    const env = {
      ...workspace.env,
      SYNOLOGY_FILE_STATION_SCRIPT: scriptPath,
      FAKE_SYNOLOGY_STATE: statePath,
    };

    runCliJson(["init"], env);

    const cachePath = path.join(workspace.vaultPath, "report.pdf");
    expect(readFile(cachePath)).toBe("version-1");
    expect(readFile(`${cachePath}.wiki-cache.json`)).toContain("\"fileMtime\": 1700000000");

    let createdPageId: string | null = null;
    const runner = new FakeCodexWorkflowRunner(async ({ threadId, input }) => {
      const runtime = loadRuntimeConfig(input.env);
      if (!createdPageId) {
        const created = createPageFromTemplate(runtime.paths, runtime.config, {
          pageType: "source-summary",
          title: "synology report",
          frontmatterPatch: {
            status: "active",
            visibility: "shared",
            sourceType: "pdf",
            vaultPath: "report.pdf",
            keyFindings: ["version-1"],
            sourceRefs: ["vault/report.pdf"],
            relatedPages: [],
            tags: ["synology"],
          },
          bodyMarkdown: [
            "## 来源信息",
            "",
            "Synology source imported.",
            "",
            "## 核心内容",
            "",
            "version-1",
            "",
            "## 关键结论",
            "",
            "- version-1",
            "",
            "## 与已有知识的关系",
            "",
            "Created from the initial cache download.",
            "",
            "## 重要引用",
            "",
            "version-1",
          ].join("\n"),
        });
        createdPageId = created.pageId;
        await syncWorkspace({ targetPaths: [createdPageId], env: input.env });
        return {
          status: "done",
          decision: "apply",
          reason: "new source file",
          threadId,
          skillsUsed: ["wiki-skill"],
          createdPageIds: [createdPageId],
          updatedPageIds: [],
          appliedTypeNames: ["source-summary"],
          proposedTypes: [],
          actions: [
            {
              kind: "create_page",
              pageType: "source-summary",
              pageId: createdPageId,
              title: "synology report",
              summary: "Created a source-summary page from the Synology cache.",
            },
          ],
          lint: [{ pageId: createdPageId, errors: 0, warnings: 0 }],
        };
      }

      updatePageById(runtime.paths, createdPageId, {
        frontmatterPatch: {
          sourceType: "pdf",
          vaultPath: "report.pdf",
          keyFindings: ["version-2-updated"],
          sourceRefs: ["vault/report.pdf"],
          relatedPages: [],
          tags: ["synology"],
        },
        bodyMarkdown: [
          "## 来源信息",
          "",
          "Synology cached file refreshed.",
          "",
          "## 核心内容",
          "",
          "version-2-updated",
          "",
          "## 关键结论",
          "",
          "- version-2-updated",
          "",
          "## 与已有知识的关系",
          "",
          "Updated from the same source page.",
          "",
          "## 重要引用",
          "",
          "version-2-updated",
        ].join("\n"),
      });
      await syncWorkspace({ targetPaths: [createdPageId], env: input.env });
      return {
        status: "done",
        decision: "apply",
        reason: "source changed",
        threadId,
        skillsUsed: ["wiki-skill"],
        createdPageIds: [],
        updatedPageIds: [createdPageId],
        appliedTypeNames: ["source-summary"],
        proposedTypes: [],
        actions: [
          {
            kind: "update_page",
            pageType: "source-summary",
            pageId: createdPageId,
            summary: "Updated the cached Synology source page.",
          },
        ],
        lint: [{ pageId: createdPageId, errors: 0, warnings: 0 }],
      };
    });

    await processVaultQueueBatch({ ...env, WIKI_AGENT_BATCH_SIZE: "1" }, { workflowRunner: runner });
    const createdPage = runCliJson<Array<{ id: string }>>(["find", "--type", "source-summary"], env);
    expect(createdPage).toHaveLength(1);
    expect(readFile(path.join(workspace.wikiPath, createdPage[0].id))).toContain("version-1");

    writeFileSync(
      statePath,
      JSON.stringify(
        {
          files: {
            "/vault/report.pdf": {
              size: 17,
              mtime: 1700000500,
              content: "version-2-updated",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const syncResult = runCliJson<{ vault: { changes: number; queue: { pendingReset: number } } }>(
      ["sync"],
      env,
    );
    expect(syncResult.vault.changes).toBe(1);
    expect(syncResult.vault.queue.pendingReset).toBe(1);

    await processVaultQueueBatch({ ...env, WIKI_AGENT_BATCH_SIZE: "1" }, { workflowRunner: runner });

    expect(readFile(cachePath)).toBe("version-2-updated");
    const updatedPage = readFile(path.join(workspace.wikiPath, createdPage[0].id));
    expect(updatedPage).toContain("version-2-updated");
    expect(readFile(`${cachePath}.wiki-cache.json`)).toContain("\"fileMtime\": 1700000500");
  });
});

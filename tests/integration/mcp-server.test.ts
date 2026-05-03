import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import http from "node:http";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { startMcpHttpServer } from "../../mcp-server/src/server.js";
import {
  cleanupWorkspace,
  createWorkspace,
  distCliPath,
  initializeGitRepo,
  projectRoot,
  readJson,
  readPageMatter,
  runCli,
  startEmbeddingServer,
  waitFor,
  writePage,
  writeVaultFile,
  type Workspace,
} from "../helpers.js";

interface DaemonStatePayload {
  host: string;
  port: number;
}

interface ForegroundDaemonHandle {
  child: ChildProcess;
  waitForExit: () => Promise<void>;
  stop: () => Promise<void>;
  logs: () => string;
}

function daemonStatePath(workspace: Workspace): string {
  return path.join(workspace.wikiRoot, ".wiki-daemon.state.json");
}

function daemonPidPath(workspace: Workspace): string {
  return path.join(workspace.wikiRoot, ".wiki-daemon.pid");
}

function readDaemonState(workspace: Workspace): DaemonStatePayload {
  return readJson<DaemonStatePayload>(runCli(["daemon", "status", "--format", "json"], workspace.env).stdout);
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function startForegroundDaemon(workspace: Workspace): Promise<ForegroundDaemonHandle> {
  const child = spawn(process.execPath, [distCliPath(), "daemon", "run"], {
    cwd: projectRoot(),
    env: workspace.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let logs = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    logs += String(chunk);
  });

  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`daemon run exited early: ${logs}`);
    }
    if (!existsSync(daemonStatePath(workspace))) {
      return false;
    }

    const state = readJson<DaemonStatePayload>(runCli(["daemon", "status", "--format", "json"], workspace.env).stdout);
    const response = await fetch(`http://${state.host}:${state.port}/health`);
    return response.ok;
  });

  return {
    child,
    waitForExit: () => waitForChildExit(child),
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }
      runCli(["daemon", "stop"], workspace.env, { allowFailure: true });
      await waitForChildExit(child);
    },
    logs: () => logs,
  };
}

async function reservePort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end("ok");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function connectMcpClient(
  mcpUrl: string,
  headers: Record<string, string> = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({
    name: "tiangong-wiki-test-client",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers,
    },
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await transport.close();
      await client.close();
    },
  };
}

describe("mcp-server integration", () => {
  const workspaces: Workspace[] = [];
  const foregroundDaemons: ForegroundDaemonHandle[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()!();
    }

    while (foregroundDaemons.length > 0) {
      await foregroundDaemons.pop()!.stop();
    }

    while (workspaces.length > 0) {
      const workspace = workspaces.pop()!;
      if (existsSync(daemonPidPath(workspace)) || existsSync(daemonStatePath(workspace))) {
        runCli(["daemon", "stop"], workspace.env, { allowFailure: true });
      }
      cleanupWorkspace(workspace);
    }
  });

  it("serves the V1 tool list and routes read/write tools through the daemon", async () => {
    const embedding = await startEmbeddingServer({
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
    closers.push(() => embedding.close());

    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
      EMBEDDING_BASE_URL: embedding.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "mcp-test-embedding",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);

    runCli(["init"], workspace.env);
    initializeGitRepo(workspace);
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
    writeVaultFile(workspace, "imports/spec.pdf", "Source summary candidate.");
    runCli(["sync"], workspace.env);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);
    const daemonState = readDaemonState(workspace);

    const mcp = await startMcpHttpServer({
      ...workspace.env,
      WIKI_DAEMON_BASE_URL: `http://${daemonState.host}:${daemonState.port}`,
      WIKI_MCP_PORT: "0",
    });
    closers.push(() => mcp.close());

    const connected = await connectMcpClient(mcp.mcpUrl, {
      "x-wiki-actor-id": "agent:codex",
      "x-wiki-actor-type": "agent",
      "x-request-id": "req:mcp-test-1",
    });
    closers.push(() => connected.close());

    const listed = await connected.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "wiki_find",
      "wiki_fts",
      "wiki_graph",
      "wiki_lint",
      "wiki_page_create",
      "wiki_page_info",
      "wiki_page_read",
      "wiki_page_update",
      "wiki_search",
      "wiki_sync",
      "wiki_type_list",
      "wiki_type_recommend",
      "wiki_type_show",
      "wiki_vault_list",
      "wiki_vault_queue",
    ]);

    const created = await connected.client.callTool({
      name: "wiki_page_create",
      arguments: {
        type: "concept",
        title: "MCP Create Target",
      },
    });
    expect(created.isError).toBeFalsy();
    const createdPayload = created.structuredContent as {
      created: string;
      writeMeta: {
        actorId: string;
        actorType: string;
      };
    };
    expect(createdPayload.created).toBeTruthy();
    expect(createdPayload.writeMeta.actorId).toBe("agent:codex");
    expect(createdPayload.writeMeta.actorType).toBe("agent");

    const pageRead = await connected.client.callTool({
      name: "wiki_page_read",
      arguments: {
        pageId: createdPayload.created,
      },
    });
    expect(pageRead.isError).toBeFalsy();
    const pageReadPayload = pageRead.structuredContent as {
      pageId: string;
      revision: string;
      rawMarkdown: string;
    };
    expect(pageReadPayload.pageId).toBe(createdPayload.created);
    expect(pageReadPayload.rawMarkdown).toContain("MCP Create Target");
    expect(pageReadPayload.revision).toMatch(/^[0-9a-f]{64}$/);

    const pageInfo = await connected.client.callTool({
      name: "wiki_page_info",
      arguments: {
        pageId: createdPayload.created,
      },
    });
    expect(pageInfo.isError).toBeFalsy();
    expect((pageInfo.structuredContent as { id: string }).id).toBe(createdPayload.created);

    const findResult = await connected.client.callTool({
      name: "wiki_find",
      arguments: {
        type: "concept",
        limit: 10,
      },
    });
    expect(findResult.isError).toBeFalsy();
    expect(Array.isArray((findResult.structuredContent as { result: unknown[] }).result)).toBe(true);

    const ftsResult = await connected.client.callTool({
      name: "wiki_fts",
      arguments: {
        query: "MCP",
        limit: 10,
      },
    });
    expect(ftsResult.isError).toBeFalsy();
    expect(Array.isArray((ftsResult.structuredContent as { result: unknown[] }).result)).toBe(true);

    const searchResult = await connected.client.callTool({
      name: "wiki_search",
      arguments: {
        query: "create target",
        limit: 5,
      },
    });
    expect(searchResult.isError).toBeFalsy();
    expect(Array.isArray((searchResult.structuredContent as { result: unknown[] }).result)).toBe(true);

    const graphResult = await connected.client.callTool({
      name: "wiki_graph",
      arguments: {
        root: createdPayload.created,
        depth: 1,
        direction: "both",
      },
    });
    expect(graphResult.isError).toBeFalsy();
    const graphPayload = graphResult.structuredContent as {
      root: string;
      nodes: Array<{ id?: string; nodeId?: string }>;
      edges: unknown[];
    };
    expect(typeof graphPayload.root).toBe("string");
    expect(graphPayload.root.length).toBeGreaterThan(0);
    expect(graphPayload.nodes.some((node) => node.id === createdPayload.created)).toBe(true);
    expect(graphPayload.nodes.some((node) => node.nodeId === graphPayload.root)).toBe(true);
    expect(Array.isArray(graphPayload.edges)).toBe(true);

    const typeList = await connected.client.callTool({
      name: "wiki_type_list",
      arguments: {},
    });
    expect(typeList.isError).toBeFalsy();
    expect((typeList.structuredContent as { result: Array<{ pageType: string }> }).result).toEqual(
      expect.arrayContaining([expect.objectContaining({ pageType: "concept" }), expect.objectContaining({ pageType: "method" })]),
    );

    const typeShow = await connected.client.callTool({
      name: "wiki_type_show",
      arguments: {
        pageType: "concept",
      },
    });
    expect(typeShow.isError).toBeFalsy();
    expect(typeShow.structuredContent).toMatchObject({
      pageType: "concept",
      columns: expect.objectContaining({
        confidence: "text",
        masteryLevel: "text",
      }),
      edges: expect.objectContaining({
        prerequisites: expect.objectContaining({
          edgeType: "prerequisite",
        }),
      }),
    });

    const typeRecommend = await connected.client.callTool({
      name: "wiki_type_recommend",
      arguments: {
        text: "Need a repeatable workflow and procedure for evidence review.",
        keywords: "workflow,procedure,checklist",
        limit: 3,
      },
    });
    expect(typeRecommend.isError).toBeFalsy();
    expect(typeRecommend.structuredContent).toMatchObject({
      query: {
        text: "Need a repeatable workflow and procedure for evidence review.",
        keywords: ["workflow", "procedure", "checklist"],
      },
    });
    expect(
      (typeRecommend.structuredContent as {
        recommendations: Array<{ pageType: string; similarPages: string[] }>;
      }).recommendations[0],
    ).toEqual(
      expect.objectContaining({
        pageType: "method",
        similarPages: expect.arrayContaining([expect.stringContaining("methods/evidence-review.md@")]),
      }),
    );

    const vaultList = await connected.client.callTool({
      name: "wiki_vault_list",
      arguments: {
        path: "imports/",
        ext: "pdf",
      },
    });
    expect(vaultList.isError).toBeFalsy();
    expect((vaultList.structuredContent as { result: Array<{ id: string; fileExt: string | null; filePath: string }> }).result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "imports/spec.pdf",
          fileExt: "pdf",
          filePath: expect.stringContaining(path.join("imports", "spec.pdf")),
        }),
      ]),
    );

    const vaultQueue = await connected.client.callTool({
      name: "wiki_vault_queue",
      arguments: {
        status: "pending",
      },
    });
    expect(vaultQueue.isError).toBeFalsy();
    expect(vaultQueue.structuredContent).toMatchObject({
      totalPending: expect.any(Number),
    });
    expect(
      (vaultQueue.structuredContent as {
        items: Array<{ fileId: string; status: string; fileName?: string }>;
      }).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: "imports/spec.pdf",
          status: "pending",
          fileName: "spec.pdf",
        }),
      ]),
    );

    const lintResult = await connected.client.callTool({
      name: "wiki_lint",
      arguments: {
        level: "info",
      },
    });
    expect(lintResult.isError).toBeFalsy();
    expect((lintResult.structuredContent as { summary: { pages: number } }).summary.pages).toBeGreaterThan(0);

    const conflict = await connected.client.callTool({
      name: "wiki_page_update",
      arguments: {
        pageId: createdPayload.created,
        bodyMarkdown: "Updated from MCP.\n",
        ifRevision: "stale-revision",
      },
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({
      code: "revision_conflict",
      pageId: createdPayload.created,
      currentRevision: pageReadPayload.revision,
    });

    const updated = await connected.client.callTool({
      name: "wiki_page_update",
      arguments: {
        pageId: createdPayload.created,
        bodyMarkdown: "Updated from MCP.\n",
        ifRevision: pageReadPayload.revision,
      },
    });
    expect(updated.isError).toBeFalsy();
    expect((updated.structuredContent as { writeMeta: { actorId: string } }).writeMeta.actorId).toBe("agent:codex");

    const syncResult = await connected.client.callTool({
      name: "wiki_sync",
      arguments: {
        force: true,
        skipEmbedding: false,
      },
    });
    expect(syncResult.isError).toBeFalsy();
    const syncPayload = syncResult.structuredContent as {
      mode: string;
      writeMeta: { actorId: string; actorType: string };
    };
    expect(["full", "path"].includes(syncPayload.mode)).toBe(true);
    expect(syncPayload.writeMeta.actorId).toBe("agent:codex");
    expect(syncPayload.writeMeta.actorType).toBe("agent");

    const matter = readPageMatter(workspace, createdPayload.created);
    expect(matter.content).toContain("Updated from MCP.");
  });

  it("returns a structured tool error when write actor headers are missing", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);

    runCli(["init"], workspace.env);
    initializeGitRepo(workspace);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);
    const daemonState = readDaemonState(workspace);

    const mcp = await startMcpHttpServer({
      ...workspace.env,
      WIKI_DAEMON_BASE_URL: `http://${daemonState.host}:${daemonState.port}`,
      WIKI_MCP_PORT: "0",
    });
    closers.push(() => mcp.close());

    const connected = await connectMcpClient(mcp.mcpUrl);
    closers.push(() => connected.close());

    const sync = await connected.client.callTool({
      name: "wiki_sync",
      arguments: {
        force: true,
      },
    });
    expect(sync.isError).toBe(true);
    expect(sync.structuredContent).toMatchObject({
      code: "missing_actor",
      type: "config",
    });
  });

  it("returns a structured not_configured error when wiki_type_recommend lacks embedding config", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);

    runCli(["init"], workspace.env);
    initializeGitRepo(workspace);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);
    const daemonState = readDaemonState(workspace);

    const mcp = await startMcpHttpServer({
      ...workspace.env,
      WIKI_DAEMON_BASE_URL: `http://${daemonState.host}:${daemonState.port}`,
      WIKI_MCP_PORT: "0",
    });
    closers.push(() => mcp.close());

    const connected = await connectMcpClient(mcp.mcpUrl);
    closers.push(() => connected.close());

    const recommend = await connected.client.callTool({
      name: "wiki_type_recommend",
      arguments: {
        text: "Need a method-like workflow.",
        limit: 3,
      },
    });
    expect(recommend.isError).toBe(true);
    expect(recommend.structuredContent).toMatchObject({
      code: "not_configured",
      type: "not_configured",
      message: "Embedding not configured",
    });
  });

  it("returns a structured invalid_request error when wiki_vault_queue gets an unsupported status filter", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);

    runCli(["init"], workspace.env);
    initializeGitRepo(workspace);
    writeVaultFile(workspace, "imports/spec.pdf", "Queue target.");
    runCli(["sync"], workspace.env);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);
    const daemonState = readDaemonState(workspace);

    const mcp = await startMcpHttpServer({
      ...workspace.env,
      WIKI_DAEMON_BASE_URL: `http://${daemonState.host}:${daemonState.port}`,
      WIKI_MCP_PORT: "0",
    });
    closers.push(() => mcp.close());

    const connected = await connectMcpClient(mcp.mcpUrl);
    closers.push(() => connected.close());

    const queue = await connected.client.callTool({
      name: "wiki_vault_queue",
      arguments: {
        status: "blocked",
      },
    });
    expect(queue.isError).toBe(true);
    expect(queue.structuredContent).toMatchObject({
      code: "invalid_request",
      type: "config",
      message: "Unsupported queue status: blocked",
    });
  });

  it("returns a structured degraded tool error when wiki_sync Git journaling fails", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);

    runCli(["init"], workspace.env);
    writeVaultFile(workspace, "imports/spec.pdf", "Sync target without git repo.");

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);
    const daemonState = readDaemonState(workspace);

    const mcp = await startMcpHttpServer({
      ...workspace.env,
      WIKI_DAEMON_BASE_URL: `http://${daemonState.host}:${daemonState.port}`,
      WIKI_MCP_PORT: "0",
    });
    closers.push(() => mcp.close());

    const connected = await connectMcpClient(mcp.mcpUrl, {
      "x-wiki-actor-id": "agent:codex",
      "x-wiki-actor-type": "agent",
      "x-request-id": "req:mcp-sync-git-fail",
    });
    closers.push(() => connected.close());

    const sync = await connected.client.callTool({
      name: "wiki_sync",
      arguments: {
        force: true,
      },
    });
    expect(sync.isError).toBe(true);
    expect(sync.structuredContent).toMatchObject({
      code: "git_commit_failed",
      type: "runtime",
      degraded: true,
    });
  });
});

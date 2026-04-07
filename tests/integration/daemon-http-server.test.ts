import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupWorkspace,
  createWorkspace,
  distCliPath,
  projectRoot,
  readFile,
  readJson,
  runCli,
  runCliJson,
  waitFor,
  writeVaultFile,
  type Workspace,
} from "../helpers.js";

interface DaemonStatePayload {
  pid: number;
  host: string;
  port: number;
  launchMode: "run" | "start";
  startedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: "ok" | "error" | null;
  lastError: string | null;
  syncIntervalSeconds: number;
  currentTask: string;
}

interface DaemonStatusPayload {
  running: boolean;
  pid: number | null;
  host: string | null;
  port: number | null;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastResult: "ok" | "error" | null;
  syncIntervalSeconds: number | null;
  launchMode: "run" | "start" | null;
  currentTask: string | null;
  state: DaemonStatePayload | null;
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
  return readJson<DaemonStatePayload>(readFile(daemonStatePath(workspace)));
}

async function fetchDaemonJson<T>(
  workspace: Workspace,
  routePath: string,
  init: RequestInit = {},
): Promise<{ status: number; payload: T }> {
  const state = readDaemonState(workspace);
  const response = await fetch(`http://${state.host}:${state.port}${routePath}`, init);
  const text = await response.text();
  return {
    status: response.status,
    payload: readJson<T>(text),
  };
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

    const state = readDaemonState(workspace);
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

      if (existsSync(daemonStatePath(workspace))) {
        try {
          await fetchDaemonJson(workspace, "/shutdown", {
            method: "POST",
          });
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }

      await waitForChildExit(child);
    },
    logs: () => logs,
  };
}

async function stopDaemonIfRunning(workspace: Workspace): Promise<void> {
  if (!existsSync(daemonPidPath(workspace)) && !existsSync(daemonStatePath(workspace))) {
    return;
  }

  runCli(["daemon", "stop"], workspace.env, { allowFailure: true });
  await waitFor(
    () => !existsSync(daemonPidPath(workspace)) && !existsSync(daemonStatePath(workspace)),
    5_000,
    100,
  ).catch(() => undefined);
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

async function startIdleProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  await waitFor(() => child.pid !== undefined);
  return child;
}

function daemonQueueEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    WIKI_AGENT_ENABLED: "true",
    WIKI_AGENT_API_KEY: "test-agent-key",
    WIKI_AGENT_MODEL: "gpt-5.4",
    WIKI_AGENT_BACKEND: "codex-workflow",
    ...extraEnv,
  };
}

describe("daemon HTTP server integration", () => {
  const workspaces: Workspace[] = [];
  const foregroundDaemons: ForegroundDaemonHandle[] = [];
  const childProcesses: ChildProcess[] = [];

  afterEach(async () => {
    while (foregroundDaemons.length > 0) {
      await foregroundDaemons.pop()!.stop();
    }

    while (childProcesses.length > 0) {
      const child = childProcesses.pop()!;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await waitForChildExit(child);
      }
    }

    while (workspaces.length > 0) {
      const workspace = workspaces.pop()!;
      await stopDaemonIfRunning(workspace);
      cleanupWorkspace(workspace);
    }
  });

  it("serves health/status/sync/shutdown over HTTP and keeps scheduling disabled when interval is zero", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);
    runCli(["init"], workspace.env);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const state = readDaemonState(workspace);
    expect(state.host).toBe("127.0.0.1");
    expect(state.port).toBeGreaterThan(0);
    expect(state.launchMode).toBe("run");
    expect(state.nextRunAt).toBeNull();

    const health = await fetchDaemonJson<{
      ok: boolean;
      service: string;
      pid: number;
      host: string;
      port: number;
    }>(workspace, "/health");
    expect(health.status).toBe(200);
    expect(health.payload).toEqual({
      ok: true,
      service: "wiki-daemon",
      pid: state.pid,
      host: "127.0.0.1",
      port: state.port,
    });

    const statusBefore = await fetchDaemonJson<DaemonStatusPayload>(workspace, "/status");
    expect(statusBefore.payload).toEqual(
      expect.objectContaining({
        running: true,
        pid: state.pid,
        host: "127.0.0.1",
        port: state.port,
        syncIntervalSeconds: 0,
        nextSyncAt: null,
        launchMode: "run",
        currentTask: "idle",
      }),
    );

    const sync = await fetchDaemonJson<{ mode: string; inserted: number; updated: number; deleted: number }>(
      workspace,
      "/sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      },
    );
    expect(sync.status).toBe(200);
    expect(["full", "incremental"]).toContain(sync.payload.mode);

    const trigger = await fetchDaemonJson<{ status: string; currentTask: string }>(workspace, "/sync/trigger", {
      method: "POST",
    });
    expect(trigger.status).toBe(200);
    expect(trigger.payload).toEqual({
      status: "started",
      currentTask: "sync-trigger",
    });

    await waitFor(async () => {
      const status = await fetchDaemonJson<DaemonStatusPayload>(workspace, "/status");
      return status.payload.state?.lastRunAt !== null && status.payload.currentTask === "idle";
    });

    const statusAfter = await fetchDaemonJson<DaemonStatusPayload>(workspace, "/status");
    expect(statusAfter.payload.state?.lastResult).toBe("ok");
    expect(statusAfter.payload.state?.lastRunAt).not.toBeNull();
    expect(statusAfter.payload.nextSyncAt).toBeNull();

    const shutdown = await fetchDaemonJson<{ status: string; pid: number }>(workspace, "/shutdown", {
      method: "POST",
    });
    expect(shutdown.status).toBe(200);
    expect(shutdown.payload.status).toBe("stopping");

    await daemon.waitForExit();
    await waitFor(() => !existsSync(daemonStatePath(workspace)) && !existsSync(daemonPidPath(workspace)));
  });

  it("records launchMode=start for detached launches and stores the configured fixed port", async () => {
    const reservedPort = await reservePort();
    const fixedPort = reservedPort.port;
    await reservedPort.close();

    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
      WIKI_DAEMON_PORT: String(fixedPort),
    });
    workspaces.push(workspace);
    runCli(["init"], workspace.env);

    const started = runCliJson<{ status: string; pid: number }>(["daemon", "start"], workspace.env);
    expect(started.status).toBe("started");
    expect(started.pid).toBeGreaterThan(0);

    await waitFor(() => {
      const status = runCliJson<DaemonStatusPayload>(["daemon", "status", "--format", "json"], workspace.env);
      return status.running;
    });

    const status = runCliJson<DaemonStatusPayload>(["daemon", "status", "--format", "json"], workspace.env);
    expect(status).toEqual(
      expect.objectContaining({
        running: true,
        host: "127.0.0.1",
        port: fixedPort,
        launchMode: "start",
      }),
    );

    const state = readDaemonState(workspace);
    expect(state.port).toBe(fixedPort);
    expect(state.launchMode).toBe("start");
  });

  it("falls back to local reads when the daemon is degraded and refuses write commands", async () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    runCli(["init"], workspace.env);

    const idleProcess = await startIdleProcess();
    childProcesses.push(idleProcess);

    const closedPort = await reservePort();
    const degradedPort = closedPort.port;
    await closedPort.close();

    writeFileSync(daemonPidPath(workspace), `${idleProcess.pid}\n`, "utf8");
    writeFileSync(
      daemonStatePath(workspace),
      `${JSON.stringify(
        {
          pid: idleProcess.pid,
          host: "127.0.0.1",
          port: degradedPort,
          launchMode: "start",
          startedAt: "2026-04-07T00:00:00+08:00",
          lastRunAt: null,
          nextRunAt: null,
          lastResult: null,
          lastError: null,
          syncIntervalSeconds: 0,
          currentTask: "idle",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const readResult = runCli(["type", "list", "--format", "json"], workspace.env);
    const types = readJson<Array<{ pageType: string }>>(readResult.stdout);
    expect(types).toEqual(expect.arrayContaining([expect.objectContaining({ pageType: "concept" })]));
    expect(readResult.stderr).toContain("falling back to local read execution");

    const writeResult = runCli(
      ["template", "create", "--type", "brief", "--title", "Brief"],
      workspace.env,
      { allowFailure: true },
    );
    expect(writeResult.status).toBe(1);
    expect(writeResult.stderr).toContain("refusing to bypass daemon for a write operation");
    expect(existsSync(path.join(workspace.wikiRoot, "templates", "brief.md"))).toBe(false);
  });

  it("surfaces new templates immediately through the daemon and keeps export commands compatible", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);
    runCli(["init"], workspace.env);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const templateCreate = runCliJson<{ pageType: string; templatePath: string; configPath: string }>(
      ["template", "create", "--type", "brief", "--title", "Brief"],
      workspace.env,
    );
    expect(templateCreate.pageType).toBe("brief");
    expect(templateCreate.templatePath).toBe(path.join(workspace.wikiRoot, "templates", "brief.md"));
    expect(templateCreate.configPath).toBe(path.join(workspace.wikiRoot, "wiki.config.json"));

    const typeInfo = runCliJson<{ pageType: string; file: string; columns: Record<string, string> }>(
      ["type", "show", "brief", "--format", "json"],
      workspace.env,
    );
    expect(typeInfo.pageType).toBe("brief");
    expect(typeInfo.file).toBe("templates/brief.md");
    expect(typeInfo.columns).toEqual({});
    expect(runCli(["template", "show", "brief"], workspace.env).stdout).toContain("pageType: brief");

    const created = runCliJson<{ created: string; filePath: string }>(
      ["create", "--type", "brief", "--title", "Launch Brief", "--node-id", "launch-brief"],
      workspace.env,
    );
    expect(created.created).toBe("briefs/launch-brief.md");

    const indexStdout = runCli(["export-index"], workspace.env).stdout;
    expect(indexStdout).toContain("# Wiki Index");
    expect(indexStdout).toContain("Launch Brief");

    const indexPath = path.join(workspace.wikiRoot, "index.md");
    runCli(["export-index", "--output", indexPath], workspace.env);
    expect(readFile(indexPath)).toContain("Launch Brief");

    const graphStdout = readJson<{ nodes: Array<{ nodeId: string }> }>(runCli(["export-graph"], workspace.env).stdout);
    expect(graphStdout.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: "launch-brief" })]),
    );

    const graphPath = path.join(workspace.wikiRoot, "graph.json");
    const graphFile = runCliJson<{ output: string; nodes: number; edges: number }>(
      ["export-graph", "--output", graphPath],
      workspace.env,
    );
    expect(graphFile.output).toBe(graphPath);
    expect(graphFile.nodes).toBeGreaterThan(0);
    expect(readFile(graphPath)).toContain("launch-brief");
  });

  it("drains all pending queue batches in a single cycle and logs aggregate totals", async () => {
    const workspace = createWorkspace(
      daemonQueueEnv({
        WIKI_AGENT_BATCH_SIZE: "2",
        WIKI_SYNC_INTERVAL: "86400",
        WIKI_TEST_FAKE_WORKFLOW_MODE: "skip",
      }),
    );
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/batch-1.pdf", "Batch file one.");
    writeVaultFile(workspace, "imports/batch-2.docx", "Batch file two.");
    writeVaultFile(workspace, "imports/batch-3.pptx", "Batch file three.");
    writeVaultFile(workspace, "imports/batch-4.xlsx", "Batch file four.");
    writeVaultFile(workspace, "imports/batch-5.md", "# Batch file five");
    runCli(["init"], workspace.env);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    await waitFor(() => {
      const status = runCliJson<DaemonStatusPayload>(["daemon", "status", "--format", "json"], workspace.env);
      if (!status.running || status.currentTask !== "idle" || status.state?.lastRunAt === null) {
        return false;
      }

      const queue = runCliJson<{ totalPending: number; totalSkipped: number }>(["vault", "queue"], workspace.env);
      return queue.totalPending === 0 && queue.totalSkipped === 5;
    });

    const queue = runCliJson<{
      totalPending: number;
      totalSkipped: number;
      items: Array<{ fileId: string; status: string }>;
    }>(["vault", "queue"], workspace.env);
    expect(queue.totalPending).toBe(0);
    expect(queue.totalSkipped).toBe(5);
    expect(queue.items.filter((item) => item.status === "skipped")).toHaveLength(5);
    expect(daemon.logs()).toContain("cycle: queue summary processed=5 done=0 skipped=5 errored=0 batches=3");
  });

  it("stops after the current queue batch when shutdown is requested mid-cycle", async () => {
    const workspace = createWorkspace(
      daemonQueueEnv({
        WIKI_AGENT_BATCH_SIZE: "1",
        WIKI_SYNC_INTERVAL: "86400",
        WIKI_TEST_FAKE_WORKFLOW_MODE: "delay-skip",
        WIKI_TEST_FAKE_WORKFLOW_DELAY_MS: "300",
      }),
    );
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/stop-1.pdf", "Stop file one.");
    writeVaultFile(workspace, "imports/stop-2.docx", "Stop file two.");
    writeVaultFile(workspace, "imports/stop-3.md", "# Stop file three");
    runCli(["init"], workspace.env);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    await waitFor(() => daemon.logs().includes(": start processing"), 5_000, 20);

    const shutdown = await fetchDaemonJson<{ status: string; pid: number }>(workspace, "/shutdown", {
      method: "POST",
    });
    expect(shutdown.status).toBe(200);
    expect(shutdown.payload.status).toBe("stopping");

    await daemon.waitForExit();

    const queue = runCliJson<{
      totalPending: number;
      totalSkipped: number;
      items: Array<{ fileId: string; status: string }>;
    }>(["vault", "queue"], workspace.env);
    expect(queue.totalPending).toBe(2);
    expect(queue.totalSkipped).toBe(1);
    expect(queue.items.filter((item) => item.status === "skipped")).toHaveLength(1);
    expect(queue.items.filter((item) => item.status === "pending")).toHaveLength(2);
    expect(daemon.logs()).toContain("cycle: queue summary processed=1 done=0 skipped=1 errored=0 batches=1");
  });

  it("fails fast when daemon start cannot bind the configured port", async () => {
    const busyPort = await reservePort();
    try {
      const workspace = createWorkspace({
        WIKI_SYNC_INTERVAL: "0",
        WIKI_DAEMON_PORT: String(busyPort.port),
      });
      workspaces.push(workspace);
      runCli(["init"], workspace.env);

      const result = runCli(["daemon", "start"], workspace.env, { allowFailure: true });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Failed to start daemon");
      expect(existsSync(daemonPidPath(workspace))).toBe(false);
      expect(existsSync(daemonStatePath(workspace))).toBe(false);
    } finally {
      await busyPort.close();
    }
  });
});

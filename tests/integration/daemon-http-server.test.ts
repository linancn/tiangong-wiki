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
  initializeGitRepo,
  projectRoot,
  readFile,
  readJson,
  runGit,
  runCli,
  runCliJson,
  startEmbeddingServer,
  waitFor,
  writePage,
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

interface PageReadPayload {
  pageId: string;
  pagePath: string;
  rawMarkdown: string | null;
  frontmatter: Record<string, unknown>;
  revision: string | null;
}

interface WriteQueueJobPayload {
  jobId: string;
  taskType: string;
  status: string;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  timeoutMs: number;
  queueDepthAtEnqueue: number;
  positionInQueue: number | null;
  resultSummary: Record<string, unknown> | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
}

interface WriteQueueSummaryPayload {
  limits: { maxDepth: number; jobTimeoutMs: number };
  counts: { queued: number; running: number; recent: number };
  activeJob: WriteQueueJobPayload | null;
  queuedJobs: WriteQueueJobPayload[];
  recentJobs: WriteQueueJobPayload[];
  generatedAt: string;
}

interface ForegroundDaemonHandle {
  child: ChildProcess;
  waitForExit: () => Promise<void>;
  stop: () => Promise<void>;
  logs: () => string;
}

interface WriteMetaPayload {
  requestId: string;
  actorId: string;
  actorType: string;
  auditLogPath: string;
  git: {
    status: "committed" | "no_changes" | "degraded";
    commitHash: string | null;
    pushScheduled: boolean;
  };
}

let writeRequestCounter = 0;

function initializeDaemonWorkspace(workspace: Workspace, options: { git?: boolean } = {}): void {
  runCli(["init"], workspace.env);
  if (options.git !== false) {
    initializeGitRepo(workspace);
  }
}

function buildWriteActor(
  overrides: Partial<{ actorId: string; actorType: string; requestId: string }> = {},
): { actorId: string; actorType: string; requestId: string } {
  writeRequestCounter += 1;
  return {
    actorId: overrides.actorId ?? "user:test-client",
    actorType: overrides.actorType ?? "user",
    requestId: overrides.requestId ?? `req:test-${writeRequestCounter}`,
  };
}

function readAuditEvents(auditLogPath: string): Array<Record<string, unknown>> {
  return readFile(auditLogPath)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => readJson<Record<string, unknown>>(line));
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

async function readFirstSseChunk(workspace: Workspace, routePath: string): Promise<string> {
  const state = readDaemonState(workspace);
  const response = await fetch(`http://${state.host}:${state.port}${routePath}`);
  if (!response.ok || !response.body) {
    throw new Error(`Expected SSE response for ${routePath}, got HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value ?? new Uint8Array());
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
    windowsHide: true,
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
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }

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
    initializeDaemonWorkspace(workspace);

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
      service: "tiangong-wiki-daemon",
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

    const trigger = await fetchDaemonJson<{ status: string; task: string }>(workspace, "/sync/trigger", {
      method: "POST",
    });
    expect(trigger.status).toBe(200);
    expect(trigger.payload.status).toBe("started");
    expect((trigger.payload.task ?? (trigger.payload as { currentTask?: string }).currentTask)).toBe("sync-trigger");

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
    initializeDaemonWorkspace(workspace);

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

  it("starts the daemon from `tiangong-wiki dashboard` and serves the dashboard shell", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);
    initializeDaemonWorkspace(workspace);

    const payload = runCliJson<{
      url: string;
      opened: boolean;
      pid: number;
      host: string;
      port: number;
    }>(["dashboard", "--no-open", "--format", "json"], workspace.env);

    expect(payload.opened).toBe(false);
    expect(payload.url).toBe(`http://${payload.host}:${payload.port}/dashboard`);
    expect(payload.pid).toBeGreaterThan(0);

    await waitFor(() => {
      const status = runCliJson<DaemonStatusPayload>(["daemon", "status", "--format", "json"], workspace.env);
      return status.running === true && status.port === payload.port;
    });

    const response = await fetch(payload.url);
    expect(response.ok).toBe(true);
    expect(await response.text()).toContain("Tiangong Wiki");
  });

  it("reads canonical page source and updates pages with revision conflict checks", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);
    initializeDaemonWorkspace(workspace);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const created = await fetchDaemonJson<{ created: string; filePath: string }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "concept",
        title: "Centralized Update Target",
      }),
    });
    expect(created.status).toBe(200);

    const pageRead = await fetchDaemonJson<PageReadPayload>(
      workspace,
      `/page-read?pageId=${encodeURIComponent(created.payload.created)}`,
    );
    expect(pageRead.status).toBe(200);
    expect(pageRead.payload.pageId).toBe(created.payload.created);
    expect(pageRead.payload.rawMarkdown).toContain("Centralized Update Target");
    expect(pageRead.payload.frontmatter.title).toBe("Centralized Update Target");
    expect(pageRead.payload.revision).toMatch(/^[0-9a-f]{64}$/);

    const dashboardSource = await fetchDaemonJson<{
      pageSource: PageReadPayload;
    }>(workspace, `/api/dashboard/pages/${encodeURIComponent(created.payload.created)}/source`);
    expect(dashboardSource.status).toBe(200);
    expect(dashboardSource.payload.pageSource).toMatchObject(pageRead.payload);

    const bodyUpdate = await fetchDaemonJson<PageReadPayload>(workspace, "/page-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageId: created.payload.created,
        bodyMarkdown: "Updated body line.\n\nSecond paragraph.\n",
        ifRevision: pageRead.payload.revision,
      }),
    });
    expect(bodyUpdate.status).toBe(200);
    expect(bodyUpdate.payload.rawMarkdown).toContain("Updated body line.");
    expect(bodyUpdate.payload.revision).not.toBe(pageRead.payload.revision);

    const frontmatterUpdate = await fetchDaemonJson<PageReadPayload>(workspace, "/page-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageId: created.payload.created,
        frontmatterPatch: {
          status: "active",
          tags: ["centralized", "mcp"],
        },
        ifRevision: bodyUpdate.payload.revision,
      }),
    });
    expect(frontmatterUpdate.status).toBe(200);
    expect(frontmatterUpdate.payload.frontmatter.status).toBe("active");
    expect(frontmatterUpdate.payload.frontmatter.tags).toEqual(["centralized", "mcp"]);
    expect(frontmatterUpdate.payload.revision).not.toBe(bodyUpdate.payload.revision);

    const persisted = await fetchDaemonJson<PageReadPayload>(
      workspace,
      `/page-read?pageId=${encodeURIComponent(created.payload.created)}`,
    );
    expect(persisted.status).toBe(200);
    expect(persisted.payload.rawMarkdown).toContain("Updated body line.");
    expect(persisted.payload.frontmatter.status).toBe("active");
    expect(persisted.payload.frontmatter.tags).toEqual(["centralized", "mcp"]);
    expect(persisted.payload.revision).toBe(frontmatterUpdate.payload.revision);

    const emptyUpdate = await fetchDaemonJson<{
      error: string;
      type: string;
      details?: { code?: string };
    }>(workspace, "/page-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageId: created.payload.created,
        ifRevision: persisted.payload.revision,
      }),
    });
    expect(emptyUpdate.status).toBe(400);
    expect(emptyUpdate.payload.details?.code).toBe("invalid_request");

    const staleUpdate = await fetchDaemonJson<{
      error: string;
      type: string;
      details?: { code?: string; currentRevision?: string | null };
    }>(workspace, "/page-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageId: created.payload.created,
        bodyMarkdown: "Stale content attempt.\n",
        ifRevision: bodyUpdate.payload.revision,
      }),
    });
    expect(staleUpdate.status).toBe(409);
    expect(staleUpdate.payload.details?.code).toBe("revision_conflict");
    expect(staleUpdate.payload.details?.currentRevision).toBe(frontmatterUpdate.payload.revision);
  });

  it("records actor metadata, audit events, and Git commit hash for successful writes", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);
    initializeDaemonWorkspace(workspace);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const actor = buildWriteActor({
      actorId: "agent:test-runner",
      actorType: "agent",
    });
    const created = await fetchDaemonJson<{
      created: string;
      filePath: string;
      writeMeta: WriteMetaPayload;
    }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor,
        type: "concept",
        title: "Audited Create Target",
      }),
    });
    expect(created.status).toBe(200);
    expect(created.payload.writeMeta).toEqual(
      expect.objectContaining({
        requestId: actor.requestId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        git: expect.objectContaining({
          status: "committed",
          commitHash: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      }),
    );

    const auditEvents = readAuditEvents(created.payload.writeMeta.auditLogPath).filter(
      (event) => event.requestId === actor.requestId,
    );
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: actor.actorId,
          actorType: actor.actorType,
          operation: "create",
          resourceId: created.payload.created,
          status: "write_applied",
        }),
        expect.objectContaining({
          actorId: actor.actorId,
          actorType: actor.actorType,
          operation: "create",
          resourceId: created.payload.created,
          status: "git_commit_succeeded",
          commitHash: created.payload.writeMeta.git.commitHash,
        }),
      ]),
    );

    const gitLog = runGit(workspace, ["log", "-1", "--pretty=%B"]).stdout.trim();
    expect(gitLog).toBe(`wiki: create ${created.payload.created} by ${actor.actorId}`);
  });

  it("returns degraded failure details when Git journaling fails after a write succeeds", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);
    initializeDaemonWorkspace(workspace, { git: false });

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const actor = buildWriteActor({
      actorId: "user:degraded-case",
      actorType: "user",
    });
    const created = await fetchDaemonJson<{
      error: string;
      type: string;
      details?: {
        code?: string;
        degraded?: boolean;
        requestId?: string;
        actorId?: string;
        auditLogPath?: string;
        writeResult?: { created?: string };
      };
    }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor,
        type: "concept",
        title: "Degraded Commit Target",
      }),
    });
    expect(created.status).toBe(500);
    expect(created.payload.details?.code).toBe("git_commit_failed");
    expect(created.payload.details?.degraded).toBe(true);
    expect(created.payload.details?.requestId).toBe(actor.requestId);
    expect(created.payload.details?.actorId).toBe(actor.actorId);

    const createdPageId = created.payload.details?.writeResult?.created;
    expect(createdPageId).toBeTruthy();
    const readAfterFailure = await fetchDaemonJson<PageReadPayload>(
      workspace,
      `/page-read?pageId=${encodeURIComponent(createdPageId!)}`,
    );
    expect(readAfterFailure.status).toBe(200);
    expect(readAfterFailure.payload.rawMarkdown).toContain("Degraded Commit Target");

    const auditEvents = readAuditEvents(created.payload.details?.auditLogPath ?? "").filter(
      (event) => event.requestId === actor.requestId,
    );
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "write_applied",
          resourceId: createdPageId,
        }),
        expect.objectContaining({
          status: "git_commit_failed",
          resourceId: createdPageId,
          actorId: actor.actorId,
        }),
      ]),
    );
  });

  it("queues overlapping writes, exposes queue state, and preserves immediate read consistency", async () => {
    const server = await startEmbeddingServer({
      dimensions: 4,
      handler: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        return {
          data: inputs.map((input: string, index: number) => ({
            index,
            embedding: Array.from({ length: 4 }, (_, offset) => {
              const seed = [...String(input)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
              return Number(((seed + offset + 1) / 1000).toFixed(6));
            }),
          })),
        };
      },
    });
    servers.push(server);

    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "queue-test-embedding",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    initializeDaemonWorkspace(workspace);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const firstCreate = fetchDaemonJson<{ created: string; filePath: string }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "concept",
        title: "Queued Create One",
      }),
    });

    await waitFor(async () => {
      const summary = await fetchDaemonJson<WriteQueueSummaryPayload>(workspace, "/write-queue/summary");
      return summary.payload.activeJob?.taskType === "create" && summary.payload.counts.running === 1;
    }, 10_000, 20);

    const secondCreate = fetchDaemonJson<{ created: string; filePath: string }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "concept",
        title: "Queued Create Two",
      }),
    });

    let queuedJobId = "";
    await waitFor(async () => {
      const summary = await fetchDaemonJson<WriteQueueSummaryPayload>(workspace, "/write-queue/summary");
      const queuedJob = summary.payload.queuedJobs.find((job) => job.taskType === "create");
      if (!queuedJob) {
        return false;
      }
      queuedJobId = queuedJob.jobId;
      return summary.payload.counts.queued === 1 && queuedJob.positionInQueue === 1;
    }, 10_000, 20);

    const queuedDetail = await fetchDaemonJson<WriteQueueJobPayload>(
      workspace,
      `/write-queue/jobs/${encodeURIComponent(queuedJobId)}`,
    );
    expect(queuedDetail.status).toBe(200);
    expect(queuedDetail.payload.status).toBe("queued");
    expect(queuedDetail.payload.taskType).toBe("create");

    const [firstResult, secondResult] = await Promise.all([firstCreate, secondCreate]);
    expect(firstResult.status).toBe(200);
    expect(secondResult.status).toBe(200);
    expect(firstResult.payload.created).not.toBe(secondResult.payload.created);

    const summaryAfter = await fetchDaemonJson<WriteQueueSummaryPayload>(workspace, "/write-queue/summary");
    expect(summaryAfter.status).toBe(200);
    expect(summaryAfter.payload.counts.queued).toBe(0);
    expect(summaryAfter.payload.counts.running).toBe(0);
    expect(summaryAfter.payload.recentJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskType: "create",
          status: "succeeded",
        }),
      ]),
    );

    const readSecond = await fetchDaemonJson<PageReadPayload>(
      workspace,
      `/page-read?pageId=${encodeURIComponent(secondResult.payload.created)}`,
    );
    expect(readSecond.status).toBe(200);
    expect(readSecond.payload.rawMarkdown).toContain("Queued Create Two");
  });

  it("rechecks revision at execution time for queued updates and queues sync-trigger behind writes", async () => {
    const server = await startEmbeddingServer({
      dimensions: 4,
      handler: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        return {
          data: inputs.map((input: string, index: number) => ({
            index,
            embedding: Array.from({ length: 4 }, (_, offset) => {
              const seed = [...String(input)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
              return Number(((seed + offset + 1) / 1000).toFixed(6));
            }),
          })),
        };
      },
    });
    servers.push(server);

    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "queue-test-embedding",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    initializeDaemonWorkspace(workspace);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const created = await fetchDaemonJson<{ created: string }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "concept",
        title: "Queued Revision Target",
      }),
    });
    expect(created.status).toBe(200);

    const initialRead = await fetchDaemonJson<PageReadPayload>(
      workspace,
      `/page-read?pageId=${encodeURIComponent(created.payload.created)}`,
    );
    expect(initialRead.status).toBe(200);

    const firstUpdate = fetchDaemonJson<PageReadPayload>(workspace, "/page-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageId: created.payload.created,
        bodyMarkdown: "Queued update body.\n",
        ifRevision: initialRead.payload.revision,
      }),
    });

    await waitFor(async () => {
      const summary = await fetchDaemonJson<WriteQueueSummaryPayload>(workspace, "/write-queue/summary");
      return summary.payload.activeJob?.taskType === "update";
    }, 10_000, 20);

    const staleUpdate = fetchDaemonJson<{
      error: string;
      type: string;
      details?: { code?: string; currentRevision?: string | null };
    }>(workspace, "/page-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageId: created.payload.created,
        bodyMarkdown: "Stale queued update.\n",
        ifRevision: initialRead.payload.revision,
      }),
    });

    const trigger = fetchDaemonJson<{ status: string; task: string }>(workspace, "/sync/trigger", {
      method: "POST",
    });

    let triggerJobId = "";
    await waitFor(async () => {
      const summary = await fetchDaemonJson<WriteQueueSummaryPayload>(workspace, "/write-queue/summary");
      const triggerJob = summary.payload.queuedJobs.find((job) => job.taskType === "sync-trigger");
      if (!triggerJob) {
        return false;
      }
      triggerJobId = triggerJob.jobId;
      return summary.payload.counts.queued >= 2;
    }, 10_000, 20);

    const triggerQueuedDetail = await fetchDaemonJson<WriteQueueJobPayload>(
      workspace,
      `/write-queue/jobs/${encodeURIComponent(triggerJobId)}`,
    );
    expect(triggerQueuedDetail.status).toBe(200);
    expect(triggerQueuedDetail.payload.status).toBe("queued");
    expect(triggerQueuedDetail.payload.taskType).toBe("sync-trigger");

    const [firstUpdateResult, staleUpdateResult, triggerResult] = await Promise.all([
      firstUpdate,
      staleUpdate,
      trigger,
    ]);
    expect(firstUpdateResult.status).toBe(200);
    expect(staleUpdateResult.status).toBe(409);
    expect(staleUpdateResult.payload.details?.code).toBe("revision_conflict");
    expect(staleUpdateResult.payload.details?.currentRevision).toBe(firstUpdateResult.payload.revision);
    expect(triggerResult.status).toBe(200);
    expect(triggerResult.payload.task).toBe("sync-trigger");

    const finalRead = await fetchDaemonJson<PageReadPayload>(
      workspace,
      `/page-read?pageId=${encodeURIComponent(created.payload.created)}`,
    );
    expect(finalRead.status).toBe(200);
    expect(finalRead.payload.rawMarkdown).toContain("Queued update body.");
    expect(finalRead.payload.revision).toBe(firstUpdateResult.payload.revision);

    const summaryAfter = await fetchDaemonJson<WriteQueueSummaryPayload>(workspace, "/write-queue/summary");
    expect(summaryAfter.payload.recentJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskType: "update", status: "failed" }),
        expect.objectContaining({ taskType: "sync-trigger", status: "succeeded" }),
      ]),
    );
  });

  it("returns 503 queue_full when the write queue exceeds the configured depth limit", async () => {
    const server = await startEmbeddingServer({
      dimensions: 4,
      handler: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        return {
          data: inputs.map((input: string, index: number) => ({
            index,
            embedding: Array.from({ length: 4 }, (_, offset) => {
              const seed = [...String(input)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
              return Number(((seed + offset + 1) / 1000).toFixed(6));
            }),
          })),
        };
      },
    });
    servers.push(server);

    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
      WIKI_TEST_WRITE_QUEUE_MAX_DEPTH: "1",
      EMBEDDING_BASE_URL: server.url,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "queue-test-embedding",
      EMBEDDING_DIMENSIONS: "4",
    });
    workspaces.push(workspace);
    initializeDaemonWorkspace(workspace);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const firstCreate = fetchDaemonJson<{ created: string }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "concept",
        title: "Queue Depth One",
      }),
    });

    await waitFor(async () => {
      const summary = await fetchDaemonJson<WriteQueueSummaryPayload>(workspace, "/write-queue/summary");
      return summary.payload.activeJob?.taskType === "create";
    }, 10_000, 20);

    const secondCreate = fetchDaemonJson<{ created: string }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "concept",
        title: "Queue Depth Two",
      }),
    });

    await waitFor(async () => {
      const summary = await fetchDaemonJson<WriteQueueSummaryPayload>(workspace, "/write-queue/summary");
      return summary.payload.counts.queued === 1;
    }, 10_000, 20);

    const thirdCreate = await fetchDaemonJson<{
      error: string;
      type: string;
      details?: { code?: string; maxDepth?: number };
    }>(workspace, "/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "concept",
        title: "Queue Depth Three",
      }),
    });

    expect(thirdCreate.status).toBe(503);
    expect(thirdCreate.payload.details?.code).toBe("queue_full");
    expect(thirdCreate.payload.details?.maxDepth).toBe(1);

    const [firstResult, secondResult] = await Promise.all([firstCreate, secondCreate]);
    expect(firstResult.status).toBe(200);
    expect(secondResult.status).toBe(200);
  });

  it("falls back to local reads when the daemon is degraded and refuses write commands", async () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    initializeDaemonWorkspace(workspace, { git: false });

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
    initializeDaemonWorkspace(workspace);

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
    const templateLint = runCliJson<{
      errors: Array<unknown>;
      warnings: Array<unknown>;
      summary: { templates: number; errors: number; warnings: number };
    }>(["template", "lint", "brief", "--format", "json"], workspace.env);
    expect(templateLint.summary.templates).toBe(1);
    expect(templateLint.errors).toEqual([]);
    expect(templateLint.warnings).toEqual([]);

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
    initializeDaemonWorkspace(workspace);

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
    expect(daemon.logs()).toContain("cycle: queue summary processed=5 done=0 skipped=5 errored=0 batches=1");
  });

  it("serves dashboard API contracts and log history from the daemon", async () => {
    const workspace = createWorkspace({
      WIKI_SYNC_INTERVAL: "0",
    });
    workspaces.push(workspace);

    initializeDaemonWorkspace(workspace);
    writeVaultFile(workspace, "imports/alpha.md", "# Alpha Source\n\nThis is a local vault source.");
    writePage(
      workspace,
      "concepts/graph-thinking.md",
      `---
pageType: concept
title: Graph Thinking
nodeId: graph-thinking
status: active
visibility: private
sourceRefs: []
relatedPages:
  - source-summaries/alpha-source.md
tags:
  - graph
createdAt: 2026-04-08
updatedAt: 2026-04-08
confidence: high
masteryLevel: medium
prerequisites: []
---

## Core

Graph thinking connects ideas.
`,
    );
    writePage(
      workspace,
      "source-summaries/alpha-source.md",
      `---
pageType: source-summary
title: Alpha Source Summary
nodeId: alpha-source
status: active
visibility: private
sourceRefs: []
relatedPages:
  - concepts/graph-thinking.md
tags:
  - alpha
createdAt: 2026-04-08
updatedAt: 2026-04-08
sourceType: local
vaultPath: imports/alpha.md
keyFindings: []
---

## 来源信息

Alpha source overview.
`,
    );
    runCli(["sync"], workspace.env);

    const daemon = await startForegroundDaemon(workspace);
    foregroundDaemons.push(daemon);

    const overview = await fetchDaemonJson<{
      totalNodes: number;
      visibleNodeCount: number;
      truncated: boolean;
      nodes: Array<{ id: string; title: string }>;
    }>(workspace, "/api/dashboard/graph/overview?limit=10");
    expect(overview.status).toBe(200);
    expect(overview.payload.totalNodes).toBe(2);
    expect(overview.payload.visibleNodeCount).toBe(2);
    expect(overview.payload.truncated).toBe(false);
    expect(overview.payload.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "concepts/graph-thinking.md", title: "Graph Thinking" })]),
    );

    const search = await fetchDaemonJson<{
      query: string;
      resultCount: number;
      results: Array<{ id: string; title: string; summaryText?: string }>;
    }>(workspace, "/api/dashboard/graph/search?query=Graph&limit=10");
    expect(search.status).toBe(200);
    expect(search.payload.query).toBe("Graph");
    expect(search.payload.resultCount).toBeGreaterThan(0);
    expect(search.payload.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "concepts/graph-thinking.md",
          title: "Graph Thinking",
          summaryText: expect.any(String),
        }),
      ]),
    );

    const pageDetail = await fetchDaemonJson<{
      page: { id: string; title: string; nodeKey: string };
      relationCounts: { outgoing: number; incoming: number };
    }>(
      workspace,
      `/api/dashboard/pages/${encodeURIComponent("source-summaries/alpha-source.md")}`,
    );
    expect(pageDetail.status).toBe(200);
    expect(pageDetail.payload.page).toEqual(
      expect.objectContaining({
        id: "source-summaries/alpha-source.md",
        title: "Alpha Source Summary",
        nodeKey: "alpha-source",
      }),
    );
    expect(pageDetail.payload.relationCounts.outgoing).toBeGreaterThan(0);

    const pageSource = await fetchDaemonJson<{
      pageSource: { pageId: string; rawMarkdown: string | null };
      vaultSource: { fileId: string; previewAvailable: boolean; preview: string };
    }>(
      workspace,
      `/api/dashboard/pages/${encodeURIComponent("source-summaries/alpha-source.md")}/source`,
    );
    expect(pageSource.status).toBe(200);
    expect(pageSource.payload.pageSource.pageId).toBe("source-summaries/alpha-source.md");
    expect(pageSource.payload.pageSource.rawMarkdown).toContain("Alpha Source Summary");
    expect(pageSource.payload.vaultSource.fileId).toBe("imports/alpha.md");
    expect(pageSource.payload.vaultSource.preview).toContain("Alpha Source");

    const queueSummary = await fetchDaemonJson<{
      counts: { total: number; pending: number };
      generatedAt: string;
    }>(workspace, "/api/dashboard/queue/summary");
    expect(queueSummary.status).toBe(200);
    expect(queueSummary.payload.counts.total).toBeGreaterThanOrEqual(1);
    expect(queueSummary.payload.generatedAt).toBeTruthy();

    const vaultSummary = await fetchDaemonJson<{
      totalFiles: number;
      coverage: { pending: number };
    }>(workspace, "/api/dashboard/vault/summary");
    expect(vaultSummary.status).toBe(200);
    expect(vaultSummary.payload.totalFiles).toBe(1);
    expect(vaultSummary.payload.coverage.pending).toBeGreaterThanOrEqual(0);

    const vaultFiles = await fetchDaemonJson<{
      total: number;
      items: Array<{ fileId: string; generatedPageCount: number }>;
    }>(workspace, "/api/dashboard/vault/files?limit=10");
    expect(vaultFiles.status).toBe(200);
    expect(vaultFiles.payload.total).toBe(1);
    expect(vaultFiles.payload.items[0]).toEqual(
      expect.objectContaining({
        fileId: "imports/alpha.md",
        generatedPageCount: 1,
      }),
    );

    const lintSummary = await fetchDaemonJson<{
      counts: { total: number; error: number; warning: number; info: number };
    }>(workspace, "/api/dashboard/lint/summary");
    expect(lintSummary.status).toBe(200);
    expect(lintSummary.payload.counts.total).toBeGreaterThanOrEqual(0);

    const status = await fetchDaemonJson<{
      daemon: { running: boolean; currentTask: string | null };
      stats: { totalPages: number };
      queue: { pending: number };
      doctor: {
        checks: Array<{ id: string; severity: string; summary: string }>;
      };
    }>(workspace, "/api/dashboard/status");
    expect(status.status).toBe(200);
    expect(status.payload.daemon.running).toBe(true);
    expect(status.payload.stats.totalPages).toBe(2);
    expect(status.payload.doctor.checks[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        severity: expect.any(String),
        summary: expect.any(String),
      }),
    );

    const refresh = await fetchDaemonJson<{ daemon: { running: boolean } }>(workspace, "/api/dashboard/status/refresh", {
      method: "POST",
    });
    expect(refresh.status).toBe(200);
    expect(refresh.payload.daemon.running).toBe(true);

    await fetchDaemonJson<{ status: string; task: string }>(workspace, "/sync/trigger", {
      method: "POST",
    });
    await waitFor(async () => {
      const daemonStatus = await fetchDaemonJson<DaemonStatusPayload>(workspace, "/status");
      return daemonStatus.payload.currentTask === "idle" && daemonStatus.payload.state?.lastRunAt !== null;
    });

    const sseChunk = await readFirstSseChunk(workspace, "/api/dashboard/logs/stream?history=20");
    expect(sseChunk).toContain("event: history");
    expect(sseChunk).toContain("sync-trigger");
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
    initializeDaemonWorkspace(workspace);

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
      initializeDaemonWorkspace(workspace);

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

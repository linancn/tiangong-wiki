import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getMeta } from "../core/db.js";
import { openRuntimeDb } from "../core/runtime.js";
import { exportGraphContent, exportIndexContent } from "../operations/export.js";
import {
  getDashboardGraphOverview,
  getDashboardLintSummary,
  getDashboardPageDetail,
  getDashboardPageSource,
  getDashboardQueueItemDetail,
  getDashboardQueueSummary,
  getDashboardStatus,
  getDashboardVaultFileDetail,
  getDashboardVaultSummary,
  listDashboardLintIssues,
  listDashboardQueueItems,
  listDashboardVaultFiles,
  openDashboardPageSource,
  openDashboardVaultFile,
  retryDashboardQueueItem,
  searchDashboardGraph,
} from "../operations/dashboard.js";
import {
  diffVaultFiles,
  findPages,
  ftsSearchPages,
  getPageInfo,
  getVaultQueue,
  getWikiStat,
  listPages,
  listVaultFiles,
  renderLintResult,
  runLint,
  searchPages,
  traverseGraph,
} from "../operations/query.js";
import {
  createTemplate,
  listTemplates,
  listTypes,
  recommendTypes,
  showTemplate,
  showType,
} from "../operations/type-template.js";
import { runTemplateLint } from "../operations/template-lint.js";
import { createPage, runSync, runSyncCommand } from "../operations/write.js";
import type { DaemonLaunchMode, DaemonState, DaemonTask } from "../types/page.js";
import { AppError, asAppError } from "../utils/errors.js";
import { pathExistsSync } from "../utils/fs.js";
import { addSeconds, toOffsetIso } from "../utils/time.js";
import { resolveRuntimePaths } from "../core/paths.js";
import { processVaultQueueBatch } from "../core/vault-processing.js";
import { clearDaemonArtifacts, createInitialDaemonState, writeDaemonPid, writeDaemonState } from "./state.js";

interface StatusPayload {
  running: boolean;
  pid: number | null;
  host: string | null;
  port: number | null;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastResult: "ok" | "error" | null;
  syncIntervalSeconds: number | null;
  launchMode: DaemonLaunchMode | null;
  currentTask: DaemonTask | null;
  state: DaemonState | null;
}

interface DashboardLogEntry {
  id: number;
  timestamp: string;
  level: "info" | "error";
  message: string;
  line: string;
  fileId: string | null;
}

interface DashboardLogFilters {
  level: "info" | "error" | null;
  query: string;
  fileId: string | null;
}

interface DashboardLogClient {
  response: http.ServerResponse;
  filters: DashboardLogFilters;
  heartbeat: NodeJS.Timeout;
}

function logInfo(message: string): void {
  console.log(`[${toOffsetIso()}] ${message}`);
}

function logError(message: string): void {
  console.error(`[${toOffsetIso()}] ${message}`);
}

function writeJsonResponse(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeTextResponse(
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  payload: string | Buffer,
): void {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(payload);
}

function decodePathParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new AppError(
      `Failed to decode dashboard route parameter: ${error instanceof Error ? error.message : String(error)}`,
      "config",
    );
  }
}

function parsePositiveIntegerParam(value: string | null, fallback: number): number {
  if (!value || !value.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(`Expected a positive integer parameter, got ${value}`, "config");
  }
  return parsed;
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function extractDashboardLogFileId(message: string): string | null {
  const match = message.match(/^([^:\s][^:]*)\s*:/);
  return match?.[1] ?? null;
}

function matchesDashboardLog(entry: DashboardLogEntry, filters: DashboardLogFilters): boolean {
  if (filters.level && entry.level !== filters.level) {
    return false;
  }
  if (filters.fileId && entry.fileId !== filters.fileId) {
    return false;
  }
  if (filters.query) {
    const haystack = `${entry.message} ${entry.line} ${entry.fileId ?? ""}`.toLowerCase();
    return haystack.includes(filters.query);
  }
  return true;
}

function writeSseEvent(response: http.ServerResponse, event: string, payload: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new AppError(
      `Failed to parse daemon request body: ${error instanceof Error ? error.message : String(error)}`,
      "config",
    );
  }
}

function isBusyError(error: AppError): boolean {
  return (
    typeof error.details === "object" &&
    error.details !== null &&
    "code" in error.details &&
    (error.details as { code?: unknown }).code === "busy"
  );
}

async function buildStatusPayload(
  env: NodeJS.ProcessEnv,
  state: DaemonState | null,
): Promise<StatusPayload> {
  let lastSyncAt: string | null = null;
  try {
    const { db } = openRuntimeDb(env);
    try {
      lastSyncAt = getMeta(db, "last_sync_at");
    } finally {
      db.close();
    }
  } catch {
    lastSyncAt = null;
  }

  return {
    running: true,
    pid: state?.pid ?? process.pid,
    host: state?.host ?? null,
    port: state?.port ?? null,
    lastSyncAt,
    nextSyncAt: state?.nextRunAt ?? null,
    lastResult: state?.lastResult ?? null,
    syncIntervalSeconds: state?.syncIntervalSeconds ?? null,
    launchMode: state?.launchMode ?? null,
    currentTask: state?.currentTask ?? null,
    state,
  };
}

export async function runDaemonServer(options: {
  env?: NodeJS.ProcessEnv;
  launchMode: DaemonLaunchMode;
}): Promise<void> {
  const env = options.env ?? process.env;
  const paths = resolveRuntimePaths(env);
  const interval = paths.syncIntervalSeconds;

  let state: DaemonState | null = null;
  let cycleTimer: NodeJS.Timeout | null = null;
  let queuedCycle = false;
  let stopping = false;
  let currentWrite: Promise<unknown> | null = null;
  let server: http.Server;
  let resolveClosed: (() => void) | null = null;
  let nextDashboardLogId = 1;
  const dashboardDistPath = path.join(paths.packageRoot, "dist", "dashboard");
  const dashboardLogHistory: DashboardLogEntry[] = [];
  const dashboardLogClients = new Set<DashboardLogClient>();

  const broadcastDashboardLog = (entry: DashboardLogEntry) => {
    dashboardLogHistory.push(entry);
    if (dashboardLogHistory.length > 400) {
      dashboardLogHistory.shift();
    }
    for (const client of dashboardLogClients) {
      if (matchesDashboardLog(entry, client.filters)) {
        writeSseEvent(client.response, "log", entry);
      }
    }
  };

  const logInfo = (message: string) => {
    const timestamp = toOffsetIso();
    const entry: DashboardLogEntry = {
      id: nextDashboardLogId++,
      timestamp,
      level: "info",
      message,
      line: `[${timestamp}] ${message}`,
      fileId: extractDashboardLogFileId(message),
    };
    broadcastDashboardLog(entry);
    console.log(entry.line);
  };

  const logError = (message: string) => {
    const timestamp = toOffsetIso();
    const entry: DashboardLogEntry = {
      id: nextDashboardLogId++,
      timestamp,
      level: "error",
      message,
      line: `[${timestamp}] ${message}`,
      fileId: extractDashboardLogFileId(message),
    };
    broadcastDashboardLog(entry);
    console.error(entry.line);
  };

  const serveDashboardApp = (requestPath: string, response: http.ServerResponse) => {
    if (!pathExistsSync(dashboardDistPath)) {
      throw new AppError(
        `Dashboard assets not found at ${dashboardDistPath}. Build the dashboard bundle before opening /dashboard.`,
        "not_found",
      );
    }

    const relativeRequestPath = requestPath === "/dashboard" ? "" : requestPath.replace(/^\/dashboard\/?/, "");
    const decodedRequestPath = relativeRequestPath ? decodePathParam(relativeRequestPath) : "";
    const requestedFilePath = decodedRequestPath
      ? path.resolve(dashboardDistPath, decodedRequestPath)
      : path.join(dashboardDistPath, "index.html");
    const safeRelative = path.relative(dashboardDistPath, requestedFilePath);
    if (safeRelative.startsWith("..") || path.isAbsolute(safeRelative)) {
      throw new AppError(`Dashboard path is outside dist root: ${requestPath}`, "config");
    }

    const requestedLooksLikeFile = path.extname(decodedRequestPath) !== "";
    const filePath = requestedLooksLikeFile
      ? requestedFilePath
      : path.join(dashboardDistPath, "index.html");
    if (!pathExistsSync(filePath)) {
      throw new AppError(
        requestedLooksLikeFile
          ? `Dashboard asset not found at ${filePath}`
          : `Dashboard entrypoint missing at ${filePath}`,
        "not_found",
      );
    }

    writeTextResponse(response, 200, contentTypeForPath(filePath), readFileSync(filePath));
  };

  const streamDashboardLogs = (request: http.IncomingMessage, response: http.ServerResponse, url: URL) => {
    const filters: DashboardLogFilters = {
      level: (() => {
        const level = url.searchParams.get("level");
        if (!level) {
          return null;
        }
        if (level === "info" || level === "error") {
          return level;
        }
        throw new AppError(`Unsupported dashboard log level: ${level}`, "config");
      })(),
      query: (url.searchParams.get("query") ?? "").trim().toLowerCase(),
      fileId: (() => {
        const rawFileId = url.searchParams.get("fileId");
        return rawFileId && rawFileId.trim() ? rawFileId.trim() : null;
      })(),
    };
    const historyLimit = parsePositiveIntegerParam(url.searchParams.get("history"), 120);

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write("retry: 1000\n\n");

    const client: DashboardLogClient = {
      response,
      filters,
      heartbeat: setInterval(() => {
        response.write(": ping\n\n");
      }, 15_000),
    };
    dashboardLogClients.add(client);

    const history = dashboardLogHistory
      .filter((entry) => matchesDashboardLog(entry, filters))
      .slice(-historyLimit);
    writeSseEvent(response, "history", history);

    const cleanup = () => {
      clearInterval(client.heartbeat);
      dashboardLogClients.delete(client);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
  };

  const persistState = () => {
    if (state) {
      writeDaemonState(paths.daemonStatePath, state);
    }
  };

  const clearTimer = () => {
    if (cycleTimer) {
      clearTimeout(cycleTimer);
      cycleTimer = null;
    }
  };

  const scheduleNextCycle = () => {
    clearTimer();
    if (stopping || interval <= 0 || !state) {
      if (state) {
        state.nextRunAt = null;
        persistState();
      }
      return;
    }

    const nextRun = addSeconds(new Date(), interval);
    state.nextRunAt = toOffsetIso(nextRun);
    persistState();
    cycleTimer = setTimeout(() => {
      cycleTimer = null;
      if (stopping) {
        return;
      }
      if (currentWrite) {
        queuedCycle = true;
        if (state) {
          state.nextRunAt = null;
          persistState();
        }
        return;
      }
      void runDefaultCycle("cycle").catch((error: unknown) => {
        const appError = asAppError(error);
        logError(`scheduled cycle failed: ${appError.message}`);
      });
    }, interval * 1000);
  };

  const afterWriteComplete = (task: DaemonTask) => {
    if (queuedCycle && !stopping) {
      queuedCycle = false;
      void runDefaultCycle("cycle").catch((error: unknown) => {
        const appError = asAppError(error);
        logError(`queued cycle failed: ${appError.message}`);
      });
      return;
    }

    if (task === "cycle" || task === "sync-trigger") {
      scheduleNextCycle();
    } else {
      persistState();
    }
  };

  const runWriteTask = async <T>(task: DaemonTask, run: () => Promise<T>): Promise<T> => {
    if (stopping) {
      throw new AppError("Wiki daemon is shutting down.", "runtime");
    }
    if (currentWrite) {
      throw new AppError(`Wiki daemon is busy running ${state?.currentTask ?? "another task"}.`, "runtime", {
        code: "busy",
        currentTask: state?.currentTask ?? "unknown",
      });
    }

    const promise = (async () => {
      if (state) {
        state.currentTask = task;
        if (task === "cycle" || task === "sync-trigger") {
          state.nextRunAt = null;
        }
        persistState();
      }

      try {
        const result = await run();
        if (state) {
          state.lastRunAt = toOffsetIso();
          state.lastResult = "ok";
          state.lastError = null;
          state.currentTask = "idle";
        }
        return result;
      } catch (error) {
        const appError = asAppError(error);
        if (state) {
          state.lastRunAt = toOffsetIso();
          state.lastResult = "error";
          state.lastError = appError.message;
          state.currentTask = "idle";
        }
        throw appError;
      } finally {
        currentWrite = null;
        afterWriteComplete(task);
      }
    })();

    currentWrite = promise;
    return promise;
  };

  const runDefaultCycle = async (task: Extract<DaemonTask, "cycle" | "sync-trigger">) => {
    return runWriteTask(task, async () => {
      logInfo(`${task}: start`);
      const syncResult = await runSync(env);
      logInfo(
        `${task}: sync ok mode=${syncResult.mode} inserted=${syncResult.inserted} updated=${syncResult.updated} deleted=${syncResult.deleted} vaultChanges=${syncResult.vault.changes}`,
      );
      const queueResult = {
        enabled: false,
        processed: 0,
        done: 0,
        skipped: 0,
        errored: 0,
        batches: 0,
      };

      while (!stopping) {
        const batchResult = await processVaultQueueBatch(env, {
          log: (message) => logInfo(`queue ${message}`),
        });
        if (!batchResult.enabled) {
          break;
        }

        queueResult.enabled = true;
        if (batchResult.processed === 0) {
          break;
        }

        queueResult.processed += batchResult.processed;
        queueResult.done += batchResult.done;
        queueResult.skipped += batchResult.skipped;
        queueResult.errored += batchResult.errored;
        queueResult.batches += 1;
      }

      if (queueResult.enabled) {
        logInfo(
          `${task}: queue summary processed=${queueResult.processed} done=${queueResult.done} skipped=${queueResult.skipped} errored=${queueResult.errored} batches=${queueResult.batches}`,
        );
      }
      return {
        status: "started",
        task,
        sync: syncResult,
        queue: queueResult,
      };
    });
  };

  const beginShutdown = async () => {
    if (stopping) {
      return;
    }

    stopping = true;
    clearTimer();
    if (state) {
      state.currentTask = "shutdown";
      state.nextRunAt = null;
      persistState();
    }

    try {
      await currentWrite?.catch(() => undefined);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      clearDaemonArtifacts(paths);
      resolveClosed?.();
    }
  };

  const handleRequest = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${paths.daemonHost}`);
    const pathname = url.pathname;
    const method = request.method ?? "GET";

    try {
      if (method === "GET" && pathname === "/health") {
        writeJsonResponse(response, 200, {
          ok: true,
          service: "tiangong-wiki-daemon",
          pid: state?.pid ?? process.pid,
          host: state?.host ?? paths.daemonHost,
          port: state?.port ?? null,
        });
        return;
      }

      if (method === "GET" && pathname === "/status") {
        writeJsonResponse(response, 200, await buildStatusPayload(env, state));
        return;
      }

      if (method === "POST" && pathname === "/shutdown") {
        writeJsonResponse(response, 200, {
          status: "stopping",
          pid: state?.pid ?? process.pid,
        });
        void beginShutdown();
        return;
      }

      if (method === "POST" && pathname === "/sync") {
        const body = await readJsonBody(request);
        const pathValue =
          typeof body.path === "string" && body.path.trim()
            ? body.path.trim()
            : Array.isArray(body.targetPaths) && typeof body.targetPaths[0] === "string"
              ? String(body.targetPaths[0])
              : undefined;
        const result = await runWriteTask("sync", async () =>
          runSyncCommand(env, {
            targetPaths: pathValue ? [pathValue] : undefined,
            force: body.force === true,
            skipEmbedding: body.skipEmbedding === true,
            process: body.process === true,
            vaultFileId: typeof body.vaultFileId === "string" && body.vaultFileId.trim() ? body.vaultFileId.trim() : undefined,
          }),
        );
        writeJsonResponse(response, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/sync/trigger") {
        if (currentWrite) {
          throw new AppError(`Wiki daemon is busy running ${state?.currentTask ?? "another task"}.`, "runtime", {
            code: "busy",
            currentTask: state?.currentTask ?? "unknown",
          });
        }
        void runDefaultCycle("sync-trigger").catch((error) => {
          const appError = asAppError(error);
          logError(`sync-trigger failed: ${appError.message}`);
        });
        writeJsonResponse(response, 200, {
          status: "started",
          currentTask: "sync-trigger",
        });
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/status") {
        const daemonStatus = await buildStatusPayload(env, state);
        writeJsonResponse(response, 200, await getDashboardStatus(env, daemonStatus, { probe: false }));
        return;
      }

      if ((method === "GET" || method === "POST") && pathname === "/api/dashboard/status/refresh") {
        const daemonStatus = await buildStatusPayload(env, state);
        writeJsonResponse(response, 200, await getDashboardStatus(env, daemonStatus, { probe: true }));
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/graph/overview") {
        writeJsonResponse(
          response,
          200,
          await getDashboardGraphOverview(env, {
            limit: url.searchParams.get("limit") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/graph/search") {
        writeJsonResponse(
          response,
          200,
          await searchDashboardGraph(env, {
            query: url.searchParams.get("query") ?? "",
            limit: url.searchParams.get("limit") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/queue/summary") {
        writeJsonResponse(response, 200, getDashboardQueueSummary(env));
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/queue/items") {
        writeJsonResponse(
          response,
          200,
          listDashboardQueueItems(env, {
            status: url.searchParams.get("status") ?? undefined,
            query: url.searchParams.get("query") ?? undefined,
            sourceType: url.searchParams.get("sourceType") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          }),
        );
        return;
      }

      const queueRetryMatch = pathname.match(/^\/api\/dashboard\/queue\/items\/(.+)\/retry$/);
      if (method === "POST" && queueRetryMatch) {
        const fileId = decodePathParam(queueRetryMatch[1]);
        writeJsonResponse(
          response,
          200,
          await runWriteTask("queue-retry", async () => retryDashboardQueueItem(env, fileId)),
        );
        return;
      }

      const queueItemMatch = pathname.match(/^\/api\/dashboard\/queue\/items\/(.+)$/);
      if (method === "GET" && queueItemMatch) {
        const fileId = decodePathParam(queueItemMatch[1]);
        writeJsonResponse(response, 200, getDashboardQueueItemDetail(env, fileId));
        return;
      }

      const pageOpenSourceMatch = pathname.match(/^\/api\/dashboard\/pages\/(.+)\/open-source$/);
      if (method === "POST" && pageOpenSourceMatch) {
        const pageId = decodePathParam(pageOpenSourceMatch[1]);
        const body = await readJsonBody(request);
        writeJsonResponse(
          response,
          200,
          await openDashboardPageSource(
            env,
            pageId,
            body.target === "page" ? "page" : "vault",
          ),
        );
        return;
      }

      const pageSourceMatch = pathname.match(/^\/api\/dashboard\/pages\/(.+)\/source$/);
      if (method === "GET" && pageSourceMatch) {
        const pageId = decodePathParam(pageSourceMatch[1]);
        writeJsonResponse(response, 200, await getDashboardPageSource(env, pageId));
        return;
      }

      const pageDetailMatch = pathname.match(/^\/api\/dashboard\/pages\/(.+)$/);
      if (method === "GET" && pageDetailMatch) {
        const pageId = decodePathParam(pageDetailMatch[1]);
        writeJsonResponse(response, 200, getDashboardPageDetail(env, pageId));
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/vault/summary") {
        writeJsonResponse(response, 200, getDashboardVaultSummary(env));
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/vault/files") {
        writeJsonResponse(
          response,
          200,
          listDashboardVaultFiles(env, {
            query: url.searchParams.get("query") ?? undefined,
            sourceType: url.searchParams.get("sourceType") ?? undefined,
            queueStatus: url.searchParams.get("queueStatus") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          }),
        );
        return;
      }

      const vaultFileOpenMatch = pathname.match(/^\/api\/dashboard\/vault\/files\/(.+)\/open$/);
      if (method === "POST" && vaultFileOpenMatch) {
        const fileId = decodePathParam(vaultFileOpenMatch[1]);
        writeJsonResponse(response, 200, await openDashboardVaultFile(env, fileId));
        return;
      }

      const vaultFileDetailMatch = pathname.match(/^\/api\/dashboard\/vault\/files\/(.+)$/);
      if (method === "GET" && vaultFileDetailMatch) {
        const fileId = decodePathParam(vaultFileDetailMatch[1]);
        writeJsonResponse(response, 200, await getDashboardVaultFileDetail(env, fileId));
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/lint/summary") {
        writeJsonResponse(response, 200, getDashboardLintSummary(env));
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/lint/issues") {
        writeJsonResponse(
          response,
          200,
          listDashboardLintIssues(env, {
            level: url.searchParams.get("level") ?? undefined,
            groupBy: url.searchParams.get("groupBy") ?? undefined,
            rule: url.searchParams.get("rule") ?? undefined,
            pageId: url.searchParams.get("pageId") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard/logs/stream") {
        streamDashboardLogs(request, response, url);
        return;
      }

      if (method === "GET" && pathname === "/find") {
        writeJsonResponse(response, 200, findPages(env, Object.fromEntries(url.searchParams.entries())));
        return;
      }

      if (method === "GET" && pathname === "/fts") {
        writeJsonResponse(
          response,
          200,
          ftsSearchPages(env, {
            query: url.searchParams.get("query") ?? "",
            type: url.searchParams.get("type") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/search") {
        writeJsonResponse(
          response,
          200,
          await searchPages(env, {
            query: url.searchParams.get("query") ?? "",
            type: url.searchParams.get("type") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/graph") {
        writeJsonResponse(
          response,
          200,
          traverseGraph(env, {
            root: url.searchParams.get("root") ?? "",
            depth: url.searchParams.get("depth") ?? undefined,
            edgeType: url.searchParams.get("edgeType") ?? undefined,
            direction: url.searchParams.get("direction") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/page-info") {
        const pageId = url.searchParams.get("pageId");
        if (!pageId) {
          throw new AppError("pageId is required", "config");
        }
        writeJsonResponse(response, 200, getPageInfo(env, pageId));
        return;
      }

      if (method === "GET" && pathname === "/list") {
        writeJsonResponse(
          response,
          200,
          listPages(env, {
            type: url.searchParams.get("type") ?? undefined,
            sort: url.searchParams.get("sort") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/stat") {
        writeJsonResponse(response, 200, getWikiStat(env));
        return;
      }

      if (method === "GET" && pathname === "/vault/list") {
        writeJsonResponse(
          response,
          200,
          listVaultFiles(env, {
            path: url.searchParams.get("path") ?? undefined,
            ext: url.searchParams.get("ext") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/vault/diff") {
        writeJsonResponse(
          response,
          200,
          diffVaultFiles(env, {
            since: url.searchParams.get("since") ?? undefined,
            path: url.searchParams.get("path") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/vault/queue") {
        writeJsonResponse(
          response,
          200,
          getVaultQueue(env, {
            status: url.searchParams.get("status") ?? undefined,
          }),
        );
        return;
      }

      if (method === "POST" && pathname === "/create") {
        const body = await readJsonBody(request);
        const type = typeof body.type === "string" ? body.type : "";
        const title = typeof body.title === "string" ? body.title : "";
        const nodeId = typeof body.nodeId === "string" ? body.nodeId : undefined;
        const result = await runWriteTask("create", () =>
          createPage(env, {
            type,
            title,
            nodeId,
          }),
        );
        writeJsonResponse(response, 200, result);
        return;
      }

      if (method === "GET" && pathname === "/lint") {
        writeJsonResponse(
          response,
          200,
          runLint(env, {
            path: url.searchParams.get("path") ?? undefined,
            level: url.searchParams.get("level") ?? undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/type/list") {
        writeJsonResponse(response, 200, listTypes(env));
        return;
      }

      if (method === "GET" && pathname === "/type/show") {
        const pageType = url.searchParams.get("pageType");
        if (!pageType) {
          throw new AppError("pageType is required", "config");
        }
        writeJsonResponse(response, 200, showType(env, pageType));
        return;
      }

      if (method === "POST" && pathname === "/type/recommend") {
        const body = await readJsonBody(request);
        writeJsonResponse(
          response,
          200,
          await recommendTypes(env, {
            text: typeof body.text === "string" ? body.text : "",
            keywords: typeof body.keywords === "string" ? body.keywords : undefined,
            limit: typeof body.limit === "string" || typeof body.limit === "number" ? body.limit : undefined,
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/template/list") {
        writeJsonResponse(response, 200, listTemplates(env));
        return;
      }

      if (method === "GET" && pathname === "/template/show") {
        const pageType = url.searchParams.get("pageType");
        if (!pageType) {
          throw new AppError("pageType is required", "config");
        }
        writeJsonResponse(response, 200, showTemplate(env, pageType));
        return;
      }

      if (method === "GET" && pathname === "/template/lint") {
        writeJsonResponse(
          response,
          200,
          runTemplateLint(env, {
            pageType: url.searchParams.get("pageType") ?? undefined,
            level: url.searchParams.get("level") ?? undefined,
          }),
        );
        return;
      }

      if (method === "POST" && pathname === "/template/create") {
        const body = await readJsonBody(request);
        const result = await runWriteTask("template-create", () =>
          Promise.resolve(
            createTemplate(env, {
              type: typeof body.type === "string" ? body.type : "",
              title: typeof body.title === "string" ? body.title : "",
            }),
          ),
        );
        writeJsonResponse(response, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/export/index") {
        const body = await readJsonBody(request);
        writeJsonResponse(
          response,
          200,
          exportIndexContent(env, {
            groupBy: typeof body.groupBy === "string" ? body.groupBy : undefined,
          }),
        );
        return;
      }

      if (method === "POST" && pathname === "/export/graph") {
        writeJsonResponse(response, 200, exportGraphContent(env));
        return;
      }

      if (method === "GET" && (pathname === "/dashboard" || pathname.startsWith("/dashboard/"))) {
        serveDashboardApp(pathname, response);
        return;
      }

      throw new AppError(`Unknown daemon route: ${method} ${pathname}`, "not_found");
    } catch (error) {
      const appError = asAppError(error);
      const statusCode =
        appError.type === "config"
          ? 400
          : appError.type === "not_found"
            ? 404
            : isBusyError(appError)
              ? 409
              : 500;
      writeJsonResponse(response, statusCode, {
        error: appError.message,
        type: appError.type,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      });
    }
  };

  server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.daemonPort ?? 0, paths.daemonHost, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new AppError("Failed to determine daemon listening address", "runtime");
  }

  state = createInitialDaemonState(paths, {
    pid: process.pid,
    port: address.port,
    launchMode: options.launchMode,
  });
  writeDaemonPid(paths.daemonPidPath, process.pid);
  persistState();

  logInfo(`daemon listening on ${state.host}:${state.port} pid=${state.pid} mode=${state.launchMode}`);

  const signalHandler = () => {
    void beginShutdown();
  };

  process.on("SIGTERM", signalHandler);
  process.on("SIGINT", signalHandler);

  if (interval > 0) {
    void runDefaultCycle("cycle").catch((error) => {
      const appError = asAppError(error);
      logError(`initial cycle failed: ${appError.message}`);
    });
  }

  await new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  process.off("SIGTERM", signalHandler);
  process.off("SIGINT", signalHandler);
}

export { buildStatusPayload, renderLintResult };

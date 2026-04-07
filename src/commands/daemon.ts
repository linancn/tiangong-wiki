import { Command } from "commander";
import { appendFileSync, readFileSync, rmSync } from "node:fs";

import { getMeta } from "../core/db.js";
import { openRuntimeDb } from "../core/runtime.js";
import { resolveRuntimePaths } from "../core/paths.js";
import { syncWorkspace } from "../core/sync.js";
import { processVaultQueueBatch } from "../core/vault-processing.js";
import { AppError } from "../utils/errors.js";
import { pathExistsSync, writeTextFileSync } from "../utils/fs.js";
import { writeJson, ensureTextOrJson, writeText } from "../utils/output.js";
import { spawnDetachedCurrentProcess } from "../utils/process.js";
import { addSeconds, toOffsetIso } from "../utils/time.js";

interface DaemonState {
  pid: number;
  startedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: "ok" | "error" | null;
  lastError?: string;
}

function readPid(pidPath: string): number | null {
  if (!pathExistsSync(pidPath)) {
    return null;
  }

  const value = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function isRunning(pid: number | null): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(statePath: string): DaemonState | null {
  if (!pathExistsSync(statePath)) {
    return null;
  }

  return JSON.parse(readFileSync(statePath, "utf8")) as DaemonState;
}

function writeState(statePath: string, state: DaemonState): void {
  writeTextFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function clearDaemonArtifacts(paths: ReturnType<typeof resolveRuntimePaths>): void {
  rmSync(paths.daemonPidPath, { force: true });
}

async function runDaemonLoop(): Promise<void> {
  const paths = resolveRuntimePaths(process.env);
  const interval = paths.syncIntervalSeconds;
  const state: DaemonState = {
    pid: process.pid,
    startedAt: toOffsetIso(),
    lastRunAt: null,
    nextRunAt: interval > 0 ? toOffsetIso(addSeconds(new Date(), interval)) : null,
    lastResult: null,
  };

  writeTextFileSync(paths.daemonPidPath, `${process.pid}\n`);
  writeState(paths.daemonStatePath, state);

  let timer: NodeJS.Timeout | null = null;
  let stopping = false;

  const scheduleNext = () => {
    if (stopping) {
      return;
    }
    if (interval <= 0) {
      timer = setInterval(() => undefined, 1 << 30);
      return;
    }
    const nextRun = addSeconds(new Date(), interval);
    state.nextRunAt = toOffsetIso(nextRun);
    writeState(paths.daemonStatePath, state);
    timer = setTimeout(() => {
      void runCycle();
    }, interval * 1000);
  };

  const runCycle = async () => {
    state.nextRunAt = null;
    writeState(paths.daemonStatePath, state);
    try {
      const syncResult = await syncWorkspace();
      appendFileSync(
        paths.daemonLogPath,
        `[${toOffsetIso()}] sync ok: mode=${syncResult.mode} inserted=${syncResult.inserted} updated=${syncResult.updated} deleted=${syncResult.deleted} vaultChanges=${syncResult.vault.changes}\n`,
      );
      const queueResult = await processVaultQueueBatch(process.env, {
        log: (message) => appendFileSync(paths.daemonLogPath, `[${toOffsetIso()}] queue ${message}\n`),
      });
      if (queueResult.enabled) {
        appendFileSync(
          paths.daemonLogPath,
          `[${toOffsetIso()}] queue summary: processed=${queueResult.processed} done=${queueResult.done} skipped=${queueResult.skipped} errored=${queueResult.errored}\n`,
        );
      }
      state.lastRunAt = toOffsetIso();
      state.lastResult = "ok";
      delete state.lastError;
      writeState(paths.daemonStatePath, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendFileSync(paths.daemonLogPath, `[${toOffsetIso()}] sync failed: ${message}\n`);
      state.lastRunAt = toOffsetIso();
      state.lastResult = "error";
      state.lastError = message;
      writeState(paths.daemonStatePath, state);
    } finally {
      scheduleNext();
    }
  };

  const shutdown = () => {
    stopping = true;
    if (timer) {
      clearTimeout(timer);
    }
    state.nextRunAt = null;
    writeState(paths.daemonStatePath, state);
    clearDaemonArtifacts(paths);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await runCycle();
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Manage the background sync daemon");

  daemon
    .command("start")
    .description("Start the wiki sync daemon")
    .action(() => {
      const paths = resolveRuntimePaths(process.env);
      const existingPid = readPid(paths.daemonPidPath);
      if (isRunning(existingPid)) {
        throw new AppError(`Daemon is already running with PID ${existingPid}`, "runtime");
      }

      const pid = spawnDetachedCurrentProcess(["daemon", "run"], {
        env: process.env,
        logFile: paths.daemonLogPath,
      });
      if (!pid) {
        throw new AppError("Failed to start daemon", "runtime");
      }

      writeTextFileSync(paths.daemonPidPath, `${pid}\n`);
      writeJson({ status: "started", pid });
    });

  daemon
    .command("stop")
    .description("Stop the wiki sync daemon")
    .action(() => {
      const paths = resolveRuntimePaths(process.env);
      const pid = readPid(paths.daemonPidPath);
      if (!isRunning(pid)) {
        clearDaemonArtifacts(paths);
        writeJson({ status: "stopped", pid: null });
        return;
      }

      process.kill(pid!, "SIGTERM");
      clearDaemonArtifacts(paths);
      writeJson({ status: "stopping", pid });
    });

  daemon
    .command("status")
    .description("Show daemon state and scheduling information")
    .option("--format <format>", "text or json", "text")
    .action((options) => {
      const format = ensureTextOrJson(options.format);
      const paths = resolveRuntimePaths(process.env);
      const pid = readPid(paths.daemonPidPath);
      const running = isRunning(pid);
      const state = readState(paths.daemonStatePath);
      let lastSyncAt: string | null = null;
      try {
        const { db } = openRuntimeDb(process.env);
        try {
          lastSyncAt = getMeta(db, "last_sync_at");
        } finally {
          db.close();
        }
      } catch {
        lastSyncAt = null;
      }

      const payload = {
        running,
        pid,
        lastSyncAt,
        nextSyncAt: state?.nextRunAt ?? null,
        state,
      };

      if (format === "json") {
        writeJson(payload);
        return;
      }

      writeText(
        [
          "wiki daemon status",
          `running: ${running}`,
          `pid: ${pid ?? ""}`,
          `lastSyncAt: ${lastSyncAt ?? ""}`,
          `nextSyncAt: ${state?.nextRunAt ?? ""}`,
        ].join("\n"),
      );
    });

  daemon
    .command("run", { hidden: true })
    .description("Internal daemon worker entrypoint")
    .action(async () => {
      await runDaemonLoop();
    });
}

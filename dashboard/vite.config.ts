import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import preact from "@preact/preset-vite";
import { defineConfig, type ViteDevServer } from "vite";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(dashboardRoot, "..");
const fallbackWikiEnvPath = path.resolve(dashboardRoot, "../../test/.wiki.env");

function parseEnvFile(text: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function applyEnvFile(targetEnv: NodeJS.ProcessEnv, envFilePath: string): void {
  if (!existsSync(envFilePath)) {
    return;
  }

  const parsed = parseEnvFile(readFileSync(envFilePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }
}

function findNearestWikiEnv(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".wiki.env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function buildRuntimeEnv(): NodeJS.ProcessEnv {
  const runtimeEnv: NodeJS.ProcessEnv = { ...process.env };
  const requestedEnvFile = runtimeEnv.WIKI_ENV_FILE?.trim();

  if (requestedEnvFile) {
    applyEnvFile(runtimeEnv, path.resolve(packageRoot, requestedEnvFile));
  }

  if (!runtimeEnv.WIKI_PATH) {
    const nearestWikiEnv = findNearestWikiEnv(packageRoot);
    if (nearestWikiEnv) {
      applyEnvFile(runtimeEnv, nearestWikiEnv);
    }
  }

  if (!runtimeEnv.WIKI_PATH && existsSync(fallbackWikiEnvPath)) {
    applyEnvFile(runtimeEnv, fallbackWikiEnvPath);
  }

  return runtimeEnv;
}

function readDaemonState(env: NodeJS.ProcessEnv): { host: string; port: number } | null {
  const wikiPath = env.WIKI_PATH?.trim();
  if (!wikiPath) {
    return null;
  }

  const statePath = path.join(path.resolve(wikiPath, ".."), ".wiki-daemon.state.json");
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const payload = JSON.parse(readFileSync(statePath, "utf8")) as { host?: unknown; port?: unknown };
    if (typeof payload.host !== "string") {
      return null;
    }

    const port = Number(payload.port);
    if (!Number.isInteger(port) || port <= 0) {
      return null;
    }

    return {
      host: payload.host,
      port,
    };
  } catch {
    return null;
  }
}

async function isHealthyDaemon(target: { host: string; port: number }): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);

  try {
    const response = await fetch(`http://${target.host}:${target.port}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as { ok?: boolean; service?: string };
    return payload.ok === true && payload.service === "wiki-daemon";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function startDaemonIfPossible(env: NodeJS.ProcessEnv): void {
  if (!env.WIKI_PATH?.trim()) {
    return;
  }

  const cliEntry = path.resolve(packageRoot, "dist/index.js");
  if (!existsSync(cliEntry)) {
    return;
  }

  spawnSync(process.execPath, [cliEntry, "daemon", "start"], {
    cwd: packageRoot,
    env,
    stdio: "pipe",
  });
}

async function resolveDevProxyTarget(): Promise<string | undefined> {
  const runtimeEnv = buildRuntimeEnv();
  let daemonTarget = readDaemonState(runtimeEnv);

  if ((!daemonTarget || !(await isHealthyDaemon(daemonTarget))) && runtimeEnv.WIKI_PATH?.trim()) {
    startDaemonIfPossible(runtimeEnv);
    daemonTarget = readDaemonState(runtimeEnv);
  }

  if (!daemonTarget || !(await isHealthyDaemon(daemonTarget))) {
    return undefined;
  }

  return `http://${daemonTarget.host}:${daemonTarget.port}`;
}

export default defineConfig(async () => {
  const proxyTarget = await resolveDevProxyTarget();

  return {
    root: dashboardRoot,
    base: "/dashboard/",
    plugins: [
      preact(),
      {
        name: "dashboard-dev-trailing-slash",
        configureServer(server: ViteDevServer) {
          server.middlewares.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
            const requestUrl = request.url ?? "";
            if (requestUrl === "/dashboard" || requestUrl.startsWith("/dashboard?")) {
              response.statusCode = 302;
              response.setHeader("Location", requestUrl.replace(/^\/dashboard/, "/dashboard/"));
              response.end();
              return;
            }
            next();
          });
        },
      },
    ],
    build: {
      outDir: path.resolve(dashboardRoot, "../dist/dashboard"),
      emptyOutDir: true,
    },
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      ...(proxyTarget
        ? {
            proxy: {
              "/api": {
                target: proxyTarget,
                changeOrigin: true,
              },
            },
          }
        : {}),
    },
  };
});

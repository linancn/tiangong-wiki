import Database from "better-sqlite3";
import matter from "gray-matter";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sqliteVec from "sqlite-vec";

export interface Workspace {
  root: string;
  wikiRoot: string;
  wikiPath: string;
  vaultPath: string;
  env: NodeJS.ProcessEnv;
}

export interface SynologyTestFile {
  size?: number;
  mtime: number;
  content: string;
}

export interface SynologyTestState {
  username?: string;
  password?: string;
  files: Record<string, SynologyTestFile>;
}

const SANITIZED_ENV_PREFIXES = ["WIKI_", "VAULT_", "EMBEDDING_", "OPENROUTER_", "SYNOLOGY_"];
const SANITIZED_EXACT_ENV_KEYS = ["NODE_OPTIONS"];
const SANITIZED_TEST_ENV_PREFIXES = ["VITEST", "__VITEST"];

function sanitizeInheritedCliEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (
      key === "WIKI_ENV_FILE" ||
      SANITIZED_EXACT_ENV_KEYS.includes(key) ||
      SANITIZED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      SANITIZED_TEST_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete env[key];
    }
  }
  return env;
}

export function projectRoot(): string {
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
}

export function distCliPath(): string {
  return path.join(projectRoot(), "dist", "index.js");
}

function nodeExecPath(): string {
  const currentExec = path.basename(process.execPath).toLowerCase();
  if (currentExec === "node" || currentExec.startsWith("node")) {
    return process.execPath;
  }

  const npmNodeExecPath = process.env.npm_node_execpath?.trim();
  if (npmNodeExecPath) {
    return npmNodeExecPath;
  }

  return "node";
}

export function createWorkspace(extraEnv: NodeJS.ProcessEnv = {}): Workspace {
  const root = mkdtempSync(path.join(os.tmpdir(), "tiangong-wiki-test-"));
  const wikiRoot = path.join(root, "tiangong-wiki");
  const wikiPath = path.join(wikiRoot, "pages");
  const vaultPath = path.join(root, "vault");
  mkdirSync(wikiPath, { recursive: true });
  mkdirSync(vaultPath, { recursive: true });

  return {
    root,
    wikiRoot,
    wikiPath,
    vaultPath,
    env: {
      ...sanitizeInheritedCliEnv(),
      WIKI_PATH: wikiPath,
      VAULT_PATH: vaultPath,
      WIKI_SYNC_INTERVAL: "1",
      ...extraEnv,
    },
  };
}

export function cleanupWorkspace(workspace: Workspace): void {
  rmSync(workspace.root, { recursive: true, force: true });
}

export function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { allowFailure?: boolean; cwd?: string; input?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(nodeExecPath(), [distCliPath(), ...args], {
    cwd: options.cwd ?? projectRoot(),
    env,
    encoding: "utf8",
    input: options.input,
    windowsHide: true,
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `CLI failed: node dist/index.js ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function readJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function runGit(
  workspace: Workspace,
  args: string[],
  options: { allowFailure?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", workspace.wikiRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test-user",
      GIT_AUTHOR_EMAIL: "test-user@example.com",
      GIT_COMMITTER_NAME: "test-user",
      GIT_COMMITTER_EMAIL: "test-user@example.com",
    },
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function initializeGitRepo(workspace: Workspace): void {
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.name", "test-user"]);
  runGit(workspace, ["config", "user.email", "test-user@example.com"]);
}

export function runCliJson<T>(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { allowFailure?: boolean; cwd?: string } = {},
): T {
  return readJson<T>(runCli(args, env, options).stdout);
}

export function workspaceDbPath(workspace: Workspace): string {
  return path.join(workspace.wikiRoot, "index.db");
}

export function queryDb<T = Record<string, unknown>>(
  workspace: Workspace,
  sql: string,
  params: unknown[] = [],
): T[] {
  const db = new Database(workspaceDbPath(workspace), { readonly: true });
  try {
    sqliteVec.load(db);
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export function dbScalar<T = unknown>(
  workspace: Workspace,
  sql: string,
  params: unknown[] = [],
): T | null {
  const row = queryDb<Record<string, unknown>>(workspace, sql, params)[0];
  if (!row) {
    return null;
  }

  const [firstValue] = Object.values(row);
  return (firstValue as T | undefined) ?? null;
}

export function readMeta(workspace: Workspace, key: string): string | null {
  return dbScalar<string>(workspace, "SELECT value FROM sync_meta WHERE key = ?", [key]);
}

export function writePage(workspace: Workspace, relativeId: string, content: string): string {
  const filePath = path.join(workspace.wikiPath, ...relativeId.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

export function writeVaultFile(workspace: Workspace, relativePath: string, content: string): string {
  const filePath = path.join(workspace.vaultPath, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

export function readFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

export function readPageMatter(workspace: Workspace, relativeId: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const parsed = matter(readFile(path.join(workspace.wikiPath, ...relativeId.split("/"))));
  return {
    data: parsed.data as Record<string, unknown>,
    content: parsed.content,
  };
}

export function updateWikiConfig(
  workspace: Workspace,
  updater: (config: Record<string, unknown>) => Record<string, unknown> | void,
): Record<string, unknown> {
  const configPath = path.join(workspace.wikiRoot, "wiki.config.json");
  const current = JSON.parse(readFile(configPath)) as Record<string, unknown>;
  const next = updater(current) ?? current;
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function bootstrapRuntimeAssets(workspace: Workspace): void {
  const root = projectRoot();
  mkdirSync(path.join(workspace.wikiRoot, "templates"), { recursive: true });
  copyFileSync(
    path.join(root, "assets", "wiki.config.default.json"),
    path.join(workspace.wikiRoot, "wiki.config.json"),
  );

  const templateDir = path.join(root, "assets", "templates");
  const entries = [
    "concept.md",
    "misconception.md",
    "bridge.md",
    "source-summary.md",
    "lesson.md",
    "method.md",
    "person.md",
    "achievement.md",
    "resume.md",
    "research-note.md",
    "faq.md",
  ];
  for (const entry of entries) {
    copyFileSync(path.join(templateDir, entry), path.join(workspace.wikiRoot, "templates", entry));
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

export async function startEmbeddingServer(
  options:
    | number
    | {
        dimensions?: number;
        handler?: (payload: any, state: { requestCount: number }) => any | Promise<any>;
      },
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const resolved = typeof options === "number" ? { dimensions: options } : options;
  const script = `
    const http = require("node:http");
    const dimensions = Number(process.env.TEST_EMBED_DIMENSIONS || "4");
    const customHandler = ${resolved.handler ? resolved.handler.toString() : "null"};
    const state = { requestCount: 0 };
    const server = http.createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/embeddings") {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.requestCount += 1;
      try {
        let result;
        if (customHandler) {
          result = await customHandler(payload, state);
        } else {
          const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
          result = {
            data: inputs.map((input, index) => ({
              index,
              embedding: Array.from({ length: dimensions }, (_, offset) => {
                const seed = [...String(input)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
                return Number(((seed + offset + 1) / 1000).toFixed(6));
              }),
            })),
          };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write(String(address.port));
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;

  const child = spawn(nodeExecPath(), ["-e", script], {
    env: {
      ...process.env,
      TEST_EMBED_DIMENSIONS: String(resolved.dimensions ?? 4),
    },
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out starting embedding server")), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk) => {
      clearTimeout(timeout);
      resolve(Number.parseInt(String(chunk), 10));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Embedding server exited with code ${code}`));
      }
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        if (child.killed) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

export function writeSynologyState(statePath: string, state: SynologyTestState): void {
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        username: state.username ?? "tester",
        password: state.password ?? "secret",
        files: state.files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function startSynologyServer(
  workspaceRoot: string,
  initialState: SynologyTestState,
): Promise<{
  baseUrl: string;
  statePath: string;
  writeState: (state: SynologyTestState) => void;
  close: () => Promise<void>;
}> {
  const statePath = path.join(workspaceRoot, "synology-test-state.json");
  writeSynologyState(statePath, initialState);

  const script = `
    const http = require("node:http");
    const fs = require("node:fs");
    const path = require("node:path");

    const statePath = process.env.TEST_SYNOLOGY_STATE;
    const sessions = new Set();

    const sendJson = (response, payload) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    const normalizePath = (rawValue) => {
      const value = String(rawValue || "").trim();
      if (!value || !value.startsWith("/")) {
        return null;
      }
      return "/" + value.split("/").filter(Boolean).join("/");
    };

    const decodePath = (rawValue) => {
      if (!rawValue) {
        return null;
      }
      try {
        const parsed = JSON.parse(String(rawValue));
        if (Array.isArray(parsed)) {
          return normalizePath(parsed[0]);
        }
      } catch {}
      return normalizePath(rawValue);
    };

    const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));

    const folderExists = (folderPath, files) => {
      if (folderPath === "/") {
        return true;
      }
      return Object.keys(files).some((candidate) => {
        const normalized = normalizePath(candidate);
        return normalized === folderPath || normalized.startsWith(folderPath + "/");
      });
    };

    const listEntries = (folderPath, files) => {
      const directories = new Map();
      const entries = [];

      for (const [rawPath, rawInfo] of Object.entries(files)) {
        const filePath = normalizePath(rawPath);
        if (!filePath) {
          continue;
        }
        if (folderPath !== "/" && !filePath.startsWith(folderPath + "/")) {
          continue;
        }
        if (folderPath === "/" && !filePath.startsWith("/")) {
          continue;
        }

        const remainder = folderPath === "/" ? filePath.slice(1) : filePath.slice(folderPath.length + 1);
        if (!remainder) {
          continue;
        }

        const parts = remainder.split("/").filter(Boolean);
        if (parts.length === 0) {
          continue;
        }

        const childPath = folderPath === "/" ? "/" + parts[0] : folderPath + "/" + parts[0];
        if (parts.length > 1) {
          if (!directories.has(childPath)) {
            directories.set(childPath, {
              name: parts[0],
              path: childPath,
              isdir: true,
              type: "dir",
              additional: { type: "dir" },
            });
          }
          continue;
        }

        const size = Number(rawInfo.size ?? String(rawInfo.content || "").length);
        const mtime = Number(rawInfo.mtime ?? 0);
        entries.push({
          name: parts[0],
          path: childPath,
          isdir: false,
          type: "file",
          size,
          additional: {
            size,
            type: "file",
            time: { mtime },
          },
        });
      }

      return [...directories.values(), ...entries].sort((left, right) => String(left.path).localeCompare(String(right.path)));
    };

    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      const pathname = requestUrl.pathname;

      if (pathname === "/webapi/query.cgi") {
        sendJson(response, {
          success: true,
          data: {
            "SYNO.API.Auth": { path: "auth.cgi", maxVersion: 7 },
            "SYNO.FileStation.List": { path: "entry.cgi", maxVersion: 2 },
            "SYNO.FileStation.Download": { path: "entry.cgi", maxVersion: 2 },
          },
        });
        return;
      }

      if (pathname === "/webapi/auth.cgi") {
        const state = readState();
        const method = requestUrl.searchParams.get("method");
        if (method === "login") {
          const account = requestUrl.searchParams.get("account");
          const password = requestUrl.searchParams.get("passwd");
          if (account !== state.username || password !== state.password) {
            sendJson(response, { success: false, error: { code: 105 } });
            return;
          }
          const sid = "sid-" + Date.now() + "-" + Math.random().toString(16).slice(2);
          sessions.add(sid);
          sendJson(response, { success: true, data: { sid } });
          return;
        }
        if (method === "logout") {
          const sid = requestUrl.searchParams.get("_sid");
          if (sid) {
            sessions.delete(sid);
          }
          sendJson(response, { success: true, data: {} });
          return;
        }
      }

      if (pathname === "/webapi/entry.cgi") {
        const sid = requestUrl.searchParams.get("_sid");
        if (!sid || !sessions.has(sid)) {
          sendJson(response, { success: false, error: { code: 119 } });
          return;
        }

        const state = readState();
        const method = requestUrl.searchParams.get("method");

        if (method === "list") {
          const folderPath = decodePath(requestUrl.searchParams.get("folder_path"));
          if (!folderPath) {
            sendJson(response, { success: false, error: { code: 400 } });
            return;
          }
          if (!folderExists(folderPath, state.files || {})) {
            sendJson(response, { success: false, error: { code: 408 } });
            return;
          }
          const offset = Number.parseInt(requestUrl.searchParams.get("offset") || "0", 10) || 0;
          const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "500", 10) || 500;
          const entries = listEntries(folderPath, state.files || {});
          sendJson(response, {
            success: true,
            data: {
              files: entries.slice(offset, offset + limit),
              offset,
              total: entries.length,
            },
          });
          return;
        }

        if (method === "download") {
          const remotePath = decodePath(requestUrl.searchParams.get("path"));
          if (!remotePath) {
            sendJson(response, { success: false, error: { code: 400 } });
            return;
          }
          const file = (state.files || {})[remotePath];
          if (!file) {
            sendJson(response, { success: false, error: { code: 408 } });
            return;
          }
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="' + path.basename(remotePath) + '"',
          });
          response.end(Buffer.from(String(file.content || ""), "utf8"));
          return;
        }
      }

      response.writeHead(404);
      response.end("not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write(String(address.port));
    });

    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;

  const child = spawn(nodeExecPath(), ["-e", script], {
    env: {
      ...process.env,
      TEST_SYNOLOGY_STATE: statePath,
    },
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out starting Synology test server")), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk) => {
      clearTimeout(timeout);
      resolve(Number.parseInt(String(chunk), 10));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Synology test server exited with code ${code}`));
      }
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    statePath,
    writeState: (state) => writeSynologyState(statePath, state),
    close: () =>
      new Promise((resolve) => {
        if (child.killed) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

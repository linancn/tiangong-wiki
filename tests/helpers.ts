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
  const root = mkdtempSync(path.join(os.tmpdir(), "wiki-skill-"));
  const wikiRoot = path.join(root, "wiki");
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
      ...process.env,
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

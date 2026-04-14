import { fileURLToPath } from "node:url";
import path from "node:path";

import { AppError } from "../utils/errors.js";
import type { AgentProcessingSettings, RuntimePaths, WikiAgentBackend, WikiAgentSandboxMode } from "../types/page.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBooleanFlag(label: string, rawValue: string | undefined, defaultValue: boolean): boolean {
  if (rawValue === undefined) {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  throw new AppError(`${label} must be a boolean value, got ${rawValue}`, "config");
}

function parseSyncInterval(raw: string | undefined): number {
  if (!raw) {
    return 86_400;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(`WIKI_SYNC_INTERVAL must be a non-negative integer, got ${raw}`, "config");
  }

  return value;
}

function parseNonNegativeInteger(raw: string | undefined, defaultValue: number, label: string): number {
  if (!raw) {
    return defaultValue;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(`${label} must be a non-negative integer, got ${raw}`, "config");
  }

  return value;
}

function parsePositiveInteger(raw: string | undefined, defaultValue: number, label: string): number {
  if (!raw) {
    return defaultValue;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError(`${label} must be a positive integer, got ${raw}`, "config");
  }

  return value;
}

function parseOptionalPort(raw: string | undefined, label: string): number | null {
  if (!raw || !raw.trim()) {
    return null;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 65_535) {
    throw new AppError(`${label} must be an integer between 1 and 65535, got ${raw}`, "config");
  }

  return value;
}

function normalizeOptionalUrl(rawValue: string | undefined): string | null {
  const value = rawValue?.trim();
  if (!value) {
    return null;
  }

  if (!/^https?:\/\//i.test(value)) {
    throw new AppError(`WIKI_AGENT_BASE_URL must start with http:// or https://: ${rawValue}`, "config");
  }

  return value.replace(/\/+$/g, "");
}

function requireAbsolutePath(label: string, rawValue: string | undefined): string {
  if (!rawValue) {
    throw new AppError(`${label} is required`, "config");
  }

  if (!path.isAbsolute(rawValue)) {
    throw new AppError(`${label} must be an absolute path: ${rawValue}`, "config");
  }

  return path.resolve(rawValue);
}

export function parseVaultHashMode(raw: string | undefined): "content" | "mtime" {
  const value = (raw ?? "content").trim().toLowerCase();
  if (value === "content" || value === "mtime") {
    return value;
  }

  throw new AppError(`VAULT_HASH_MODE must be "content" or "mtime", got ${raw}`, "config");
}

export function parseWikiAgentBackend(raw: string | undefined): WikiAgentBackend {
  const value = (raw ?? "codex-workflow").trim().toLowerCase();
  if (value === "codex-workflow") {
    return value;
  }

  throw new AppError(
    `WIKI_AGENT_BACKEND must be "codex-workflow", got ${raw}`,
    "config",
  );
}

export function parseWikiAgentSandboxMode(raw: string | undefined): WikiAgentSandboxMode {
  const value = (raw ?? "danger-full-access").trim().toLowerCase();
  if (value === "danger-full-access" || value === "workspace-write") {
    return value;
  }

  throw new AppError(
    `WIKI_AGENT_SANDBOX_MODE must be "danger-full-access" or "workspace-write", got ${raw}`,
    "config",
  );
}

export function resolveAgentSettings(
  env: NodeJS.ProcessEnv = process.env,
  options: { strict?: boolean } = {},
): AgentProcessingSettings {
  const enabled = parseBooleanFlag("WIKI_AGENT_ENABLED", env.WIKI_AGENT_ENABLED, false);
  const baseUrl = normalizeOptionalUrl(env.WIKI_AGENT_BASE_URL);
  const apiKey = env.WIKI_AGENT_API_KEY?.trim() || null;
  const model = env.WIKI_AGENT_MODEL?.trim() || null;
  const batchSize = parseNonNegativeInteger(env.WIKI_AGENT_BATCH_SIZE, 5, "WIKI_AGENT_BATCH_SIZE");
  const sandboxMode = parseWikiAgentSandboxMode(env.WIKI_AGENT_SANDBOX_MODE);
  const workflowTimeoutSeconds = parsePositiveInteger(
    env.WIKI_WORKFLOW_TIMEOUT,
    600,
    "WIKI_WORKFLOW_TIMEOUT",
  );
  const missing: string[] = [];

  if (enabled) {
    if (!apiKey) {
      missing.push("WIKI_AGENT_API_KEY");
    }
    if (!model) {
      missing.push("WIKI_AGENT_MODEL");
    }
  }

  if (options.strict && enabled && missing.length > 0) {
    throw new AppError(
      `WIKI_AGENT_ENABLED=true but missing required settings: ${missing.join(", ")}`,
      "config",
    );
  }

  return {
    enabled,
    baseUrl,
    apiKey,
    model,
    batchSize,
    sandboxMode,
    workflowTimeoutSeconds,
    configured: enabled && missing.length === 0,
    missing,
  };
}

export function getPackageRoot(): string {
  return path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
}

export function resolveRuntimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const wikiPath = requireAbsolutePath("WIKI_PATH", env.WIKI_PATH);
  const wikiRoot = path.resolve(wikiPath, "..");
  const vaultPath = path.resolve(env.VAULT_PATH ?? path.join(wikiRoot, "..", "vault"));
  const dbPath = path.resolve(env.WIKI_DB_PATH ?? path.join(wikiRoot, "index.db"));
  const configPath = path.resolve(env.WIKI_CONFIG_PATH ?? path.join(wikiRoot, "wiki.config.json"));
  const templatesPath = path.resolve(env.WIKI_TEMPLATES_PATH ?? path.join(wikiRoot, "templates"));

  return {
    wikiPath,
    wikiRoot,
    vaultPath,
    vaultHashMode: parseVaultHashMode(env.VAULT_HASH_MODE),
    agentBackend: parseWikiAgentBackend(env.WIKI_AGENT_BACKEND),
    dbPath,
    configPath,
    templatesPath,
    queueArtifactsPath: path.join(wikiRoot, ".queue-artifacts"),
    packageRoot: getPackageRoot(),
    syncIntervalSeconds: parseSyncInterval(env.WIKI_SYNC_INTERVAL),
    daemonHost: "127.0.0.1",
    daemonPort: parseOptionalPort(env.WIKI_DAEMON_PORT, "WIKI_DAEMON_PORT"),
    daemonPidPath: path.join(wikiRoot, ".wiki-daemon.pid"),
    daemonLogPath: path.join(wikiRoot, ".wiki-daemon.log"),
    daemonStatePath: path.join(wikiRoot, ".wiki-daemon.state.json"),
  };
}

export function normalizePageId(inputPath: string, wikiPath: string): string {
  const resolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(wikiPath, inputPath);
  const relative = path.relative(wikiPath, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(`Path is outside wiki/pages: ${inputPath}`, "config");
  }

  return relative.split(path.sep).join("/");
}

export function resolvePagePath(pageId: string, wikiPath: string): string {
  return path.join(wikiPath, ...pageId.split("/"));
}

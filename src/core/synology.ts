import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";

import { AppError } from "../utils/errors.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "y"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "n"]);

const COMMON_ERROR_CODES: Record<number, string> = {
  100: "Unknown error",
  101: "No parameter of API, method, or version",
  102: "Requested API does not exist",
  103: "Requested method does not exist",
  104: "Requested version does not support this function",
  105: "Session has no permission",
  106: "Session timeout",
  107: "Session interrupted by duplicate login",
  119: "SID not found",
};

const FILE_ERROR_CODES: Record<number, string> = {
  400: "Invalid parameter of file operation",
  401: "Unknown error of file operation",
  402: "System is too busy",
  403: "Invalid user for this file operation",
  404: "Invalid group for this file operation",
  405: "Invalid user and group for this file operation",
  406: "Cannot get user/group info from account server",
  407: "Operation not permitted",
  408: "No such file or directory",
  409: "Unsupported file system",
  410: "Failed to connect internet-based file system",
  411: "Read-only file system",
  412: "Filename too long in non-encrypted file system",
  413: "Filename too long in encrypted file system",
  414: "File already exists",
  415: "Disk quota exceeded",
  416: "No space left on device",
  417: "Input/output error",
  418: "Illegal name or path",
  419: "Illegal file name",
  420: "Illegal file name on FAT file system",
  421: "Device or resource busy",
  599: "No such task for file operation",
};

const API_ALIASES: Record<string, string[]> = {
  auth: ["SYNO.API.Auth", "SYNO.APPAuth", "SYNO.API.Authenticator"],
  "filestation.list": ["SYNO.FileStation.List"],
  "filestation.download": ["SYNO.FileStation.Download", "SYNO.FileStation.download"],
};

interface SynologyApiInfoEntry {
  path?: unknown;
  maxVersion?: unknown;
  version?: unknown;
}

interface SynologyApiPayload {
  success?: unknown;
  data?: unknown;
  error?: {
    code?: unknown;
    errors?: unknown;
  };
}

export interface SynologyConfig {
  baseUrl: string;
  username: string;
  password: string;
  verifySsl: boolean;
  timeoutMs: number;
  session: string;
  readonly: boolean;
}

export interface SynologyListItem {
  name?: string;
  path?: string;
  real_path?: string;
  isdir?: boolean;
  type?: string;
  size?: number;
  additional?: {
    real_path?: string;
    size?: number;
    type?: string;
    time?: {
      mtime?: number;
    };
  };
  time?: {
    mtime?: number;
  };
}

interface ApiSpec {
  apiName: string;
  path: string;
  version: number;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function parseBooleanFlag(rawValue: string | undefined, label: string, defaultValue: boolean): boolean {
  if (rawValue === undefined || rawValue.trim().length === 0) {
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

function parsePositiveInteger(rawValue: string | undefined, label: string, defaultValue: number): number {
  if (!rawValue || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new AppError(`${label} must be a positive integer, got ${rawValue}`, "config");
  }

  return value;
}

function normalizeApiName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function parseErrorCode(rawValue: unknown): number | null {
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return Math.trunc(rawValue);
  }
  if (typeof rawValue === "string" && /^\d+$/.test(rawValue)) {
    return Number.parseInt(rawValue, 10);
  }
  return null;
}

function describeErrorCode(code: number | null): string | null {
  if (code === null) {
    return null;
  }
  return COMMON_ERROR_CODES[code] ?? FILE_ERROR_CODES[code] ?? null;
}

function encodeWireValue(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function decodeJsonBody(body: Buffer, context: string): SynologyApiPayload {
  const text = body.toString("utf8");
  try {
    return JSON.parse(text) as SynologyApiPayload;
  } catch (error) {
    throw new AppError(`Synology returned a non-JSON response for ${context}`, "runtime", {
      cause: error instanceof Error ? error.message : String(error),
      body: text.slice(0, 500),
    });
  }
}

function parseApiData(response: RawResponse, context: string): Record<string, unknown> {
  const payload = decodeJsonBody(response.body, context);
  if (payload.success !== true) {
    const code = parseErrorCode(payload.error?.code);
    const message = describeErrorCode(code) ?? "Synology API request failed";
    throw new AppError(`${context} failed: ${message}`, "runtime", {
      status: response.status,
      errorCode: code,
      details: payload.error?.errors,
    });
  }

  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data as Record<string, unknown>;
  }
  if (payload.data === undefined || payload.data === null) {
    return {};
  }

  throw new AppError(`Synology returned an unexpected payload for ${context}`, "runtime", {
    status: response.status,
    payload: payload.data,
  });
}

function buildEndpoint(baseUrl: string, resourcePath: string): URL {
  const cleaned = resourcePath
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/^webapi\/+/i, "");
  const base = new URL(baseUrl);
  const rootPath = base.pathname.replace(/\/+$/g, "");
  base.pathname = `${rootPath || ""}/webapi/${cleaned}`.replace(/\/{2,}/g, "/");
  base.search = "";
  return base;
}

function makeRequest(
  url: URL,
  options: {
    method?: string;
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
    verifySsl: boolean;
    timeoutMs: number;
  },
): Promise<RawResponse> {
  const requestUrl = new URL(url.toString());
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    requestUrl.searchParams.set(key, encodeWireValue(value));
  }

  const transport = requestUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      requestUrl,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        rejectUnauthorized: requestUrl.protocol === "https:" ? options.verifySsl : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Timed out after ${options.timeoutMs}ms`));
    });

    request.on("error", (error) => {
      reject(
        new AppError(`Failed to reach Synology endpoint ${requestUrl.toString()}`, "runtime", {
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    });

    request.end();
  });
}

export function normalizeSynologyBaseUrl(rawValue: string | undefined): string {
  const value = rawValue?.trim();
  if (!value) {
    throw new AppError("SYNOLOGY_BASE_URL is required when VAULT_SOURCE=synology", "config");
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new AppError(`SYNOLOGY_BASE_URL must start with http:// or https://: ${rawValue}`, "config");
  }
  return value.replace(/\/+$/g, "");
}

export function normalizeSynologyRemotePath(rawValue: string | undefined, label = "VAULT_SYNOLOGY_REMOTE_PATH"): string {
  const value = rawValue?.trim();
  if (!value) {
    throw new AppError(`${label} is required when VAULT_SOURCE=synology`, "config");
  }
  if (!value.startsWith("/")) {
    throw new AppError(`${label} must start with '/': ${rawValue}`, "config");
  }
  const normalized = `/${value.split("/").filter(Boolean).join("/")}`;
  return normalized || "/";
}

export function loadSynologyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SynologyConfig {
  const username = (env.SYNOLOGY_USERNAME ?? env.SYNOLOGY_USER ?? "").trim();
  if (!username) {
    throw new AppError("SYNOLOGY_USERNAME is required when VAULT_SOURCE=synology", "config");
  }

  const password = env.SYNOLOGY_PASSWORD ?? env.SYNOLOGY_PASS ?? "";
  if (!password) {
    throw new AppError("SYNOLOGY_PASSWORD is required when VAULT_SOURCE=synology", "config");
  }

  return {
    baseUrl: normalizeSynologyBaseUrl(env.SYNOLOGY_BASE_URL ?? env.SYNOLOGY_URL),
    username,
    password,
    verifySsl: parseBooleanFlag(env.SYNOLOGY_VERIFY_SSL, "SYNOLOGY_VERIFY_SSL", true),
    timeoutMs: parsePositiveInteger(env.SYNOLOGY_TIMEOUT, "SYNOLOGY_TIMEOUT", 30) * 1000,
    session: env.SYNOLOGY_SESSION?.trim() || "FileStation",
    readonly: parseBooleanFlag(env.SYNOLOGY_READONLY, "SYNOLOGY_READONLY", false),
  };
}

export class SynologyClient {
  private sid: string | null = null;
  private apiInfo: Record<string, SynologyApiInfoEntry> = {};

  constructor(private readonly config: SynologyConfig) {}

  private async request(
    endpoint: URL,
    options: {
      method?: string;
      params?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ): Promise<RawResponse> {
    return makeRequest(endpoint, {
      ...options,
      verifySsl: this.config.verifySsl,
      timeoutMs: this.config.timeoutMs,
    });
  }

  private async fetchApiInfo(): Promise<void> {
    if (Object.keys(this.apiInfo).length > 0) {
      return;
    }

    const response = await this.request(buildEndpoint(this.config.baseUrl, "query.cgi"), {
      params: {
        api: "SYNO.API.Info",
        version: 1,
        method: "query",
        query: "all",
      },
    });
    const data = parseApiData(response, "SYNO.API.Info.query");
    this.apiInfo = data as Record<string, SynologyApiInfoEntry>;
    if (Object.keys(this.apiInfo).length === 0) {
      throw new AppError("Synology API discovery returned an empty API map", "runtime");
    }
  }

  private resolveApiSpec(apiKey: string): ApiSpec {
    const candidates = API_ALIASES[apiKey] ?? [apiKey];
    for (const candidate of candidates) {
      const spec = this.apiInfo[candidate];
      if (spec) {
        return this.parseApiSpec(candidate, spec);
      }
    }

    const normalizedCandidates = new Set(candidates.map(normalizeApiName));
    for (const [apiName, spec] of Object.entries(this.apiInfo)) {
      if (normalizedCandidates.has(normalizeApiName(apiName))) {
        return this.parseApiSpec(apiName, spec);
      }
    }

    throw new AppError(`Synology API ${apiKey} is not available on the target DSM`, "runtime", {
      availableCount: Object.keys(this.apiInfo).length,
    });
  }

  private parseApiSpec(apiName: string, rawSpec: SynologyApiInfoEntry): ApiSpec {
    const pathValue = typeof rawSpec.path === "string" ? rawSpec.path.trim() : "";
    if (!pathValue) {
      throw new AppError(`Synology API ${apiName} did not expose a request path`, "runtime");
    }

    const versionValue = rawSpec.maxVersion ?? rawSpec.version ?? 1;
    const version = Number.parseInt(String(versionValue), 10);
    if (!Number.isFinite(version) || version < 1) {
      throw new AppError(`Synology API ${apiName} exposed an invalid version: ${String(versionValue)}`, "runtime");
    }

    return {
      apiName,
      path: pathValue,
      version,
    };
  }

  private async callJson(
    apiKey: string,
    method: string,
    params: Record<string, unknown> = {},
    options: { includeSid?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    await this.fetchApiInfo();

    const includeSid = options.includeSid !== false;
    if (includeSid && !this.sid) {
      await this.login();
    }

    const spec = this.resolveApiSpec(apiKey);
    const response = await this.request(buildEndpoint(this.config.baseUrl, spec.path), {
      params: {
        api: spec.apiName,
        version: spec.version,
        method,
        ...params,
        ...(includeSid && this.sid ? { _sid: this.sid } : {}),
      },
    });
    return parseApiData(response, `${spec.apiName}.${method}`);
  }

  async login(): Promise<string> {
    if (this.sid) {
      return this.sid;
    }

    const data = await this.callJson(
      "auth",
      "login",
      {
        account: this.config.username,
        passwd: this.config.password,
        session: this.config.session,
        format: "sid",
      },
      { includeSid: false },
    );
    const sid = data.sid;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new AppError("Synology login succeeded but did not return a sid", "runtime");
    }
    this.sid = sid;
    return sid;
  }

  async logout(): Promise<void> {
    if (!this.sid) {
      return;
    }

    try {
      await this.callJson("auth", "logout", { session: this.config.session });
    } catch {
      // Ignore logout failures because the session is already being discarded.
    } finally {
      this.sid = null;
    }
  }

  async listFolderPage(folderPath: string, offset = 0, limit = 500): Promise<SynologyListItem[]> {
    const normalizedPath = normalizeSynologyRemotePath(folderPath, "folder_path");
    const data = await this.callJson("filestation.list", "list", {
      folder_path: normalizedPath,
      additional: JSON.stringify(["size", "time"]),
      offset,
      limit,
      filetype: "all",
    });

    const files = data.files;
    if (Array.isArray(files)) {
      return files as SynologyListItem[];
    }
    const items = data.items;
    if (Array.isArray(items)) {
      return items as SynologyListItem[];
    }
    return [];
  }

  async listFolderAll(folderPath: string, pageSize = 500): Promise<SynologyListItem[]> {
    const results: SynologyListItem[] = [];
    let offset = 0;

    while (true) {
      const items = await this.listFolderPage(folderPath, offset, pageSize);
      if (items.length === 0) {
        break;
      }
      results.push(...items);
      if (items.length < pageSize) {
        break;
      }
      offset += pageSize;
    }

    return results;
  }

  async probeFolder(folderPath: string): Promise<void> {
    await this.listFolderPage(folderPath, 0, 1);
  }

  async downloadFile(remotePath: string, outputPath: string): Promise<void> {
    const normalizedPath = normalizeSynologyRemotePath(remotePath, "path");
    if (!this.sid) {
      await this.login();
    }
    await this.fetchApiInfo();
    const spec = this.resolveApiSpec("filestation.download");
    const response = await this.request(buildEndpoint(this.config.baseUrl, spec.path), {
      params: {
        api: spec.apiName,
        version: spec.version,
        method: "download",
        path: normalizedPath,
        mode: "download",
        _sid: this.sid,
      },
    });

    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (contentType.includes("application/json") || response.body.subarray(0, 1).toString("utf8") === "{") {
      parseApiData(response, `${spec.apiName}.download`);
      throw new AppError(`Synology download returned JSON instead of file bytes for ${normalizedPath}`, "runtime");
    }
    if (response.status >= 400) {
      throw new AppError(`Synology download failed with HTTP ${response.status}`, "runtime", {
        path: normalizedPath,
      });
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, response.body);
  }
}

export async function withSynologyClient<T>(
  env: NodeJS.ProcessEnv,
  callback: (client: SynologyClient) => Promise<T>,
): Promise<T> {
  const client = new SynologyClient(loadSynologyConfigFromEnv(env));
  try {
    return await callback(client);
  } finally {
    await client.logout();
  }
}

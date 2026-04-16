import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import packageJson from "../../package.json" with { type: "json" };
import { DaemonHttpError, requestDaemonJson } from "./daemon-client.js";

type IncomingHeaders = Record<string, string | string[] | undefined>;

type WriteActorHeaders = Record<string, string> & {
  "x-wiki-actor-id": string;
  "x-wiki-actor-type": string;
  "x-request-id": string;
};

type ToolErrorPayload = Record<string, unknown> & {
  code: string;
  message: string;
  type: string;
  httpStatus?: number;
  pageId?: string;
  currentRevision?: string | null;
  degraded?: boolean;
  details?: Record<string, unknown>;
};

export interface StartedMcpHttpServer {
  host: string;
  port: number;
  healthUrl: string;
  mcpUrl: string;
  close: () => Promise<void>;
}

const limitSchema = z.coerce.number().int().positive().max(1000).optional();
const pageIdSchema = z.string().trim().min(1);
const stringMapSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const frontmatterPatchSchema = z.record(z.string(), z.unknown());

function parsePort(rawValue: string | undefined): number | null {
  if (!rawValue || !rawValue.trim()) {
    return null;
  }
  const value = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid port value: ${rawValue}`);
  }
  return value;
}

function normalizeMcpPath(rawValue: string | undefined): string {
  const value = rawValue?.trim() || "/mcp";
  const normalized = `/${value.replace(/^\/+/, "")}`;
  return normalized === "/" ? "/mcp" : normalized;
}

function headerValue(headers: IncomingHeaders | undefined, name: string): string | null {
  const value = headers?.[name.toLowerCase()];
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  if (Array.isArray(value)) {
    const normalized = value.find((entry) => typeof entry === "string" && entry.trim());
    return normalized ? normalized.trim() : null;
  }
  return null;
}

function buildWriteActorHeaders(headers: IncomingHeaders | undefined): WriteActorHeaders | null {
  const actorId = headerValue(headers, "x-wiki-actor-id");
  const actorType = headerValue(headers, "x-wiki-actor-type");
  const requestId = headerValue(headers, "x-request-id");
  if (!actorId || !actorType || !requestId) {
    return null;
  }
  return {
    "x-wiki-actor-id": actorId,
    "x-wiki-actor-type": actorType,
    "x-request-id": requestId,
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toStructuredContent(payload: unknown): Record<string, unknown> {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {
    result: payload,
  };
}

function toolSuccess(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: jsonText(payload) }],
    structuredContent: toStructuredContent(payload),
  };
}

function toolError(payload: ToolErrorPayload): CallToolResult {
  return {
    content: [{ type: "text", text: jsonText(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function missingActorError(): CallToolResult {
  return toolError({
    code: "missing_actor",
    type: "config",
    message:
      "Write tools require proxy-injected headers x-wiki-actor-id, x-wiki-actor-type, and x-request-id.",
    details: {
      requiredHeaders: ["x-wiki-actor-id", "x-wiki-actor-type", "x-request-id"],
    },
  });
}

function normalizeErrorPayload(error: unknown): ToolErrorPayload {
  if (error instanceof DaemonHttpError) {
    const details =
      typeof error.details === "object" && error.details !== null && !Array.isArray(error.details)
        ? ({ ...error.details } as Record<string, unknown>)
        : {};
    const code =
      typeof details.code === "string"
        ? details.code
        : error.type === "not_configured"
          ? "not_configured"
          : error.type === "config"
            ? "invalid_request"
        : error.httpStatus === 404
          ? "not_found"
          : error.httpStatus === 409
            ? "conflict"
            : "runtime_error";

    return {
      code,
      message: error.message,
      type: error.type,
      httpStatus: error.httpStatus,
      pageId: typeof details.pageId === "string" ? details.pageId : undefined,
      currentRevision:
        typeof details.currentRevision === "string" || details.currentRevision === null
          ? (details.currentRevision as string | null)
          : undefined,
      degraded: details.degraded === true,
      details,
    };
  }

  return {
    code: "runtime_error",
    type: "runtime",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function runReadTool<T>(request: {
  env: NodeJS.ProcessEnv;
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}): Promise<CallToolResult> {
  try {
    const payload = await requestDaemonJson<T>({
      env: request.env,
      method: request.method ?? "GET",
      path: request.path,
      query: request.query,
      body: request.body,
    });
    return toolSuccess(payload);
  } catch (error) {
    return toolError(normalizeErrorPayload(error));
  }
}

async function runWriteTool<T>(
  env: NodeJS.ProcessEnv,
  headers: IncomingHeaders | undefined,
  request: {
    path: string;
    body: Record<string, unknown>;
  },
): Promise<CallToolResult> {
  const actorHeaders = buildWriteActorHeaders(headers);
  if (!actorHeaders) {
    return missingActorError();
  }

  try {
    const payload = await requestDaemonJson<T>({
      env,
      method: "POST",
      path: request.path,
      headers: actorHeaders,
      body: request.body,
    });
    return toolSuccess(payload);
  } catch (error) {
    return toolError(normalizeErrorPayload(error));
  }
}

function createWikiMcpServer(env: NodeJS.ProcessEnv): McpServer {
  const server = new McpServer(
    {
      name: packageJson.name,
      version: packageJson.version,
    },
    {
      instructions:
        "This is a thin MCP adapter for the Tiangong Wiki daemon. All reads and writes must go through the daemon. Write tools require proxy-injected actor headers.",
    },
  );

  server.registerTool(
    "wiki_find",
    {
      title: "Wiki Find",
      description: "Find wiki pages by structured metadata filters via the daemon /find endpoint.",
      inputSchema: z.object({
        type: z.string().trim().min(1).optional(),
        status: z.string().trim().min(1).optional(),
        visibility: z.string().trim().min(1).optional(),
        tag: z.string().trim().min(1).optional(),
        nodeId: z.string().trim().min(1).optional(),
        updatedAfter: z.string().trim().min(1).optional(),
        sort: z.string().trim().min(1).optional(),
        limit: limitSchema,
        extraFilters: stringMapSchema.optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/find",
        query: {
          type: args.type,
          status: args.status,
          visibility: args.visibility,
          tag: args.tag,
          nodeId: args.nodeId,
          updatedAfter: args.updatedAfter,
          sort: args.sort,
          limit: args.limit,
          ...(args.extraFilters ?? {}),
        },
      }),
  );

  server.registerTool(
    "wiki_fts",
    {
      title: "Wiki FTS",
      description: "Run full-text search via the daemon /fts endpoint.",
      inputSchema: z.object({
        query: z.string().trim().min(1),
        type: z.string().trim().min(1).optional(),
        limit: limitSchema,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/fts",
        query: {
          query: args.query,
          type: args.type,
          limit: args.limit,
        },
      }),
  );

  server.registerTool(
    "wiki_search",
    {
      title: "Wiki Search",
      description: "Run semantic search via the daemon /search endpoint.",
      inputSchema: z.object({
        query: z.string().trim().min(1),
        type: z.string().trim().min(1).optional(),
        limit: limitSchema,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/search",
        query: {
          query: args.query,
          type: args.type,
          limit: args.limit,
        },
      }),
  );

  server.registerTool(
    "wiki_graph",
    {
      title: "Wiki Graph",
      description: "Traverse the wiki graph via the daemon /graph endpoint.",
      inputSchema: z.object({
        root: z.string().trim().min(1),
        depth: z.coerce.number().int().positive().max(16).optional(),
        edgeType: z.string().trim().min(1).optional(),
        direction: z.enum(["outgoing", "incoming", "both"]).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/graph",
        query: {
          root: args.root,
          depth: args.depth,
          edgeType: args.edgeType,
          direction: args.direction,
        },
      }),
  );

  server.registerTool(
    "wiki_type_list",
    {
      title: "Wiki Type List",
      description: "List registered wiki page types via the daemon /type/list endpoint.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () =>
      runReadTool({
        env,
        path: "/type/list",
      }),
  );

  server.registerTool(
    "wiki_type_show",
    {
      title: "Wiki Type Show",
      description: "Read one wiki page type definition via the daemon /type/show endpoint.",
      inputSchema: z.object({
        pageType: z.string().trim().min(1),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/type/show",
        query: {
          pageType: args.pageType,
        },
      }),
  );

  server.registerTool(
    "wiki_type_recommend",
    {
      title: "Wiki Type Recommend",
      description: "Recommend wiki page types via the daemon /type/recommend endpoint.",
      inputSchema: z.object({
        text: z.string().trim().min(1),
        keywords: z.string().trim().min(1).optional(),
        limit: limitSchema,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        method: "POST",
        path: "/type/recommend",
        body: {
          text: args.text,
          keywords: args.keywords,
          limit: args.limit,
        },
      }),
  );

  server.registerTool(
    "wiki_vault_list",
    {
      title: "Wiki Vault List",
      description: "List indexed vault files via the daemon /vault/list endpoint.",
      inputSchema: z.object({
        path: z.string().trim().min(1).optional(),
        ext: z.string().trim().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/vault/list",
        query: {
          path: args.path,
          ext: args.ext,
        },
      }),
  );

  server.registerTool(
    "wiki_vault_queue",
    {
      title: "Wiki Vault Queue",
      description: "Read vault processing queue status via the daemon /vault/queue endpoint.",
      inputSchema: z.object({
        status: z.string().trim().min(1).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/vault/queue",
        query: {
          status: args.status,
        },
      }),
  );

  server.registerTool(
    "wiki_page_info",
    {
      title: "Wiki Page Info",
      description: "Read page metadata and edges via the daemon /page-info endpoint.",
      inputSchema: z.object({
        pageId: pageIdSchema,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/page-info",
        query: {
          pageId: args.pageId,
        },
      }),
  );

  server.registerTool(
    "wiki_page_read",
    {
      title: "Wiki Page Read",
      description: "Read canonical page source and revision via the daemon /page-read endpoint.",
      inputSchema: z.object({
        pageId: pageIdSchema,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/page-read",
        query: {
          pageId: args.pageId,
        },
      }),
  );

  server.registerTool(
    "wiki_sync",
    {
      title: "Wiki Sync",
      description: "Run daemon sync via the /sync endpoint with the daemon write queue and audit flow.",
      inputSchema: z.object({
        path: z.string().trim().min(1).optional(),
        force: z.boolean().optional(),
        skipEmbedding: z.boolean().optional(),
        process: z.boolean().optional(),
        vaultFileId: z.string().trim().min(1).optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    async (args, extra) =>
      runWriteTool(env, extra.requestInfo?.headers, {
        path: "/sync",
        body: {
          path: args.path,
          force: args.force === true,
          skipEmbedding: args.skipEmbedding === true,
          process: args.process === true,
          vaultFileId: args.vaultFileId,
        },
      }),
  );

  server.registerTool(
    "wiki_page_create",
    {
      title: "Wiki Page Create",
      description: "Create a wiki page via the daemon /create endpoint.",
      inputSchema: z.object({
        type: z.string().trim().min(1),
        title: z.string().trim().min(1),
        nodeId: z.string().trim().min(1).optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    async (args, extra) =>
      runWriteTool(env, extra.requestInfo?.headers, {
        path: "/create",
        body: {
          type: args.type,
          title: args.title,
          nodeId: args.nodeId,
        },
      }),
  );

  server.registerTool(
    "wiki_page_update",
    {
      title: "Wiki Page Update",
      description: "Update a wiki page via the daemon /page-update endpoint.",
      inputSchema: z.object({
        pageId: pageIdSchema,
        bodyMarkdown: z.string().optional(),
        frontmatterPatch: frontmatterPatchSchema.optional(),
        ifRevision: z.string().trim().min(1).optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    async (args, extra) =>
      runWriteTool(env, extra.requestInfo?.headers, {
        path: "/page-update",
        body: {
          pageId: args.pageId,
          bodyMarkdown: args.bodyMarkdown,
          frontmatterPatch: args.frontmatterPatch,
          ifRevision: args.ifRevision,
        },
      }),
  );

  server.registerTool(
    "wiki_lint",
    {
      title: "Wiki Lint",
      description: "Run wiki lint checks via the daemon /lint endpoint.",
      inputSchema: z.object({
        path: z.string().trim().min(1).optional(),
        level: z.enum(["error", "warning", "info"]).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runReadTool({
        env,
        path: "/lint",
        query: {
          path: args.path,
          level: args.level,
        },
      }),
  );

  return server;
}

function writeJsonResponse(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  mcpPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    writeJsonResponse(response, 200, {
      ok: true,
      service: packageJson.name,
      mcpPath,
    });
    return;
  }

  if (requestUrl.pathname !== mcpPath) {
    writeJsonResponse(response, 404, {
      error: `Unknown MCP route: ${request.method ?? "GET"} ${requestUrl.pathname}`,
    });
    return;
  }

  const server = createWikiMcpServer(env);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}

export async function startMcpHttpServer(env: NodeJS.ProcessEnv = process.env): Promise<StartedMcpHttpServer> {
  const host = env.WIKI_MCP_HOST?.trim() || "127.0.0.1";
  const port = parsePort(env.WIKI_MCP_PORT) ?? 0;
  const mcpPath = normalizeMcpPath(env.WIKI_MCP_PATH);

  const server = createServer((request, response) => {
    void handleMcpRequest(request, response, mcpPath, env).catch((error: unknown) => {
      writeJsonResponse(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine MCP server listening address.");
  }

  return {
    host,
    port: address.port,
    healthUrl: `http://${host}:${address.port}/health`,
    mcpUrl: `http://${host}:${address.port}${mcpPath}`,
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

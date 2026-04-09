import path from "node:path";

import { getMeta } from "../core/db.js";
import { parsePage } from "../core/frontmatter.js";
import { normalizePageId, resolvePagePath } from "../core/paths.js";
import { compactPageSummary } from "../core/presenters.js";
import { listPageColumns, mapPageRow, selectPageById } from "../core/query.js";
import { openRuntimeDb } from "../core/runtime.js";
import { readAllPages } from "../core/sync.js";
import { getVaultQueueSnapshot } from "../core/vault-processing.js";
import type { LoadedWikiConfig } from "../types/config.js";
import type { LintItem, LintResult, VaultQueueStatus } from "../types/page.js";
import { camelToSnake } from "../utils/case.js";
import { AppError } from "../utils/errors.js";
import { listFilesRecursiveSync, pathExistsSync } from "../utils/fs.js";
import { normalizeFtsQuery } from "../utils/segmenter.js";

type Direction = "outgoing" | "incoming" | "both";

export interface FindPagesOptions extends Record<string, unknown> {
  type?: string;
  status?: string;
  visibility?: string;
  tag?: string;
  nodeId?: string;
  updatedAfter?: string;
  sort?: string;
  limit?: number | string;
}

export interface ListPagesOptions {
  type?: string;
  sort?: string;
  limit?: number | string;
}

export interface SearchPagesOptions {
  query: string;
  type?: string;
  limit?: number | string;
}

export interface FtsSearchOptions {
  query: string;
  type?: string;
  limit?: number | string;
}

export interface GraphOptions {
  root: string;
  depth?: number | string;
  edgeType?: string;
  direction?: string;
}

export interface VaultListOptions {
  path?: string;
  ext?: string;
}

export interface VaultDiffOptions {
  since?: string;
  path?: string;
}

export interface VaultQueueOptions {
  status?: string;
}

export interface LintOptions {
  path?: string;
  level?: string;
}

function parsePositiveLimit(value: number | string | undefined, label: string, fallback: number): number {
  const normalized = value ?? fallback;
  const limit = Number.parseInt(String(normalized), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new AppError(`Invalid ${label} value: ${value}`, "config");
  }
  return limit;
}

function distanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

function resolveListSortColumn(sort: string | undefined, config: LoadedWikiConfig): string {
  const sortColumn = camelToSnake(sort ?? "updatedAt");
  const allowedSortColumns = new Set(["updated_at", "created_at", "title", "page_type", ...config.allColumnNames]);
  if (!allowedSortColumns.has(sortColumn)) {
    throw new AppError(`Unsupported --sort column: ${sort}`, "config");
  }
  return sortColumn;
}

function resolveFindSortColumn(sort: string | undefined, config: LoadedWikiConfig): string {
  if (!sort) {
    return "updated_at";
  }

  const normalized = camelToSnake(sort.replace(/-/g, "_"));
  const allowed = new Set([
    "id",
    "node_id",
    "title",
    "page_type",
    "status",
    "visibility",
    "updated_at",
    "created_at",
    ...config.allColumnNames,
  ]);

  if (!allowed.has(normalized)) {
    throw new AppError(`Unsupported sort column: ${sort}`, "config");
  }

  return normalized;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function isAbsoluteLikePath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function olderThanSixMonths(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.getTime())) {
    return false;
  }

  const threshold = new Date();
  threshold.setMonth(threshold.getMonth() - 6);
  return updatedAt < threshold;
}

function addLintItem(target: LintItem[], page: string, check: string, message: string): void {
  target.push({ page, check, message });
}

function buildGraphQuery(direction: Direction, edgeType?: string): string {
  if (direction === "outgoing") {
    return `
      WITH RECURSIVE walk(depth, node, source, target, edge_type, trail) AS (
        SELECT
          1,
          e.target,
          e.source,
          e.target,
          e.edge_type,
          '|' || ? || '|' || e.target || '|'
        FROM edges e
        WHERE e.source = ?
        ${edgeType ? "AND e.edge_type = ?" : ""}
        UNION ALL
        SELECT
          walk.depth + 1,
          e.target,
          e.source,
          e.target,
          e.edge_type,
          walk.trail || e.target || '|'
        FROM walk
        JOIN edges e ON e.source = walk.node
        WHERE walk.depth < ?
        ${edgeType ? "AND e.edge_type = ?" : ""}
          AND instr(walk.trail, '|' || e.target || '|') = 0
      )
      SELECT DISTINCT source, target, edge_type AS edgeType FROM walk
    `;
  }

  if (direction === "incoming") {
    return `
      WITH RECURSIVE walk(depth, node, source, target, edge_type, trail) AS (
        SELECT
          1,
          e.source,
          e.source,
          e.target,
          e.edge_type,
          '|' || ? || '|' || e.source || '|'
        FROM edges e
        WHERE e.target = ?
        ${edgeType ? "AND e.edge_type = ?" : ""}
        UNION ALL
        SELECT
          walk.depth + 1,
          e.source,
          e.source,
          e.target,
          e.edge_type,
          walk.trail || e.source || '|'
        FROM walk
        JOIN edges e ON e.target = walk.node
        WHERE walk.depth < ?
        ${edgeType ? "AND e.edge_type = ?" : ""}
          AND instr(walk.trail, '|' || e.source || '|') = 0
      )
      SELECT DISTINCT source, target, edge_type AS edgeType FROM walk
    `;
  }

  return `
    WITH RECURSIVE walk(depth, node, source, target, edge_type, trail) AS (
      SELECT
        1,
        CASE WHEN e.source = ? THEN e.target ELSE e.source END,
        e.source,
        e.target,
        e.edge_type,
        '|' || ? || '|' || CASE WHEN e.source = ? THEN e.target ELSE e.source END || '|'
      FROM edges e
      WHERE (e.source = ? OR e.target = ?)
      ${edgeType ? "AND e.edge_type = ?" : ""}
      UNION ALL
      SELECT
        walk.depth + 1,
        CASE WHEN e.source = walk.node THEN e.target ELSE e.source END,
        e.source,
        e.target,
        e.edge_type,
        walk.trail || CASE WHEN e.source = walk.node THEN e.target ELSE e.source END || '|'
      FROM walk
      JOIN edges e ON (e.source = walk.node OR e.target = walk.node)
      WHERE walk.depth < ?
      ${edgeType ? "AND e.edge_type = ?" : ""}
        AND instr(
          walk.trail,
          '|' || CASE WHEN e.source = walk.node THEN e.target ELSE e.source END || '|'
        ) = 0
    )
    SELECT DISTINCT source, target, edge_type AS edgeType FROM walk
  `;
}

function normalizePageInfoId(input: string, wikiPath: string): string {
  if (input.endsWith(".md") || path.isAbsolute(input)) {
    return normalizePageId(input, wikiPath);
  }
  return input;
}

export function listPages(
  env: NodeJS.ProcessEnv = process.env,
  options: ListPagesOptions = {},
): Array<Record<string, unknown>> {
  const { db, config } = openRuntimeDb(env);
  try {
    const limit = parsePositiveLimit(options.limit, "--limit", 50);
    const sortColumn = resolveListSortColumn(options.sort, config);
    const rows = db
      .prepare(
        `
          SELECT ${listPageColumns(config).join(", ")}
          FROM pages
          ${options.type ? "WHERE page_type = ?" : ""}
          ORDER BY ${sortColumn} DESC, title ASC
          LIMIT ?
        `,
      )
      .all(...(options.type ? [options.type, limit] : [limit])) as Array<Record<string, unknown>>;

    return rows.map((row) => compactPageSummary(mapPageRow(row, config), config));
  } finally {
    db.close();
  }
}

export function findPages(
  env: NodeJS.ProcessEnv = process.env,
  options: FindPagesOptions = {},
): Array<Record<string, unknown>> {
  const { db, config: runtimeConfig } = openRuntimeDb(env);
  try {
    const dynamicFields = [
      ...new Set([
        ...Object.keys(runtimeConfig.customColumns),
        ...Object.values(runtimeConfig.templates).flatMap((template) => Object.keys(template.columns)),
      ]),
    ];

    const where: string[] = [];
    const params: unknown[] = [];

    if (options.type) {
      where.push("page_type = ?");
      params.push(options.type);
    }
    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.visibility) {
      where.push("visibility = ?");
      params.push(options.visibility);
    }
    if (options.nodeId) {
      where.push("node_id = ?");
      params.push(options.nodeId);
    }
    if (options.updatedAfter) {
      where.push("updated_at >= ?");
      params.push(options.updatedAfter);
    }
    if (options.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(pages.tags) WHERE json_each.value = ?)");
      params.push(options.tag);
    }

    for (const field of dynamicFields) {
      const value = options[field];
      if (value !== undefined) {
        where.push(`${camelToSnake(field)} = ?`);
        params.push(value);
      }
    }

    const limit = parsePositiveLimit(options.limit, "--limit", 50);
    const sortColumn = resolveFindSortColumn(options.sort, runtimeConfig);
    const query = `
      SELECT ${listPageColumns(runtimeConfig).join(", ")}
      FROM pages
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${sortColumn} DESC, title ASC
      LIMIT ?
    `;
    const rows = db.prepare(query).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => compactPageSummary(mapPageRow(row, runtimeConfig), runtimeConfig));
  } finally {
    db.close();
  }
}

export async function searchPages(
  env: NodeJS.ProcessEnv = process.env,
  options: SearchPagesOptions,
): Promise<Array<Record<string, unknown>>> {
  const { EmbeddingClient } = await import("../core/embedding.js");
  const embeddingClient = EmbeddingClient.fromEnv(env);
  if (!embeddingClient) {
    throw new AppError("Embedding not configured", "not_configured");
  }

  const limit = parsePositiveLimit(options.limit, "--limit", 10);
  const [queryEmbedding] = await embeddingClient.embedBatch([options.query]);
  const { db, config } = openRuntimeDb(env);
  try {
    const rows = db
      .prepare(
        `
          SELECT ${listPageColumns(config).map((column) => `pages.${column}`).join(", ")}, vec_pages.distance AS distance
          FROM vec_pages
          JOIN pages ON pages.id = vec_pages.page_id
          WHERE vec_pages.embedding MATCH ?
            AND k = ?
            ${options.type ? "AND pages.page_type = ?" : ""}
          ORDER BY vec_pages.distance
          LIMIT ?
        `,
      )
      .all(
        ...(options.type
          ? [new Float32Array(queryEmbedding), limit, options.type, limit]
          : [new Float32Array(queryEmbedding), limit, limit]),
      ) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...compactPageSummary(mapPageRow(row, config), config),
      summaryText: row.summary_text,
      similarity: distanceToSimilarity(Number(row.distance)),
    }));
  } finally {
    db.close();
  }
}

export function ftsSearchPages(
  env: NodeJS.ProcessEnv = process.env,
  options: FtsSearchOptions,
): Array<Record<string, unknown>> {
  const { db, config } = openRuntimeDb(env);
  try {
    const limit = parsePositiveLimit(options.limit, "--limit", 20);
    const normalizedQuery = normalizeFtsQuery(options.query);
    const rows = db
      .prepare(
        `
          SELECT ${listPageColumns(config).map((column) => `pages.${column}`).join(", ")}, bm25(pages_fts) AS rank
          FROM pages_fts
          JOIN pages ON pages.rowid = pages_fts.rowid
          WHERE pages_fts MATCH ?
          ${options.type ? "AND pages.page_type = ?" : ""}
          ORDER BY rank
          LIMIT ?
        `,
      )
      .all(...(options.type ? [normalizedQuery, options.type, limit] : [normalizedQuery, limit])) as Array<
      Record<string, unknown>
    >;

    return rows.map((row) => ({
      ...compactPageSummary(mapPageRow(row, config), config),
      summaryText: row.summary_text,
      rank: row.rank,
    }));
  } finally {
    db.close();
  }
}

export function traverseGraph(
  env: NodeJS.ProcessEnv = process.env,
  options: GraphOptions,
): {
  root: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ source: string; target: string; edgeType: string }>;
} {
  const { db } = openRuntimeDb(env);
  try {
    const depth = Number.parseInt(String(options.depth ?? "1"), 10);
    if (!Number.isFinite(depth) || depth < 1) {
      throw new AppError(`Invalid --depth value: ${options.depth}`, "config");
    }

    const direction = (options.direction ?? "both") as Direction;
    if (!["outgoing", "incoming", "both"].includes(direction)) {
      throw new AppError(`Invalid --direction value: ${options.direction}`, "config");
    }

    const rootRow = db
      .prepare("SELECT id, node_id AS nodeId, title, page_type AS pageType FROM pages WHERE node_id = ? OR id = ? LIMIT 1")
      .get(options.root, options.root) as { id: string; nodeId: string | null; title: string; pageType: string } | undefined;
    const rootKey = rootRow?.nodeId ?? rootRow?.id ?? options.root;
    const sql = buildGraphQuery(direction, options.edgeType);

    let params: unknown[];
    if (direction === "both") {
      params = options.edgeType
        ? [rootKey, rootKey, rootKey, rootKey, rootKey, options.edgeType, depth, options.edgeType]
        : [rootKey, rootKey, rootKey, rootKey, rootKey, depth];
    } else {
      params = options.edgeType
        ? [rootKey, rootKey, options.edgeType, depth, options.edgeType]
        : [rootKey, rootKey, depth];
    }

    const edges = db.prepare(sql).all(...params) as Array<{
      source: string;
      target: string;
      edgeType: string;
    }>;

    const identifiers = [...new Set([rootKey, ...edges.flatMap((edge) => [edge.source, edge.target])])];
    const lookupPage = db.prepare(
      "SELECT id, node_id AS nodeId, title, page_type AS pageType, file_path AS filePath FROM pages WHERE node_id = ? OR id = ? LIMIT 1",
    );
    const nodes = identifiers.map((identifier) => {
      const row = lookupPage.get(identifier, identifier) as
        | {
            id: string;
            nodeId: string | null;
            title: string;
            pageType: string;
            filePath: string;
          }
        | undefined;
      if (!row) {
        return { nodeId: identifier };
      }
      return {
        id: row.id,
        nodeId: row.nodeId ?? row.id,
        title: row.title,
        pageType: row.pageType,
        filePath: row.filePath,
      };
    });

    return { root: rootKey, nodes, edges };
  } finally {
    db.close();
  }
}

export function getPageInfo(
  env: NodeJS.ProcessEnv = process.env,
  inputPageId: string,
): Record<string, unknown> {
  const { db, config, paths } = openRuntimeDb(env);
  try {
    const pageId = normalizePageInfoId(inputPageId, paths.wikiPath);
    const page = selectPageById(db, config, pageId);
    if (!page) {
      throw new AppError(`Page not found: ${pageId}`, "not_found");
    }

    const identifiers = [page.id, page.nodeId].filter(Boolean);
    const outgoing = db
      .prepare(
        `
          SELECT source, target, edge_type AS edgeType, source_page AS sourcePage, metadata
          FROM edges
          WHERE source_page = ?
          ORDER BY edge_type, target
        `,
      )
      .all(page.id) as Array<Record<string, unknown>>;
    const incoming = db
      .prepare(
        `
          SELECT source, target, edge_type AS edgeType, source_page AS sourcePage, metadata
          FROM edges
          WHERE target IN (${identifiers.map(() => "?").join(", ")})
          ORDER BY edge_type, source
        `,
      )
      .all(...identifiers) as Array<Record<string, unknown>>;

    return {
      ...page,
      outgoingEdges: outgoing.map((edge) => ({
        ...edge,
        metadata: edge.metadata ? JSON.parse(String(edge.metadata)) : {},
      })),
      incomingEdges: incoming.map((edge) => ({
        ...edge,
        metadata: edge.metadata ? JSON.parse(String(edge.metadata)) : {},
      })),
    };
  } finally {
    db.close();
  }
}

export function getWikiStat(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const { db, config } = openRuntimeDb(env);
  try {
    const pages = readAllPages(db);
    const edges = db
      .prepare("SELECT source, target, source_page AS sourcePage FROM edges")
      .all() as Array<{ source: string; target: string; sourcePage: string }>;
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const embeddingStatus: Record<string, number> = {};

    for (const page of pages) {
      byType[page.pageType] = (byType[page.pageType] ?? 0) + 1;
      byStatus[page.status] = (byStatus[page.status] ?? 0) + 1;
      embeddingStatus[page.embeddingStatus] = (embeddingStatus[page.embeddingStatus] ?? 0) + 1;
    }

    const orphanPages = pages.filter((page) => {
      const identifiers = [page.id, page.nodeId].filter(Boolean);
      const hasOutgoing = edges.some((edge) => edge.sourcePage === page.id);
      const hasIncoming = edges.some((edge) => identifiers.includes(edge.target));
      return !hasOutgoing && !hasIncoming;
    }).length;

    const vaultFiles = db.prepare("SELECT COUNT(*) AS count FROM vault_files").get() as { count: number };

    return {
      totalPages: pages.length,
      byType,
      byStatus,
      totalEdges: edges.length,
      orphanPages,
      embeddingStatus,
      vaultFiles: vaultFiles.count,
      lastSyncAt: getMeta(db, "last_sync_at"),
      registeredTemplates: Object.keys(config.templates).length,
    };
  } finally {
    db.close();
  }
}

export function listVaultFiles(
  env: NodeJS.ProcessEnv = process.env,
  options: VaultListOptions = {},
): Array<Record<string, unknown>> {
  const { db } = openRuntimeDb(env);
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.path) {
      clauses.push("id LIKE ?");
      params.push(`${options.path}%`);
    }
    if (options.ext) {
      clauses.push("file_ext = ?");
      params.push(String(options.ext).replace(/^\./, ""));
    }

    return db
      .prepare(
        `
          SELECT
            id,
            file_name AS fileName,
            file_ext AS fileExt,
            source_type AS sourceType,
            file_size AS fileSize,
            file_path AS filePath,
            content_hash AS contentHash,
            file_mtime AS fileMtime,
            indexed_at AS indexedAt
          FROM vault_files
          ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
          ORDER BY id
        `,
      )
      .all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

export function diffVaultFiles(
  env: NodeJS.ProcessEnv = process.env,
  options: VaultDiffOptions = {},
): Record<string, unknown> {
  const { db } = openRuntimeDb(env);
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.since) {
      clauses.push("detected_at >= ?");
      params.push(options.since);
    } else {
      const lastSyncId = getMeta(db, "last_sync_id");
      if (lastSyncId) {
        clauses.push("sync_id = ?");
        params.push(lastSyncId);
      }
    }
    if (options.path) {
      clauses.push("file_id LIKE ?");
      params.push(`${options.path}%`);
    }

    const rows = db
      .prepare(
        `
          SELECT
            file_id AS fileId,
            action,
            detected_at AS detectedAt,
            sync_id AS syncId
          FROM vault_changelog
          ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
          ORDER BY detected_at DESC, id DESC
        `,
      )
      .all(...params);

    return {
      changes: rows,
      since: options.since ?? null,
      totalChanges: rows.length,
    };
  } finally {
    db.close();
  }
}

export function getVaultQueue(
  env: NodeJS.ProcessEnv = process.env,
  options: VaultQueueOptions = {},
): Record<string, unknown> {
  const status = normalizeQueueStatus(options.status);
  return getVaultQueueSnapshot(env, status);
}

function normalizeQueueStatus(value: string | undefined): VaultQueueStatus | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "pending" || value === "processing" || value === "done" || value === "skipped" || value === "error") {
    return value;
  }

  throw new AppError(`Unsupported queue status: ${value}`, "config");
}

export function runLint(
  env: NodeJS.ProcessEnv = process.env,
  options: LintOptions = {},
): {
  errors: LintItem[];
  warnings: LintItem[];
  info: LintItem[];
  summary: { pages: number; errors: number; warnings: number; info: number };
} {
  const level = options.level ?? "info";
  const { db, config, paths } = openRuntimeDb(env);
  try {
    const pageFiles = options.path
      ? [resolvePagePath(normalizePageId(options.path, paths.wikiPath), paths.wikiPath)]
      : listFilesRecursiveSync(paths.wikiPath, ".md");

    const indexedPages = readAllPages(db);
    const pageIdSet = new Set(indexedPages.map((page) => page.id));
    const nodeIdSet = new Set(indexedPages.map((page) => page.nodeId).filter(Boolean) as string[]);
    const archivedIds = new Set(
      indexedPages.filter((page) => page.status === "archived").map((page) => page.id),
    );
    const archivedNodeIds = new Set(
      indexedPages.filter((page) => page.status === "archived" && page.nodeId).map((page) => page.nodeId as string),
    );
    const vaultIds = new Set(
      (db.prepare("SELECT id FROM vault_files").all() as Array<{ id: string }>).map((row) => row.id),
    );
    const edges = db
      .prepare("SELECT source, target, source_page AS sourcePage FROM edges")
      .all() as Array<{ source: string; target: string; sourcePage: string }>;

    const result: LintResult = { pages: pageFiles.length, errors: [], warnings: [], info: [] };

    for (const filePath of pageFiles) {
      const parsed = parsePage(filePath, paths.wikiPath, config);
      const pageId = path.relative(paths.wikiPath, filePath).split(path.sep).join("/");

      if (!parsed.ok) {
        addLintItem(result.errors, pageId, parsed.error.code, parsed.error.message);
        continue;
      }

      const { parsed: page } = parsed;
      const sourceRefs = normalizeStringArray(page.rawData.sourceRefs);
      const relatedPages = normalizeStringArray(page.rawData.relatedPages);
      const vaultPath = normalizeOptionalString(page.rawData.vaultPath);

      for (const reference of sourceRefs) {
        if (reference.startsWith("vault/") && !vaultIds.has(reference.replace(/^vault\//, ""))) {
          addLintItem(
            result.errors,
            page.page.id,
            "vault_ref_exists",
            `sourceRefs: ${reference} does not exist in vault`,
          );
        }
      }

      for (const edge of page.edges) {
        const isPathTarget = edge.target.endsWith(".md");
        if (isPathTarget && !pageIdSet.has(edge.target)) {
          addLintItem(result.errors, page.page.id, "page_ref_exists", `${edge.edgeType}: ${edge.target} not found`);
        }
        if (!isPathTarget && !nodeIdSet.has(edge.target)) {
          addLintItem(result.errors, page.page.id, "node_ref_exists", `${edge.edgeType}: ${edge.target} not found`);
        }
        if (isPathTarget && archivedIds.has(edge.target)) {
          addLintItem(result.warnings, page.page.id, "archived_page_ref", `${edge.target} is archived`);
        }
        if (!isPathTarget && archivedNodeIds.has(edge.target)) {
          addLintItem(result.warnings, page.page.id, "archived_node_ref", `${edge.target} is archived`);
        }
      }

      if (sourceRefs.length === 0) {
        addLintItem(result.warnings, page.page.id, "source_refs_empty", "sourceRefs is empty");
      }

      if (vaultPath && isAbsoluteLikePath(vaultPath)) {
        addLintItem(
          result.errors,
          page.page.id,
          "vault_path_absolute",
          `vaultPath is an absolute path: "${vaultPath}", should be relative to vault root`,
        );
      }

      if (page.page.pageType === "source-summary" && relatedPages.length === 0) {
        addLintItem(
          result.warnings,
          page.page.id,
          "related_pages_empty",
          "relatedPages is empty for source-summary — page has no explicit knowledge connections",
        );
      }

      if (page.page.status === "active" && olderThanSixMonths(page.page.updatedAt)) {
        addLintItem(result.warnings, page.page.id, "stale_page", "updatedAt is older than six months");
      }

      const identifiers = [page.page.id, page.page.nodeId].filter(Boolean);
      const hasOutgoing = page.edges.length > 0 || edges.some((edge) => edge.sourcePage === page.page.id);
      const hasIncoming = edges.some((edge) => identifiers.includes(edge.target));
      if (!hasOutgoing && !hasIncoming) {
        addLintItem(result.warnings, page.page.id, "orphan_page", "No incoming or outgoing links");
      }

      if (page.unregisteredFields.length > 0) {
        addLintItem(
          result.info,
          page.page.id,
          "unregistered_fields",
          `Unregistered fields: ${page.unregisteredFields.join(", ")}`,
        );
      }

      // Check for broken image references in page body
      const imageRefPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
      let imageMatch;
      while ((imageMatch = imageRefPattern.exec(page.body)) !== null) {
        let refPath = imageMatch[1].trim();
        // Strip optional markdown title: ![alt](path "title")
        const titleMatch = refPath.match(/^(\S+)\s+"[^"]*"$/);
        if (titleMatch) refPath = titleMatch[1];
        // Skip non-local references
        if (!refPath || refPath.startsWith("http://") || refPath.startsWith("https://")
            || refPath.startsWith("data:") || refPath.startsWith("#")) continue;
        // Decode URL-encoded paths (e.g., %20 → space)
        try { refPath = decodeURIComponent(refPath); } catch { /* use as-is */ }
        // Resolve relative to the page file's directory
        const absRefPath = path.resolve(path.dirname(filePath), refPath);
        if (!pathExistsSync(absRefPath)) {
          addLintItem(result.warnings, page.page.id, "broken_image_ref", `Image not found: ${refPath}`);
        }
      }
    }

    const draftCount = indexedPages.filter((page) => page.status === "draft").length;
    const pendingEmbeddings = indexedPages.filter((page) => page.embeddingStatus !== "done").length;
    addLintItem(result.info, "*", "draft_count", `${draftCount} pages in draft status`);
    addLintItem(result.info, "*", "embedding_pending", `${pendingEmbeddings} pages with pending embedding`);

    return {
      errors: result.errors,
      warnings: level === "warning" || level === "info" ? result.warnings : [],
      info: level === "info" ? result.info : [],
      summary: {
        pages: result.pages,
        errors: result.errors.length,
        warnings: level === "warning" || level === "info" ? result.warnings.length : 0,
        info: level === "info" ? result.info.length : 0,
      },
    };
  } finally {
    db.close();
  }
}

export function renderLintResult(result: {
  errors: LintItem[];
  warnings: LintItem[];
  info: LintItem[];
  summary: { pages: number; errors: number; warnings: number; info: number };
}): string {
  const lines = [`tiangong-wiki lint: ${result.summary.pages} pages checked`, ""];
  const sections: Array<{ label: string; items: LintItem[] }> = [
    { label: "ERROR", items: result.errors },
    { label: "WARN", items: result.warnings },
    { label: "INFO", items: result.info },
  ];

  for (const section of sections) {
    for (const item of section.items) {
      lines.push(`  ${section.label.padEnd(5)} ${item.page}`);
      lines.push(`         ${item.message}`);
      lines.push("");
    }
  }

  lines.push(
    `Summary: ${result.summary.errors} errors, ${result.summary.warnings} warnings, ${result.summary.info} info`,
  );
  return lines.join("\n");
}

import type Database from "better-sqlite3";
import path from "node:path";

import { getMeta } from "../core/db.js";
import { parsePage } from "../core/frontmatter.js";
import { buildDoctorReport } from "../core/onboarding.js";
import { resolveRuntimePaths } from "../core/paths.js";
import { readCanonicalPageSource } from "../core/page-source.js";
import { compactPageSummary } from "../core/presenters.js";
import { listPageColumns, mapPageRow, selectPageById } from "../core/query.js";
import { openRuntimeDb } from "../core/runtime.js";
import { getSynologyCacheStatus, ensureLocalVaultFile, extractVaultText } from "../core/vault.js";
import { getVaultQueueItem, getVaultQueueSnapshot } from "../core/vault-processing.js";
import { getWorkflowArtifactSet } from "../core/workflow-context.js";
import type { LoadedWikiConfig } from "../types/config.js";
import type { DaemonState, VaultFile, VaultQueueItem, VaultQueueStatus } from "../types/page.js";
import { AppError } from "../utils/errors.js";
import { openTarget } from "../utils/process.js";
import { pathExistsSync, readTextFileSync } from "../utils/fs.js";
import { toOffsetIso } from "../utils/time.js";
import { ftsSearchPages, getWikiStat, runLint, searchPages } from "./query.js";

type PageRow = Record<string, unknown>;
type DashboardGroupBy = "flat" | "page" | "rule";
type DashboardLogLevel = "error" | "warning" | "info";

interface DashboardPageSummary extends Record<string, unknown> {
  id: string;
  title: string;
  pageType: string;
  status: string;
  filePath: string;
  tags: string[];
  updatedAt: string | null;
  nodeId?: string;
}

interface DashboardOverviewNode extends DashboardPageSummary {
  nodeKey: string;
  degree: number;
  orphan: boolean;
  embeddingStatus: unknown | null;
  sourceType: unknown | null;
}

interface EdgeRow {
  source: string;
  target: string;
  edgeType: string;
  sourcePage: string | null;
}

interface EnrichedLintIssue {
  level: DashboardLogLevel;
  pageId: string;
  check: string;
  message: string;
  pageTitle: string | null;
  pageType: string | null;
  nodeId: string | null;
  filePath: string | null;
}

function parsePositiveLimit(value: string | number | undefined, fallback: number): number {
  const limit = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new AppError(`Invalid limit value: ${value}`, "config");
  }
  return limit;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function previewText(value: string | null | undefined, maxLength = 4_000): string {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}…`;
}

function safeParseJson(rawText: string | null): { parsed: unknown | null; error: string | null } {
  if (!rawText || !rawText.trim()) {
    return { parsed: null, error: null };
  }

  try {
    return {
      parsed: JSON.parse(rawText) as unknown,
      error: null,
    };
  } catch (error) {
    return {
      parsed: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readOptionalText(filePath: string): string | null {
  if (!pathExistsSync(filePath)) {
    return null;
  }
  return readTextFileSync(filePath);
}

function normalizeDashboardPageId(input: string, wikiPath: string): string {
  if (input.endsWith(".md") || path.isAbsolute(input)) {
    const relative = path.relative(wikiPath, path.resolve(wikiPath, input));
    if (relative.startsWith("..")) {
      throw new AppError(`Path is outside pages directory: ${input}`, "config");
    }
    return relative.split(path.sep).join("/");
  }
  return input;
}

function pageNodeKey(page: Record<string, unknown>): string {
  const nodeId = normalizeOptionalString(page.nodeId);
  return nodeId ?? String(page.id);
}

function scoreRecency(updatedAt: string | null): number {
  if (!updatedAt) {
    return 0;
  }
  const updatedAtMs = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) {
    return 0;
  }
  const ageInDays = (Date.now() - updatedAtMs) / 86_400_000;
  return Math.max(0, 365 - ageInDays);
}

function buildPageSummary(
  page: Record<string, unknown>,
  config: LoadedWikiConfig,
): DashboardPageSummary {
  return compactPageSummary(page, config) as DashboardPageSummary;
}

function getAllPageRows(
  db: Database.Database,
  config: LoadedWikiConfig,
): Array<Record<string, unknown>> {
  const rows = db
    .prepare(`SELECT ${listPageColumns(config).join(", ")} FROM pages ORDER BY updated_at DESC, title ASC`)
    .all() as Array<PageRow>;
  return rows.map((row) => mapPageRow(row, config));
}

function getAllEdges(db: Database.Database): EdgeRow[] {
  return db.prepare(
    `
      SELECT source, target, edge_type AS edgeType, source_page AS sourcePage
      FROM edges
      ORDER BY edge_type, source, target
    `,
  ).all() as EdgeRow[];
}

function createPageIndexes(
  pages: Array<Record<string, unknown>>,
): {
  aliasToNodeKey: Map<string, string>;
  nodeKeyToPage: Map<string, Record<string, unknown>>;
  pageIdToPage: Map<string, Record<string, unknown>>;
} {
  const aliasToNodeKey = new Map<string, string>();
  const nodeKeyToPage = new Map<string, Record<string, unknown>>();
  const pageIdToPage = new Map<string, Record<string, unknown>>();

  for (const page of pages) {
    const key = pageNodeKey(page);
    aliasToNodeKey.set(String(page.id), key);
    const nodeId = normalizeOptionalString(page.nodeId);
    if (nodeId) {
      aliasToNodeKey.set(nodeId, key);
    }
    nodeKeyToPage.set(key, page);
    pageIdToPage.set(String(page.id), page);
  }

  return {
    aliasToNodeKey,
    nodeKeyToPage,
    pageIdToPage,
  };
}

function normalizeEdges(
  edges: EdgeRow[],
  aliasToNodeKey: Map<string, string>,
): Array<{ source: string; target: string; edgeType: string; sourcePage: string | null }> {
  const normalized: Array<{ source: string; target: string; edgeType: string; sourcePage: string | null }> = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    const source = aliasToNodeKey.get(edge.source);
    const target = aliasToNodeKey.get(edge.target);
    if (!source || !target || source === target) {
      continue;
    }

    const key = `${source}::${target}::${edge.edgeType}::${edge.sourcePage ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      source,
      target,
      edgeType: edge.edgeType,
      sourcePage: edge.sourcePage,
    });
  }

  return normalized;
}

function sampleOverviewNodeKeys(
  pages: Array<Record<string, unknown>>,
  edges: Array<{ source: string; target: string; edgeType: string; sourcePage: string | null }>,
  limit: number,
): Set<string> {
  if (pages.length <= limit) {
    return new Set(pages.map((page) => pageNodeKey(page)));
  }

  const degreeMap = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();
  for (const page of pages) {
    const key = pageNodeKey(page);
    degreeMap.set(key, 0);
    adjacency.set(key, new Set());
  }

  for (const edge of edges) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const scored = pages
    .map((page) => ({
      page,
      key: pageNodeKey(page),
      degree: degreeMap.get(pageNodeKey(page)) ?? 0,
      score:
        (degreeMap.get(pageNodeKey(page)) ?? 0) * 1_000 +
        scoreRecency(normalizeOptionalString(page.updatedAt)) +
        (page.status === "active" ? 100 : 0),
    }))
    .sort((left, right) => right.score - left.score || String(left.page.id).localeCompare(String(right.page.id)));

  const byType = new Map<string, Array<typeof scored[number]>>();
  const orphans: Array<typeof scored[number]> = [];
  const connected: Array<typeof scored[number]> = [];

  for (const item of scored) {
    const pageType = String(item.page.pageType);
    if (!byType.has(pageType)) {
      byType.set(pageType, []);
    }
    byType.get(pageType)!.push(item);
    if (item.degree === 0) {
      orphans.push(item);
    } else {
      connected.push(item);
    }
  }

  const selected = new Set<string>();

  for (const bucket of byType.values()) {
    if (selected.size >= limit) {
      break;
    }
    const first = bucket[0];
    if (first) {
      selected.add(first.key);
    }
  }

  const connectedTarget = Math.max(selected.size, Math.min(limit, Math.floor(limit * 0.82)));
  let index = 0;
  while (selected.size < connectedTarget && index < connected.length) {
    const candidate = connected[index++];
    if (selected.has(candidate.key)) {
      continue;
    }
    selected.add(candidate.key);
    if (selected.size >= connectedTarget) {
      break;
    }
    const neighbors = [...(adjacency.get(candidate.key) ?? [])]
      .map((key) => scored.find((item) => item.key === key))
      .filter((item): item is typeof scored[number] => Boolean(item))
      .sort((left, right) => right.score - left.score);
    for (const neighbor of neighbors) {
      if (selected.size >= connectedTarget) {
        break;
      }
      selected.add(neighbor.key);
    }
  }

  const orphanTarget = Math.min(Math.max(4, Math.floor(limit * 0.08)), orphans.length, limit - selected.size);
  for (const orphan of orphans.slice(0, orphanTarget)) {
    selected.add(orphan.key);
  }

  for (const item of scored) {
    if (selected.size >= limit) {
      break;
    }
    selected.add(item.key);
  }

  return selected;
}

function buildQueueTiming(item: VaultQueueItem): Record<string, unknown> {
  const queuedAt = new Date(item.queuedAt).getTime();
  const claimedAt = item.claimedAt ? new Date(item.claimedAt).getTime() : NaN;
  const startedAt = item.startedAt ? new Date(item.startedAt).getTime() : NaN;
  const processedAt = item.processedAt ? new Date(item.processedAt).getTime() : NaN;
  const now = Date.now();

  return {
    queuedAt: item.queuedAt,
    claimedAt: item.claimedAt ?? null,
    startedAt: item.startedAt ?? null,
    heartbeatAt: item.heartbeatAt ?? null,
    processedAt: item.processedAt,
    lastErrorAt: item.lastErrorAt ?? null,
    lastErrorCode: item.lastErrorCode ?? null,
    retryAfter: item.retryAfter ?? null,
    queueAgeMs: Number.isFinite(queuedAt) ? now - queuedAt : null,
    waitDurationMs: Number.isFinite(claimedAt) && Number.isFinite(queuedAt) ? claimedAt - queuedAt : null,
    processingDurationMs:
      item.status === "processing" && Number.isFinite(startedAt)
        ? now - startedAt
        : Number.isFinite(startedAt) && Number.isFinite(processedAt)
          ? processedAt - startedAt
          : null,
    totalDurationMs: Number.isFinite(queuedAt) && Number.isFinite(processedAt) ? processedAt - queuedAt : null,
  };
}

function buildQueueListItem(item: VaultQueueItem): Record<string, unknown> {
  return {
    fileId: item.fileId,
    status: item.status,
    priority: item.priority,
    attempts: item.attempts,
    autoRetryExhausted: item.autoRetryExhausted ?? false,
    resultPageId: item.resultPageId,
    errorMessage: item.errorMessage,
    lastErrorCode: item.lastErrorCode ?? null,
    processingOwnerId: item.processingOwnerId ?? null,
    threadId: item.threadId ?? null,
    decision: item.decision ?? null,
    workflowVersion: item.workflowVersion ?? null,
    resultManifestPath: item.resultManifestPath ?? null,
    fileName: item.fileName ?? item.fileId.split("/").at(-1) ?? item.fileId,
    fileExt: item.fileExt ?? null,
    sourceType: item.sourceType ?? null,
    fileSize: item.fileSize ?? null,
    filePath: item.filePath ?? null,
    createdPageIds: item.createdPageIds ?? [],
    updatedPageIds: item.updatedPageIds ?? [],
    appliedTypeNames: item.appliedTypeNames ?? [],
    proposedTypeNames: item.proposedTypeNames ?? [],
    skillsUsed: item.skillsUsed ?? [],
    timing: buildQueueTiming(item),
  };
}

function normalizeQueueSearch(item: VaultQueueItem): string {
  return [
    item.fileId,
    item.fileName,
    item.filePath,
    item.resultPageId,
    item.errorMessage,
    item.threadId,
    ...(item.createdPageIds ?? []),
    ...(item.updatedPageIds ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function readArtifactBundle(fileId: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const paths = resolveRuntimePaths(env);
  const artifacts = getWorkflowArtifactSet(paths, fileId);
  const queueItemText = readOptionalText(artifacts.queueItemPath);
  const promptText = readOptionalText(artifacts.promptPath);
  const resultText = readOptionalText(artifacts.resultPath);
  const queueItemJson = safeParseJson(queueItemText);
  const resultJson = safeParseJson(resultText);

  return {
    artifactId: artifacts.artifactId,
    rootDir: artifacts.rootDir,
    queueItemPath: artifacts.queueItemPath,
    promptPath: artifacts.promptPath,
    resultPath: artifacts.resultPath,
    skillArtifactsPath: artifacts.skillArtifactsPath,
    queueItem: {
      exists: queueItemText !== null,
      rawText: queueItemText,
      parsed: queueItemJson.parsed,
      parseError: queueItemJson.error,
    },
    prompt: {
      exists: promptText !== null,
      rawText: promptText,
      preview: previewText(promptText, 6_000),
    },
    result: {
      exists: resultText !== null,
      rawText: resultText,
      parsed: resultJson.parsed,
      parseError: resultJson.error,
    },
  };
}

function fetchLinkedPageSummaries(
  db: Database.Database,
  config: LoadedWikiConfig,
  identifiers: string[],
): DashboardPageSummary[] {
  const cleaned = [...new Set(identifiers.filter(Boolean))];
  if (cleaned.length === 0) {
    return [];
  }

  const rows = db
    .prepare(
      `
        SELECT ${listPageColumns(config).join(", ")}
        FROM pages
        WHERE id IN (${cleaned.map(() => "?").join(", ")})
           OR node_id IN (${cleaned.map(() => "?").join(", ")})
        ORDER BY updated_at DESC, title ASC
      `,
    )
    .all(...cleaned, ...cleaned) as Array<PageRow>;

  return rows.map((row) => buildPageSummary(mapPageRow(row, config), config));
}

function normalizeQueueStatusFilter(status: string | undefined): VaultQueueStatus | undefined {
  if (!status) {
    return undefined;
  }
  if (status === "pending" || status === "processing" || status === "done" || status === "skipped" || status === "error") {
    return status;
  }
  throw new AppError(`Unsupported queue status: ${status}`, "config");
}

function normalizeLintLevel(level: string | undefined): DashboardLogLevel | null {
  if (!level || level === "all") {
    return null;
  }
  if (level === "error" || level === "warning" || level === "info") {
    return level;
  }
  throw new AppError(`Unsupported lint level: ${level}`, "config");
}

function normalizeGroupBy(value: string | undefined): DashboardGroupBy {
  if (!value || value === "flat") {
    return "flat";
  }
  if (value === "page" || value === "rule") {
    return value;
  }
  throw new AppError(`Unsupported groupBy value: ${value}`, "config");
}

async function buildVaultPreview(
  env: NodeJS.ProcessEnv,
  file: VaultFile,
): Promise<Record<string, unknown>> {
  const { paths } = openRuntimeDb(env);
  const cache = getSynologyCacheStatus(paths.vaultPath, file, env);
  let localPath = cache.localPath;
  let preview = "";
  let previewError: string | null = null;
  let previewAvailable = false;

  try {
    localPath = await ensureLocalVaultFile(file, paths.vaultPath, env);
    preview = previewText(extractVaultText(localPath), 10_000);
    previewAvailable = preview.length > 0;
  } catch (error) {
    previewError = error instanceof Error ? error.message : String(error);
  }

  return {
    cacheStatus: cache.kind,
    localPath,
    metadataPath: cache.metadataPath,
    previewAvailable,
    preview,
    previewError,
  };
}

async function resolvePageVaultSource(
  db: Database.Database,
  config: LoadedWikiConfig,
  env: NodeJS.ProcessEnv,
  page: Record<string, unknown>,
  rawData: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const vaultPath = normalizeOptionalString(rawData.vaultPath) ?? normalizeOptionalString(page.vaultPath);
  if (!vaultPath) {
    return null;
  }

  const row = db.prepare(
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
      WHERE id = ?
    `,
  ).get(vaultPath) as VaultFile | undefined;

  if (!row) {
    return {
      fileId: vaultPath,
      missing: true,
      previewAvailable: false,
      preview: "",
      previewError: "Vault file not found in index.",
    };
  }

  const preview = await buildVaultPreview(env, row);
  return {
    fileId: row.id,
    fileName: row.fileName,
    fileExt: row.fileExt,
    sourceType: row.sourceType,
    fileSize: row.fileSize,
    remotePath: row.filePath,
    indexedAt: row.indexedAt,
    ...preview,
  };
}

function buildRelationLookup(
  db: Database.Database,
  config: LoadedWikiConfig,
  pageRows: Array<Record<string, unknown>>,
  page: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const { aliasToNodeKey, nodeKeyToPage, pageIdToPage } = createPageIndexes(pageRows);
  const identifiers = [String(page.id)];
  const nodeId = normalizeOptionalString(page.nodeId);
  if (nodeId) {
    identifiers.push(nodeId);
  }

  const outgoingRows = db.prepare(
    `
      SELECT source, target, edge_type AS edgeType, source_page AS sourcePage
      FROM edges
      WHERE source_page = ?
      ORDER BY edge_type, target
    `,
  ).all(String(page.id)) as EdgeRow[];
  const incomingRows = db.prepare(
    `
      SELECT source, target, edge_type AS edgeType, source_page AS sourcePage
      FROM edges
      WHERE target IN (${identifiers.map(() => "?").join(", ")})
      ORDER BY edge_type, source
    `,
  ).all(...identifiers) as EdgeRow[];

  const lookupPage = (rawReference: string): DashboardPageSummary | null => {
    const key = aliasToNodeKey.get(rawReference) ?? rawReference;
    const match = nodeKeyToPage.get(key) ?? pageIdToPage.get(rawReference) ?? null;
    if (!match) {
      return null;
    }
    return buildPageSummary(match, config);
  };

  const relations: Array<Record<string, unknown>> = [];
  for (const edge of outgoingRows) {
    relations.push({
      direction: "outgoing",
      edgeType: edge.edgeType,
      source: buildPageSummary(page, config),
      target: lookupPage(edge.target),
      rawTarget: edge.target,
    });
  }
  for (const edge of incomingRows) {
    relations.push({
      direction: "incoming",
      edgeType: edge.edgeType,
      source: lookupPage(edge.source),
      target: buildPageSummary(page, config),
      rawSource: edge.source,
    });
  }

  return relations;
}

function buildLintIssueGroups(
  issues: EnrichedLintIssue[],
  groupBy: DashboardGroupBy,
): Record<string, unknown> {
  if (groupBy === "flat") {
    return {
      groupBy,
      items: issues,
    };
  }

  const groupMap = new Map<string, EnrichedLintIssue[]>();
  for (const issue of issues) {
    const key = groupBy === "page" ? issue.pageId : issue.check;
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key)!.push(issue);
  }

  return {
    groupBy,
    groups: [...groupMap.entries()]
      .map(([key, values]) => ({
        key,
        count: values.length,
        levelCounts: values.reduce<Record<string, number>>((accumulator, issue) => {
          accumulator[issue.level] = (accumulator[issue.level] ?? 0) + 1;
          return accumulator;
        }, {}),
        pageTitle: groupBy === "page" ? values[0]?.pageTitle ?? null : null,
        pageType: groupBy === "page" ? values[0]?.pageType ?? null : null,
        items: values,
      }))
      .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
  };
}

function buildEnrichedLintIssues(
  env: NodeJS.ProcessEnv = process.env,
): EnrichedLintIssue[] {
  const { db, config } = openRuntimeDb(env);
  try {
    const pageRows = getAllPageRows(db, config);
    const pageSummaryById = new Map(
      pageRows.map((page) => [
        String(page.id),
        {
          title: String(page.title),
          pageType: String(page.pageType),
          nodeId: normalizeOptionalString(page.nodeId),
          filePath: normalizeOptionalString(page.filePath),
        },
      ]),
    );
    const lint = runLint(env, { level: "info" });

    const enrich = (level: DashboardLogLevel, items: Array<{ page: string; check: string; message: string }>): EnrichedLintIssue[] =>
      items.map((item) => ({
        level,
        pageId: item.page,
        check: item.check,
        message: item.message,
        pageTitle: pageSummaryById.get(item.page)?.title ?? null,
        pageType: pageSummaryById.get(item.page)?.pageType ?? null,
        nodeId: pageSummaryById.get(item.page)?.nodeId ?? null,
        filePath: pageSummaryById.get(item.page)?.filePath ?? null,
      }));

    return [...enrich("error", lint.errors), ...enrich("warning", lint.warnings), ...enrich("info", lint.info)];
  } finally {
    db.close();
  }
}

async function fallbackTitleSearch(
  env: NodeJS.ProcessEnv,
  query: string,
  limit: number,
): Promise<Array<DashboardPageSummary & { summaryText: string }>> {
  const { db, config } = openRuntimeDb(env);
  try {
    const rows = db
      .prepare(
        `
          SELECT ${listPageColumns(config).join(", ")}
          FROM pages
          WHERE title LIKE @query OR summary_text LIKE @query OR file_path LIKE @query
          ORDER BY updated_at DESC, title ASC
          LIMIT @limit
        `,
      )
      .all({
        query: `%${query}%`,
        limit,
      }) as Array<PageRow>;
    return rows.map((row) => {
      const mapped = mapPageRow(row, config);
      return {
        ...buildPageSummary(mapped, config),
        summaryText: typeof mapped.summaryText === "string" ? mapped.summaryText : "",
      };
    });
  } finally {
    db.close();
  }
}

export async function getDashboardGraphOverview(
  env: NodeJS.ProcessEnv = process.env,
  options: { limit?: number | string } = {},
): Promise<Record<string, unknown>> {
  const { db, config } = openRuntimeDb(env);
  try {
    const limit = parsePositiveLimit(options.limit, 120);
    const pageRows = getAllPageRows(db, config);
    const { aliasToNodeKey, nodeKeyToPage } = createPageIndexes(pageRows);
    const edges = normalizeEdges(getAllEdges(db), aliasToNodeKey);
    const selectedKeys = sampleOverviewNodeKeys(pageRows, edges, limit);

    const visibleNodes = [...selectedKeys].reduce<DashboardOverviewNode[]>((nodes, key) => {
        const page = nodeKeyToPage.get(key);
        if (!page) {
          return nodes;
        }
        const degree = edges.filter((edge) => edge.source === key || edge.target === key).length;
        nodes.push({
          ...buildPageSummary(page, config),
          nodeKey: key,
          degree,
          orphan: degree === 0,
          embeddingStatus: page.embeddingStatus ?? null,
          sourceType: page.sourceType ?? null,
        });
        return nodes;
      }, [])
      .sort((left, right) => String(left.title).localeCompare(String(right.title)));
    const visibleEdges = edges.filter((edge) => selectedKeys.has(edge.source) && selectedKeys.has(edge.target));

    return {
      nodes: visibleNodes,
      edges: visibleEdges,
      totalNodes: pageRows.length,
      visibleNodeCount: visibleNodes.length,
      totalEdges: edges.length,
      visibleEdgeCount: visibleEdges.length,
      truncated: visibleNodes.length < pageRows.length,
      sampleStrategy: {
        limit,
        priorities: ["degree", "recency", "pageType coverage", "orphan sampling"],
      },
      generatedAt: toOffsetIso(),
    };
  } finally {
    db.close();
  }
}

export async function searchDashboardGraph(
  env: NodeJS.ProcessEnv = process.env,
  options: { query: string; limit?: number | string } ,
): Promise<Record<string, unknown>> {
  const query = options.query.trim();
  const limit = parsePositiveLimit(options.limit, 20);
  if (!query) {
    return {
      query,
      mode: "empty",
      results: [],
      generatedAt: toOffsetIso(),
    };
  }

  const merged = new Map<string, Record<string, unknown>>();
  let mode: "fts" | "hybrid" | "fallback" = "fts";

  try {
    for (const result of ftsSearchPages(env, {
      query,
      limit,
    })) {
      merged.set(String(result.id), {
        ...result,
        searchKind: "fts",
      });
    }
  } catch {
    mode = "fallback";
  }

  if (merged.size === 0) {
    for (const result of await fallbackTitleSearch(env, query, limit)) {
      merged.set(String(result.id), {
        ...result,
        searchKind: "fallback",
      });
    }
  }

  if (merged.size < limit) {
    try {
      const semanticResults = await searchPages(env, {
        query,
        limit,
      });
      for (const result of semanticResults) {
        if (merged.size >= limit) {
          break;
        }
        const key = String(result.id);
        if (!merged.has(key)) {
          merged.set(key, {
            ...result,
            searchKind: merged.size > 0 ? "semantic" : "semantic-only",
          });
        }
      }
      if (merged.size > 0) {
        mode = mode === "fallback" ? "fallback" : "hybrid";
      }
    } catch {
      // Semantic search is optional.
    }
  }

  return {
    query,
    mode,
    resultCount: merged.size,
    results: [...merged.values()],
    generatedAt: toOffsetIso(),
  };
}

export function getDashboardQueueSummary(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const snapshot = getVaultQueueSnapshot(env);
  const items = snapshot.items.map(buildQueueListItem);
  const processing = items
    .filter((item) => item.status === "processing")
    .sort((left, right) => Number((right.timing as Record<string, unknown>).processingDurationMs ?? 0) - Number((left.timing as Record<string, unknown>).processingDurationMs ?? 0))
    .slice(0, 8);
  const errors = items
    .filter((item) => item.status === "error")
    .sort((left, right) => String((right.timing as Record<string, unknown>).lastErrorAt ?? "").localeCompare(String((left.timing as Record<string, unknown>).lastErrorAt ?? "")))
    .slice(0, 8);
  const recentDone = items
    .filter((item) => item.status === "done" || item.status === "skipped")
    .sort((left, right) => String((right.timing as Record<string, unknown>).processedAt ?? "").localeCompare(String((left.timing as Record<string, unknown>).processedAt ?? "")))
    .slice(0, 12);

  return {
    counts: {
      pending: snapshot.totalPending,
      processing: snapshot.totalProcessing,
      done: snapshot.totalDone,
      skipped: snapshot.totalSkipped,
      error: snapshot.totalError,
      total: snapshot.items.length,
    },
    processing,
    errors,
    recentDone,
    generatedAt: toOffsetIso(),
  };
}

export function listDashboardQueueItems(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    status?: string;
    query?: string;
    sourceType?: string;
    limit?: number | string;
  } = {},
): Record<string, unknown> {
  const status = normalizeQueueStatusFilter(options.status);
  const query = options.query?.trim().toLowerCase() ?? "";
  const sourceType = options.sourceType?.trim().toLowerCase() ?? "";
  const limit = parsePositiveLimit(options.limit, 200);
  const snapshot = getVaultQueueSnapshot(env, status);
  const filtered = snapshot.items
    .filter((item) => (sourceType ? (item.sourceType ?? "").toLowerCase() === sourceType : true))
    .filter((item) => (query ? normalizeQueueSearch(item).includes(query) : true))
    .slice(0, limit)
    .map(buildQueueListItem);

  return {
    total: filtered.length,
    items: filtered,
    generatedAt: toOffsetIso(),
  };
}

export function getDashboardQueueItemDetail(
  env: NodeJS.ProcessEnv = process.env,
  fileId: string,
): Record<string, unknown> {
  const { db, config } = openRuntimeDb(env);
  try {
    const item = getVaultQueueItem(env, fileId);
    if (!item) {
      throw new AppError(`Queue item not found: ${fileId}`, "not_found");
    }

    const artifactBundle = readArtifactBundle(fileId, env);
    const linkedPageIds = [
      item.resultPageId,
      ...(item.createdPageIds ?? []),
      ...(item.updatedPageIds ?? []),
    ].filter((value): value is string => Boolean(value));

    return {
      item: buildQueueListItem(item),
      artifacts: artifactBundle,
      linkedPages: fetchLinkedPageSummaries(db, config, linkedPageIds),
      generatedAt: toOffsetIso(),
    };
  } finally {
    db.close();
  }
}

export function retryDashboardQueueItem(
  env: NodeJS.ProcessEnv = process.env,
  fileId: string,
): Record<string, unknown> {
  const { db } = openRuntimeDb(env);
  try {
    const item = getVaultQueueItem(env, fileId);
    if (!item) {
      throw new AppError(`Queue item not found: ${fileId}`, "not_found");
    }
    if (item.status === "processing") {
      throw new AppError(`Queue item ${fileId} is currently processing and cannot be retried.`, "runtime", {
        code: "busy",
      });
    }

    db.prepare(
      `
        UPDATE vault_processing_queue
        SET
          status = 'pending',
          queued_at = @queued_at,
          claimed_at = NULL,
          started_at = NULL,
          heartbeat_at = NULL,
          processing_owner_id = NULL,
          processed_at = NULL,
          result_page_id = NULL,
          error_message = NULL,
          attempts = 0,
          thread_id = NULL,
          workflow_version = NULL,
          decision = NULL,
          result_manifest_path = NULL,
          last_error_at = NULL,
          last_error_code = NULL,
          retry_after = NULL,
          created_page_ids = NULL,
          updated_page_ids = NULL,
          applied_type_names = NULL,
          proposed_type_names = NULL,
          skills_used = NULL
        WHERE file_id = @file_id
      `,
    ).run({
      file_id: fileId,
      queued_at: toOffsetIso(),
    });

    return {
      status: "queued",
      item: buildQueueListItem(getVaultQueueItem(env, fileId) ?? item),
    };
  } finally {
    db.close();
  }
}

export function getDashboardPageDetail(
  env: NodeJS.ProcessEnv = process.env,
  inputPageId: string,
): Record<string, unknown> {
  const { db, config, paths } = openRuntimeDb(env);
  try {
    const pageId = normalizeDashboardPageId(inputPageId, paths.wikiPath);
    const page = selectPageById(db, config, pageId);
    if (!page) {
      throw new AppError(`Page not found: ${pageId}`, "not_found");
    }

    const pageFilePath = path.join(paths.wikiPath, ...String(page.id).split("/"));
    const parsed = parsePage(pageFilePath, paths.wikiPath, config);
    const pageRows = getAllPageRows(db, config);
    const relations = buildRelationLookup(db, config, pageRows, page);
    const rawData = parsed.ok ? parsed.parsed.rawData : {};

    return {
      page: {
        ...buildPageSummary(page, config),
        nodeKey: pageNodeKey(page),
        summaryText: page.summaryText ?? "",
        embeddingStatus: page.embeddingStatus ?? null,
        markdownPreview: parsed.ok ? previewText(parsed.parsed.body, 4_000) : "",
        frontmatter: rawData,
        unregisteredFields: parsed.ok ? parsed.parsed.unregisteredFields : [],
        pagePath: pageFilePath,
      },
      relations,
      relationCounts: {
        outgoing: relations.filter((relation) => relation.direction === "outgoing").length,
        incoming: relations.filter((relation) => relation.direction === "incoming").length,
      },
      generatedAt: toOffsetIso(),
    };
  } finally {
    db.close();
  }
}

export async function getDashboardPageSource(
  env: NodeJS.ProcessEnv = process.env,
  inputPageId: string,
): Promise<Record<string, unknown>> {
  const { db, config, paths } = openRuntimeDb(env);
  try {
    const pageId = normalizeDashboardPageId(inputPageId, paths.wikiPath);
    const page = selectPageById(db, config, pageId);
    if (!page) {
      throw new AppError(`Page not found: ${pageId}`, "not_found");
    }

    const pageFilePath = path.join(paths.wikiPath, ...String(page.id).split("/"));
    const pageSource = readCanonicalPageSource(pageFilePath, paths.wikiPath, config);

    return {
      pageSource,
      vaultSource: await resolvePageVaultSource(db, config, env, page, pageSource.frontmatter),
      generatedAt: toOffsetIso(),
    };
  } finally {
    db.close();
  }
}

export async function openDashboardPageSource(
  env: NodeJS.ProcessEnv = process.env,
  inputPageId: string,
  target: "vault" | "page" = "vault",
): Promise<Record<string, unknown>> {
  const { db, config, paths } = openRuntimeDb(env);
  try {
    const pageId = normalizeDashboardPageId(inputPageId, paths.wikiPath);
    const page = selectPageById(db, config, pageId);
    if (!page) {
      throw new AppError(`Page not found: ${pageId}`, "not_found");
    }

    const pageFilePath = path.join(paths.wikiPath, ...String(page.id).split("/"));
    if (target === "page") {
      openTarget(pageFilePath);
      return {
        opened: true,
        target: "page",
        path: pageFilePath,
      };
    }

    const parsed = parsePage(pageFilePath, paths.wikiPath, config);
    const rawData = parsed.ok ? parsed.parsed.rawData : {};
    const vaultPath = normalizeOptionalString(rawData.vaultPath) ?? normalizeOptionalString(page.vaultPath);
    if (!vaultPath) {
      openTarget(pageFilePath);
      return {
        opened: true,
        target: "page",
        path: pageFilePath,
      };
    }

    const file = db.prepare(
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
        WHERE id = ?
      `,
    ).get(vaultPath) as VaultFile | undefined;
    if (!file) {
      throw new AppError(`Vault file not found: ${vaultPath}`, "not_found");
    }

    const localPath = await ensureLocalVaultFile(file, paths.vaultPath, env);
    openTarget(localPath);
    return {
      opened: true,
      target: "vault",
      path: localPath,
      fileId: file.id,
    };
  } finally {
    db.close();
  }
}

export function getDashboardVaultSummary(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const { db, config, paths } = openRuntimeDb(env);
  try {
    const files = db.prepare(
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
        ORDER BY id
      `,
    ).all() as VaultFile[];
    const queue = getVaultQueueSnapshot(env);
    const queueByFileId = new Map(queue.items.map((item) => [item.fileId, item]));
    const pages = getAllPageRows(db, config);
    const pagesByVaultPath = new Map<string, DashboardPageSummary[]>();
    for (const page of pages) {
      const vaultPath = normalizeOptionalString(page.vaultPath);
      if (!vaultPath) {
        continue;
      }
      if (!pagesByVaultPath.has(vaultPath)) {
        pagesByVaultPath.set(vaultPath, []);
      }
      pagesByVaultPath.get(vaultPath)!.push(buildPageSummary(page, config));
    }

    const bySourceType: Record<string, { count: number; totalBytes: number }> = {};
    const cacheStatusCounts: Record<string, number> = {};
    let notQueued = 0;
    let totalBytes = 0;

    for (const file of files) {
      const sourceKey = file.sourceType ?? file.fileExt ?? "unknown";
      bySourceType[sourceKey] = bySourceType[sourceKey] ?? { count: 0, totalBytes: 0 };
      bySourceType[sourceKey].count += 1;
      bySourceType[sourceKey].totalBytes += file.fileSize;
      totalBytes += file.fileSize;

      const cacheStatus = getSynologyCacheStatus(paths.vaultPath, file, env).kind;
      cacheStatusCounts[cacheStatus] = (cacheStatusCounts[cacheStatus] ?? 0) + 1;

      if (!queueByFileId.has(file.id)) {
        notQueued += 1;
      }
    }

    return {
      totalFiles: files.length,
      totalBytes,
      coverage: {
        pending: queue.totalPending,
        processing: queue.totalProcessing,
        done: queue.totalDone,
        skipped: queue.totalSkipped,
        error: queue.totalError,
        notQueued,
      },
      bySourceType,
      cacheStatus: cacheStatusCounts,
      mappedPages: [...pagesByVaultPath.values()].reduce((count, pagesForFile) => count + pagesForFile.length, 0),
      generatedAt: toOffsetIso(),
    };
  } finally {
    db.close();
  }
}

export function listDashboardVaultFiles(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    query?: string;
    sourceType?: string;
    queueStatus?: string;
    limit?: number | string;
  } = {},
): Record<string, unknown> {
  const { db, config, paths } = openRuntimeDb(env);
  try {
    const query = options.query?.trim().toLowerCase() ?? "";
    const sourceType = options.sourceType?.trim().toLowerCase() ?? "";
    const queueStatus = options.queueStatus?.trim().toLowerCase() ?? "";
    const limit = parsePositiveLimit(options.limit, 300);

    const files = db.prepare(
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
        ORDER BY id
      `,
    ).all() as VaultFile[];
    const queue = getVaultQueueSnapshot(env);
    const queueByFileId = new Map(queue.items.map((item) => [item.fileId, item]));
    const pages = getAllPageRows(db, config);
    const pageCountByVaultPath = new Map<string, number>();
    for (const page of pages) {
      const vaultPath = normalizeOptionalString(page.vaultPath);
      if (!vaultPath) {
        continue;
      }
      pageCountByVaultPath.set(vaultPath, (pageCountByVaultPath.get(vaultPath) ?? 0) + 1);
    }

    const items = files
      .map((file) => {
        const queueItem = queueByFileId.get(file.id) ?? null;
        const cache = getSynologyCacheStatus(paths.vaultPath, file, env);
        return {
          fileId: file.id,
          fileName: file.fileName,
          fileExt: file.fileExt,
          sourceType: file.sourceType,
          fileSize: file.fileSize,
          filePath: file.filePath,
          indexedAt: file.indexedAt,
          queueStatus: queueItem?.status ?? "not-queued",
          queueItem: queueItem ? buildQueueListItem(queueItem) : null,
          generatedPageCount: pageCountByVaultPath.get(file.id) ?? 0,
          cacheStatus: cache.kind,
          localPath: cache.localPath,
        };
      })
      .filter((item) => (sourceType ? (item.sourceType ?? "").toLowerCase() === sourceType : true))
      .filter((item) => (queueStatus ? item.queueStatus === queueStatus : true))
      .filter((item) => {
        if (!query) {
          return true;
        }
        return [item.fileId, item.fileName, item.filePath]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .slice(0, limit);

    return {
      total: items.length,
      items,
      generatedAt: toOffsetIso(),
    };
  } finally {
    db.close();
  }
}

export async function getDashboardVaultFileDetail(
  env: NodeJS.ProcessEnv = process.env,
  fileId: string,
): Promise<Record<string, unknown>> {
  const { db, config } = openRuntimeDb(env);
  try {
    const file = db.prepare(
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
        WHERE id = ?
      `,
    ).get(fileId) as VaultFile | undefined;
    if (!file) {
      throw new AppError(`Vault file not found: ${fileId}`, "not_found");
    }

    const pageRows = getAllPageRows(db, config).filter((page) => normalizeOptionalString(page.vaultPath) === fileId);
    const relatedPages = pageRows.map((page) => buildPageSummary(page, config));
    const queueItem = getVaultQueueItem(env, fileId);

    return {
      file: {
        ...file,
        ...(await buildVaultPreview(env, file)),
      },
      queueItem: queueItem ? buildQueueListItem(queueItem) : null,
      relatedPages,
      generatedAt: toOffsetIso(),
    };
  } finally {
    db.close();
  }
}

export async function openDashboardVaultFile(
  env: NodeJS.ProcessEnv = process.env,
  fileId: string,
): Promise<Record<string, unknown>> {
  const { db, paths } = openRuntimeDb(env);
  try {
    const file = db.prepare(
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
        WHERE id = ?
      `,
    ).get(fileId) as VaultFile | undefined;
    if (!file) {
      throw new AppError(`Vault file not found: ${fileId}`, "not_found");
    }
    const localPath = await ensureLocalVaultFile(file, paths.vaultPath, env);
    openTarget(localPath);
    return {
      opened: true,
      fileId,
      path: localPath,
    };
  } finally {
    db.close();
  }
}

export function getDashboardLintSummary(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const issues = buildEnrichedLintIssues(env);
  const counts = {
    error: issues.filter((issue) => issue.level === "error").length,
    warning: issues.filter((issue) => issue.level === "warning").length,
    info: issues.filter((issue) => issue.level === "info").length,
  };
  const byRule = new Map<string, number>();
  const byPage = new Map<string, number>();
  for (const issue of issues) {
    byRule.set(issue.check, (byRule.get(issue.check) ?? 0) + 1);
    byPage.set(issue.pageId, (byPage.get(issue.pageId) ?? 0) + 1);
  }

  return {
    counts: {
      ...counts,
      total: counts.error + counts.warning + counts.info,
    },
    topRules: [...byRule.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((left, right) => right.count - left.count || left.rule.localeCompare(right.rule))
      .slice(0, 12),
    topPages: [...byPage.entries()]
      .map(([pageId, count]) => ({
        pageId,
        count,
      }))
      .sort((left, right) => right.count - left.count || left.pageId.localeCompare(right.pageId))
      .slice(0, 12),
    generatedAt: toOffsetIso(),
  };
}

export function listDashboardLintIssues(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    level?: string;
    groupBy?: string;
    rule?: string;
    pageId?: string;
  } = {},
): Record<string, unknown> {
  const level = normalizeLintLevel(options.level);
  const groupBy = normalizeGroupBy(options.groupBy);
  const issues = buildEnrichedLintIssues(env)
    .filter((issue) => (level ? issue.level === level : true))
    .filter((issue) => (options.rule ? issue.check === options.rule : true))
    .filter((issue) => (options.pageId ? issue.pageId === options.pageId : true))
    .sort((left, right) => left.pageId.localeCompare(right.pageId) || left.check.localeCompare(right.check));

  return {
    total: issues.length,
    ...buildLintIssueGroups(issues, groupBy),
    generatedAt: toOffsetIso(),
  };
}

export async function getDashboardStatus(
  env: NodeJS.ProcessEnv = process.env,
  daemonStatus: {
    running: boolean;
    pid: number | null;
    host: string | null;
    port: number | null;
    lastSyncAt: string | null;
    nextSyncAt: string | null;
    lastResult: "ok" | "error" | null;
    syncIntervalSeconds: number | null;
    launchMode: string | null;
    currentTask: string | null;
    state: DaemonState | null;
  },
  options: { probe?: boolean } = {},
): Promise<Record<string, unknown>> {
  const { db, paths } = openRuntimeDb(env);
  try {
    const queue = getVaultQueueSnapshot(env);
    const stats = getWikiStat(env);
    const doctor = await buildDoctorReport(env, { probe: options.probe === true });
    const uptimeMs =
      daemonStatus.state?.startedAt && !Number.isNaN(new Date(daemonStatus.state.startedAt).getTime())
        ? Date.now() - new Date(daemonStatus.state.startedAt).getTime()
        : null;

    return {
      daemon: {
        ...daemonStatus,
        startedAt: daemonStatus.state?.startedAt ?? null,
        uptimeMs,
      },
      stats,
      queue: {
        pending: queue.totalPending,
        processing: queue.totalProcessing,
        done: queue.totalDone,
        skipped: queue.totalSkipped,
        error: queue.totalError,
      },
      runtime: {
        vaultSource: (env.VAULT_SOURCE ?? "local").trim().toLowerCase(),
        wikiPath: paths.wikiPath,
        vaultPath: paths.vaultPath,
        dbPath: paths.dbPath,
      },
      doctor,
      generatedAt: toOffsetIso(),
      lastSyncAt: getMeta(db, "last_sync_at"),
    };
  } finally {
    db.close();
  }
}

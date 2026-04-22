import type { CodexWorkflowRunner } from "../core/codex-workflow.js";
import { getTemplate } from "../core/config.js";
import { inspectFtsIndex, openDb, rebuildFts as rebuildFtsIndex } from "../core/db.js";
import { createFtsTable, FTS_INDEX_VERSION } from "../core/fts.js";
import { resolveAgentSettings } from "../core/paths.js";
import { normalizePageId } from "../core/paths.js";
import { createPageFromTemplate } from "../core/page-files.js";
import { updatePageById } from "../core/page-files.js";
import { readCanonicalPageSourceById, type CanonicalPageSource } from "../core/page-source.js";
import { getEmbeddingDimensionFromEnv, loadRuntimeConfig } from "../core/runtime.js";
import { openRuntimeDb } from "../core/runtime.js";
import { syncWorkspace, type SyncOptions } from "../core/sync.js";
import { getVaultQueueItem, processVaultQueueBatch, type QueueProcessResult } from "../core/vault-processing.js";
import type { FtsTokenizerMode, LoadedWikiConfig } from "../types/config.js";
import { selectPageById } from "../core/query.js";
import type { SyncResult, VaultQueueStatus } from "../types/page.js";
import { AppError, asAppError } from "../utils/errors.js";
import { pathExistsSync } from "../utils/fs.js";

export interface CreatePageOptions {
  type: string;
  title: string;
  nodeId?: string;
}

export interface RunSyncCommandOptions extends Omit<SyncOptions, "env"> {
  process?: boolean;
  vaultFileId?: string;
  workflowRunner?: CodexWorkflowRunner;
}

export interface UpdatePageOptions {
  pageId: string;
  bodyMarkdown?: string;
  frontmatterPatch?: Record<string, unknown>;
  ifRevision?: string;
}

export type QueueProcessNoopReason = "already_done" | "already_skipped" | null;

export interface SyncQueueProcessResult extends Omit<QueueProcessResult, "enabled"> {
  enabled: true;
  requestedFileId: string | null;
  currentStatus: VaultQueueStatus | null;
  noopReason: QueueProcessNoopReason;
}

export interface SyncCommandResult extends SyncResult {
  queueProcess: SyncQueueProcessResult | null;
}

export interface RebuildFtsCommandOptions {
  mode?: FtsTokenizerMode;
  check?: boolean;
}

export interface RebuildFtsCommandResult {
  checked: boolean;
  rebuilt: boolean;
  mode: FtsTokenizerMode;
  rowCount: number;
  expectedIndexVersion: string;
  storedIndexVersion: string | null;
  storedTokenizerMode: string | null;
  storedExtensionVersion: string | null;
  extensionVersion: string | null;
  simpleExtensionPath: string | null;
  lastRebuildAt: string | null;
  needsRecreate: boolean;
  needsRebuild: boolean;
  problems: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function applyFtsModeOverride(
  config: LoadedWikiConfig,
  mode: FtsTokenizerMode | undefined,
): LoadedWikiConfig {
  if (!mode || config.fts.tokenizer === mode) {
    return config;
  }

  return {
    ...config,
    fts: {
      ...config.fts,
      tokenizer: mode,
    },
  };
}

function assertValidSyncCommandOptions(options: RunSyncCommandOptions): void {
  if (options.vaultFileId && !options.process) {
    throw new AppError("--vault-file requires --process.", "config");
  }

  if (options.process && options.targetPaths && options.targetPaths.length > 0) {
    throw new AppError("--process cannot be combined with --path.", "config");
  }
}

function assertQueueProcessingEnabled(env: NodeJS.ProcessEnv): void {
  const agentSettings = resolveAgentSettings(env, { strict: true });
  if (!agentSettings.enabled) {
    throw new AppError("Queue processing requires WIKI_AGENT_ENABLED=true.", "config");
  }
  if (agentSettings.batchSize === 0) {
    throw new AppError("Queue processing requires WIKI_AGENT_BATCH_SIZE > 0.", "config");
  }
}

function buildQueueProcessResult(
  queueResult: QueueProcessResult,
  meta: {
    requestedFileId?: string | null;
    currentStatus?: VaultQueueStatus | null;
    noopReason?: QueueProcessNoopReason;
  } = {},
): SyncQueueProcessResult {
  if (!queueResult.enabled) {
    throw new AppError("Queue processing is disabled.", "config");
  }

  return {
    ...queueResult,
    enabled: true,
    requestedFileId: meta.requestedFileId ?? null,
    currentStatus: meta.currentStatus ?? null,
    noopReason: meta.noopReason ?? null,
  };
}

function buildQueueProcessNoopResult(
  fileId: string,
  status: Extract<VaultQueueStatus, "done" | "skipped">,
): SyncQueueProcessResult {
  return {
    enabled: true,
    requestedFileId: fileId,
    processed: 0,
    done: 0,
    skipped: 0,
    errored: 0,
    items: [],
    currentStatus: status,
    noopReason: status === "done" ? "already_done" : "already_skipped",
  };
}

export async function runSync(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<SyncOptions, "env"> = {},
) {
  return syncWorkspace({
    ...options,
    env,
  });
}

async function processQueueAfterSync(
  env: NodeJS.ProcessEnv,
  options: Pick<RunSyncCommandOptions, "vaultFileId" | "workflowRunner">,
): Promise<SyncQueueProcessResult> {
  assertQueueProcessingEnabled(env);

  if (!options.vaultFileId) {
    return buildQueueProcessResult(
      await processVaultQueueBatch(env, {
        workflowRunner: options.workflowRunner,
      }),
    );
  }

  const requestedFileId = options.vaultFileId;
  const queueItem = getVaultQueueItem(env, requestedFileId);
  if (!queueItem) {
    throw new AppError(`Vault queue item not found: ${requestedFileId}`, "not_found");
  }

  if (queueItem.status === "processing") {
    throw new AppError(`Vault queue item is already processing: ${requestedFileId}`, "runtime", {
      fileId: requestedFileId,
      status: queueItem.status,
    });
  }

  if (queueItem.status === "done" || queueItem.status === "skipped") {
    return buildQueueProcessNoopResult(requestedFileId, queueItem.status);
  }

  const queueResult = await processVaultQueueBatch(env, {
    maxItems: 1,
    filterFileIds: [requestedFileId],
    workflowRunner: options.workflowRunner,
  });
  if (queueResult.processed > 0) {
    return buildQueueProcessResult(queueResult, {
      requestedFileId,
      currentStatus: getVaultQueueItem(env, requestedFileId)?.status ?? null,
    });
  }

  const current = getVaultQueueItem(env, requestedFileId);
  if (!current) {
    throw new AppError(`Vault queue item not found: ${requestedFileId}`, "not_found");
  }
  if (current.status === "done" || current.status === "skipped") {
    return buildQueueProcessNoopResult(requestedFileId, current.status);
  }
  if (current.status === "processing") {
    throw new AppError(`Vault queue item is already processing: ${requestedFileId}`, "runtime", {
      fileId: requestedFileId,
      status: current.status,
    });
  }

  throw new AppError(`Failed to claim vault queue item for processing: ${requestedFileId}`, "runtime", {
    fileId: requestedFileId,
    status: current.status,
  });
}

export async function runSyncCommand(
  env: NodeJS.ProcessEnv = process.env,
  options: RunSyncCommandOptions = {},
): Promise<SyncCommandResult> {
  assertValidSyncCommandOptions(options);

  const syncResult = await runSync(env, {
    targetPaths: options.targetPaths,
    force: options.force,
    skipEmbedding: options.skipEmbedding,
  });

  if (!options.process) {
    return {
      ...syncResult,
      queueProcess: null,
    };
  }

  return {
    ...syncResult,
    queueProcess: await processQueueAfterSync(env, {
      vaultFileId: options.vaultFileId,
      workflowRunner: options.workflowRunner,
    }),
  };
}

export function rebuildFtsCommand(
  env: NodeJS.ProcessEnv = process.env,
  options: RebuildFtsCommandOptions = {},
): RebuildFtsCommandResult {
  const { paths, config } = loadRuntimeConfig(env);
  const effectiveConfig = applyFtsModeOverride(config, options.mode);

  if (!pathExistsSync(paths.dbPath)) {
    return {
      checked: true,
      rebuilt: false,
      mode: effectiveConfig.fts.tokenizer,
      rowCount: 0,
      expectedIndexVersion: FTS_INDEX_VERSION,
      storedIndexVersion: null,
      storedTokenizerMode: null,
      storedExtensionVersion: null,
      extensionVersion: null,
      simpleExtensionPath: null,
      lastRebuildAt: null,
      needsRecreate: true,
      needsRebuild: true,
      problems: [`Wiki database does not exist yet: ${paths.dbPath}`],
    };
  }

  const { db, ftsExtensionVersion, simpleExtensionPath, initialFtsInspection } = openDb(
    paths.dbPath,
    effectiveConfig,
    getEmbeddingDimensionFromEnv(env),
    paths.packageRoot,
    {
      ensureFts: false,
    },
  );

  try {
    if (!options.check) {
      if (initialFtsInspection.needsRecreate) {
        if (initialFtsInspection.hasTable) {
          db.exec("DROP TABLE pages_fts");
        }
        createFtsTable(db, effectiveConfig.fts.tokenizer);
      }
      rebuildFtsIndex(db, effectiveConfig, ftsExtensionVersion);
    }

    const inspection = options.check
      ? initialFtsInspection
      : inspectFtsIndex(db, effectiveConfig, ftsExtensionVersion);

    return {
      checked: true,
      rebuilt: options.check ? false : true,
      mode: effectiveConfig.fts.tokenizer,
      rowCount: inspection.rowCount,
      expectedIndexVersion: inspection.expectedIndexVersion,
      storedIndexVersion: inspection.storedIndexVersion,
      storedTokenizerMode: inspection.storedTokenizerMode,
      storedExtensionVersion: inspection.storedExtensionVersion,
      extensionVersion: ftsExtensionVersion,
      simpleExtensionPath,
      lastRebuildAt: inspection.lastRebuildAt,
      needsRecreate: inspection.needsRecreate,
      needsRebuild: inspection.needsRebuild,
      problems: inspection.problems,
    };
  } finally {
    db.close();
  }
}

export async function createPage(
  env: NodeJS.ProcessEnv = process.env,
  options: CreatePageOptions,
): Promise<{ created: string; filePath: string }> {
  const { paths, config } = loadRuntimeConfig(env);
  getTemplate(config, options.type);
  const created = createPageFromTemplate(paths, config, {
    pageType: options.type,
    title: options.title,
    nodeId: options.nodeId ?? undefined,
  });
  try {
    await syncWorkspace({
      env,
      targetPaths: [created.pageId],
    });
  } catch (error) {
    const appError = asAppError(error);
    throw new AppError(`Sync failed after creating page: ${created.pageId}`, "runtime", {
      code: "sync_failed",
      pageId: created.pageId,
      filePath: created.filePath,
      revisionAfter: readCanonicalPageSourceById(created.pageId, paths.wikiPath, config).revision,
      cause: appError.message,
    });
  }

  return {
    created: created.pageId,
    filePath: created.filePath,
  };
}

export async function updatePage(
  env: NodeJS.ProcessEnv = process.env,
  options: UpdatePageOptions,
): Promise<CanonicalPageSource> {
  const pageIdInput = typeof options.pageId === "string" ? options.pageId.trim() : "";
  if (!pageIdInput) {
    throw new AppError("pageId is required.", "config", {
      code: "invalid_request",
      field: "pageId",
    });
  }

  const hasBodyMarkdown = typeof options.bodyMarkdown === "string";
  const hasFrontmatterPatch =
    options.frontmatterPatch !== undefined &&
    isPlainObject(options.frontmatterPatch) &&
    Object.keys(options.frontmatterPatch).length > 0;

  if (options.frontmatterPatch !== undefined && !isPlainObject(options.frontmatterPatch)) {
    throw new AppError("frontmatterPatch must be an object.", "config", {
      code: "invalid_request",
      field: "frontmatterPatch",
    });
  }

  if (!hasBodyMarkdown && !hasFrontmatterPatch) {
    throw new AppError("bodyMarkdown or frontmatterPatch is required.", "config", {
      code: "invalid_request",
    });
  }

  const { db, config, paths } = openRuntimeDb(env);
  let canonicalPageId: string;
  try {
    const normalizedPageId = normalizePageId(pageIdInput, paths.wikiPath);
    const page = selectPageById(db, config, normalizedPageId);
    if (!page) {
      throw new AppError(`Page not found: ${normalizedPageId}`, "not_found");
    }
    canonicalPageId = String(page.id);
  } finally {
    db.close();
  }

  const currentSource = readCanonicalPageSourceById(canonicalPageId, paths.wikiPath, config);
  const expectedRevision =
    typeof options.ifRevision === "string" && options.ifRevision.trim() ? options.ifRevision.trim() : null;
  if (expectedRevision && currentSource.revision !== expectedRevision) {
    throw new AppError(`Page revision conflict: ${canonicalPageId}`, "runtime", {
      code: "revision_conflict",
      pageId: canonicalPageId,
      ifRevision: expectedRevision,
      currentRevision: currentSource.revision,
    });
  }

  updatePageById(paths, canonicalPageId, {
    bodyMarkdown: hasBodyMarkdown ? options.bodyMarkdown : undefined,
    frontmatterPatch: hasFrontmatterPatch ? options.frontmatterPatch : undefined,
  });

  try {
    await syncWorkspace({
      env,
      targetPaths: [canonicalPageId],
    });
  } catch (error) {
    const appError = asAppError(error);
    throw new AppError(`Sync failed after updating page: ${canonicalPageId}`, "runtime", {
      code: "sync_failed",
      pageId: canonicalPageId,
      revisionBefore: currentSource.revision,
      revisionAfter: readCanonicalPageSourceById(canonicalPageId, paths.wikiPath, config).revision,
      cause: appError.message,
    });
  }

  return readCanonicalPageSourceById(canonicalPageId, paths.wikiPath, config);
}

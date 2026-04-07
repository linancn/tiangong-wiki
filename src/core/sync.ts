import type Database from "better-sqlite3";

import { loadConfig } from "./config.js";
import {
  clearAllIndexedData,
  getMeta,
  openDb,
  resetVectorTable,
  setMetaValues,
} from "./db.js";
import { EmbeddingClient } from "./embedding.js";
import { applyChanges, scanPages, scanSpecificPages } from "./indexer.js";
import { resolveRuntimePaths } from "./paths.js";
import { collectVaultFiles, syncVaultIndex } from "./vault.js";
import type { Page, SyncResult } from "../types/page.js";
import { AppError } from "../utils/errors.js";
import { pathExistsSync } from "../utils/fs.js";
import { makeSyncId, toOffsetIso } from "../utils/time.js";

export interface SyncOptions {
  targetPaths?: string[];
  force?: boolean;
  skipEmbedding?: boolean;
  env?: NodeJS.ProcessEnv;
}

function getEmbeddingDimension(env: NodeJS.ProcessEnv): number {
  const raw = env.EMBEDDING_DIMENSIONS ?? "384";
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 384;
}

function getEmbeddingTargets(
  db: Database.Database,
  embedAll: boolean,
  insertedIds: string[],
  summaryChangedIds: string[],
): Array<{ rowid: number; id: string; summaryText: string }> {
  const rows = db.prepare("SELECT rowid, id, summary_text AS summaryText, embedding_status AS embeddingStatus FROM pages").all() as Array<{
    rowid: number;
    id: string;
    summaryText: string;
    embeddingStatus: string;
  }>;

  if (embedAll) {
    return rows.map(({ rowid, id, summaryText }) => ({ rowid, id, summaryText }));
  }

  const changedIds = new Set([...insertedIds, ...summaryChangedIds]);
  return rows
    .filter((row) => changedIds.has(row.id) || row.embeddingStatus === "pending" || row.embeddingStatus === "error")
    .map(({ rowid, id, summaryText }) => ({ rowid, id, summaryText }));
}

async function embedPages(
  db: Database.Database,
  embeddingClient: EmbeddingClient,
  targets: Array<{ rowid: number; id: string; summaryText: string }>,
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  if (targets.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  const upsertVector = db.prepare(
    "INSERT INTO vec_pages(page_rowid, page_id, embedding) VALUES (?, ?, ?)",
  );
  const deleteVector = db.prepare("DELETE FROM vec_pages WHERE page_rowid = ?");
  const updateStatus = db.prepare("UPDATE pages SET embedding_status = ? WHERE id = ?");

  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < targets.length; index += 50) {
    const batch = targets.slice(index, index + 50);
    try {
      const embeddings = await embeddingClient.embedBatch(batch.map((item) => item.summaryText));
        const transaction = db.transaction(() => {
        for (let offset = 0; offset < batch.length; offset += 1) {
          deleteVector.run(BigInt(batch[offset].rowid));
          upsertVector.run(
            BigInt(batch[offset].rowid),
            batch[offset].id,
            new Float32Array(embeddings[offset]),
          );
          updateStatus.run("done", batch[offset].id);
        }
      });
      transaction();
      succeeded += batch.length;
    } catch (error) {
      const transaction = db.transaction(() => {
        for (const item of batch) {
          updateStatus.run("error", item.id);
        }
      });
      transaction();
      failed += batch.length;
      if (targets.length === batch.length) {
        throw error;
      }
    }
  }

  return {
    attempted: targets.length,
    succeeded,
    failed,
  };
}

function countPendingEmbeddings(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM pages WHERE embedding_status IN ('pending', 'error')")
    .get() as { count: number };
  return row.count;
}

export async function syncWorkspace(options: SyncOptions = {}): Promise<SyncResult> {
  const env = options.env ?? process.env;
  const runtimePaths = resolveRuntimePaths(env);
  if (!pathExistsSync(runtimePaths.wikiPath)) {
    throw new AppError(`WIKI_PATH does not exist: ${runtimePaths.wikiPath}`, "config");
  }
  const config = loadConfig(runtimePaths.configPath);
  const embeddingClient = EmbeddingClient.fromEnv(env);
  const { db, configChanged } = openDb(
    runtimePaths.dbPath,
    config,
    embeddingClient?.settings.dimensions ?? getEmbeddingDimension(env),
  );

  try {
    let mode: "full" | "path" =
      options.targetPaths && options.targetPaths.length > 0 && !options.force ? "path" : "full";
    let upgradedToFullSync = false;
    const storedEmbeddingProfile = embeddingClient ? getMeta(db, "embedding_profile") : null;
    const profileChanged = Boolean(
      embeddingClient && storedEmbeddingProfile && storedEmbeddingProfile !== embeddingClient.profileHash,
    );

    if (mode === "path" && (configChanged || profileChanged)) {
      mode = "full";
      upgradedToFullSync = true;
    }

    if (profileChanged && options.skipEmbedding) {
      throw new AppError("Embedding profile changed, cannot skip embedding.", "config");
    }

    if (options.force) {
      clearAllIndexedData(db);
      mode = "full";
    }

    const changes =
      mode === "path"
        ? scanSpecificPages(db, runtimePaths.wikiPath, options.targetPaths ?? [], configChanged, false)
        : scanPages(db, runtimePaths.wikiPath, configChanged, false);

    if (
      mode === "path" &&
      changes.added.length === 0 &&
      changes.modified.length === 0 &&
      changes.deleted.length === 0 &&
      changes.unchanged.length === 0
    ) {
      throw new AppError(`No page matched the requested --path value(s).`, "not_found");
    }

    const applyResult = applyChanges(db, changes, runtimePaths.wikiPath, config);
    if (applyResult.parseErrors.length > 0) {
      throw new AppError("Failed to parse one or more wiki pages during sync.", "runtime", {
        parseErrors: applyResult.parseErrors,
      });
    }

    let embedAll = false;
    if (embeddingClient && profileChanged) {
      resetVectorTable(db, embeddingClient.settings.dimensions);
      db.prepare("UPDATE pages SET embedding_status = 'pending'").run();
      embedAll = true;
    }

    let embeddingAttempted = 0;
    let embeddingSucceeded = 0;
    let embeddingFailed = 0;

    const skipEmbedding = options.skipEmbedding === true || embeddingClient === null;
    if (embeddingClient && !skipEmbedding) {
      const targets = getEmbeddingTargets(
        db,
        embedAll,
        applyResult.inserted,
        applyResult.summaryChangedIds,
      );
      const embeddingResult = await embedPages(db, embeddingClient, targets);
      embeddingAttempted = embeddingResult.attempted;
      embeddingSucceeded = embeddingResult.succeeded;
      embeddingFailed = embeddingResult.failed;

      const hasPending = countPendingEmbeddings(db) > 0;
      if (!hasPending) {
        setMetaValues(db, {
          embedding_profile: embeddingClient.profileHash,
        });
      }
    }

    let vaultFiles = 0;
    let vaultChanges = 0;
    let syncId: string | null = null;
    let vaultQueue = {
      pendingAdded: 0,
      pendingReset: 0,
      removed: 0,
    };
    if (mode === "full") {
      syncId = makeSyncId();
      const currentVaultFiles = collectVaultFiles(runtimePaths.vaultPath, runtimePaths.packageRoot, env);
      const vaultResult = syncVaultIndex(db, currentVaultFiles, syncId);
      vaultFiles = vaultResult.files;
      vaultChanges = vaultResult.changes.length;
      vaultQueue = vaultResult.queue;
    }

    setMetaValues(db, {
      config_version: config.configVersion,
      last_sync_at: toOffsetIso(),
      ...(mode === "full" ? { last_sync_id: syncId } : {}),
      ...(options.force ? { last_full_rebuild_at: toOffsetIso() } : {}),
    });

    return {
      mode,
      upgradedToFullSync,
      configChanged,
      profileChanged,
      inserted: applyResult.inserted.length,
      updated: applyResult.updated.length,
      deleted: applyResult.deleted.length,
      unchanged: changes.unchanged.length,
      summaryChanged: applyResult.summaryChangedIds.length,
      embedding: {
        enabled: embeddingClient !== null,
        skipped: skipEmbedding,
        attempted: embeddingAttempted,
        succeeded: embeddingSucceeded,
        failed: embeddingFailed,
        embedAll,
      },
      vault: {
        scanned: mode === "full",
        files: vaultFiles,
        changes: vaultChanges,
        syncId,
        queue: vaultQueue,
      },
    };
  } finally {
    db.close();
  }
}

export async function embedPendingPages(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtimePaths = resolveRuntimePaths(env);
  const config = loadConfig(runtimePaths.configPath);
  const embeddingClient = EmbeddingClient.fromEnv(env);
  if (!embeddingClient) {
    return;
  }

  const { db } = openDb(runtimePaths.dbPath, config, embeddingClient.settings.dimensions);
  try {
    const targets = getEmbeddingTargets(db, false, [], []);
    const result = await embedPages(db, embeddingClient, targets);
    if (result.failed === 0 && countPendingEmbeddings(db) === 0) {
      setMetaValues(db, { embedding_profile: embeddingClient.profileHash });
    }
  } finally {
    db.close();
  }
}

export function readAllPages(db: Database.Database): Page[] {
  const rows = db.prepare(
    `
      SELECT
        id,
        node_id AS nodeId,
        title,
        page_type AS pageType,
        status,
        visibility,
        tags,
        extra,
        file_path AS filePath,
        content_hash AS contentHash,
        summary_text AS summaryText,
        embedding_status AS embeddingStatus,
        file_mtime AS fileMtime,
        created_at AS createdAt,
        updated_at AS updatedAt,
        indexed_at AS indexedAt
      FROM pages
    `,
  ).all() as Array<{
    id: string;
    nodeId: string | null;
    title: string;
    pageType: string;
    status: string;
    visibility: string;
    tags: string | null;
    extra: string | null;
    filePath: string;
    contentHash: string | null;
    summaryText: string;
    embeddingStatus: "pending" | "done" | "error";
    fileMtime: number | null;
    createdAt: string | null;
    updatedAt: string | null;
    indexedAt: string | null;
  }>;

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    extra: row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {},
  }));
}

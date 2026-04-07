import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import path from "node:path";

import type { VaultChange, VaultFile, VaultHashMode } from "../types/page.js";
import { AppError } from "../utils/errors.js";
import {
  ensureDirSync,
  fileStatSync,
  listFilesRecursiveSync,
  pathExistsSync,
  readTextFileSync,
  sha256FileSync,
  sha256Text,
  writeTextFileSync,
} from "../utils/fs.js";
import { toOffsetIso } from "../utils/time.js";

interface SynologyListItem {
  name?: string;
  path?: string;
  real_path?: string;
  isdir?: boolean;
  type?: string;
  size?: number;
  additional?: {
    real_path?: string;
    size?: number;
    time?: {
      mtime?: number;
    };
    type?: string;
  };
  time?: {
    mtime?: number;
  };
}

interface SynologyCacheMetadata {
  remotePath: string;
  fileSize: number;
  fileMtime: number | null;
}

function normalizeVaultId(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function computeVaultHash(
  mode: VaultHashMode,
  fileId: string,
  filePath: string,
  fileSize: number,
  fileMtime: number,
): string {
  if (mode === "mtime") {
    return sha256Text(`${fileId}:${filePath}:${fileSize}:${fileMtime}`);
  }
  return sha256FileSync(filePath);
}

function localVaultFiles(vaultPath: string, hashMode: VaultHashMode): VaultFile[] {
  const indexedAt = toOffsetIso();
  return listFilesRecursiveSync(vaultPath).map((filePath) => {
    const stats = fileStatSync(filePath);
    const id = normalizeVaultId(vaultPath, filePath);
    const fileExt = path.extname(filePath).replace(/^\./, "") || null;

    return {
      id,
      fileName: path.basename(filePath),
      fileExt,
      sourceType: fileExt,
      fileSize: stats.size,
      filePath,
      contentHash: computeVaultHash(hashMode, id, filePath, stats.size, stats.mtimeMs),
      fileMtime: stats.mtimeMs,
      indexedAt,
    };
  });
}

function getSynologyScriptPath(packageRoot: string, env: NodeJS.ProcessEnv): string {
  const override = env.SYNOLOGY_FILE_STATION_SCRIPT;
  if (override) {
    return override;
  }

  return path.resolve(packageRoot, "..", "synology-file-station", "scripts", "synology_file_station.py");
}

function getExtractionScriptPath(packageRoot: string): string {
  return path.join(packageRoot, "scripts", "extract_vault_text.py");
}

function getSynologyCacheMetaPath(localPath: string): string {
  return `${localPath}.wiki-cache.json`;
}

function readSynologyCacheMetadata(localPath: string): SynologyCacheMetadata | null {
  const metadataPath = getSynologyCacheMetaPath(localPath);
  if (!pathExistsSync(metadataPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readTextFileSync(metadataPath)) as Partial<SynologyCacheMetadata>;
    if (
      typeof parsed.remotePath === "string" &&
      typeof parsed.fileSize === "number" &&
      (typeof parsed.fileMtime === "number" || parsed.fileMtime === null)
    ) {
      return {
        remotePath: parsed.remotePath,
        fileSize: parsed.fileSize,
        fileMtime: parsed.fileMtime,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function writeSynologyCacheMetadata(localPath: string, file: VaultFile): void {
  writeTextFileSync(
    getSynologyCacheMetaPath(localPath),
    `${JSON.stringify(
      {
        remotePath: file.filePath,
        fileSize: file.fileSize,
        fileMtime: file.fileMtime,
      },
      null,
      2,
    )}\n`,
  );
}

function isSynologyCacheFresh(localPath: string, file: VaultFile): boolean {
  if (!pathExistsSync(localPath)) {
    return false;
  }

  const metadata = readSynologyCacheMetadata(localPath);
  if (!metadata) {
    return false;
  }

  return (
    metadata.remotePath === file.filePath &&
    metadata.fileSize === file.fileSize &&
    metadata.fileMtime === file.fileMtime
  );
}

function parseSynologyItems(payload: unknown): SynologyListItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = (payload as { data?: { files?: unknown; items?: unknown } }).data;
  if (Array.isArray(data?.files)) {
    return data.files as SynologyListItem[];
  }
  if (Array.isArray(data?.items)) {
    return data.items as SynologyListItem[];
  }

  return [];
}

function parseJsonPayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AppError("Failed to parse JSON payload from helper script", "runtime", {
      cause: error instanceof Error ? error.message : String(error),
      raw,
    });
  }
}

function listSynologyFolderPage(
  scriptPath: string,
  folder: string,
  offset: number,
  limit: number,
): SynologyListItem[] {
  const raw = execFileSync(
    "python3",
    [
      scriptPath,
      "list",
      "--folder",
      folder,
      "--filetype",
      "all",
      "--offset",
      String(offset),
      "--limit",
      String(limit),
    ],
    {
      encoding: "utf8",
    },
  );
  const payload = parseJsonPayload(raw);
  return parseSynologyItems(payload);
}

function listSynologyFolderAll(scriptPath: string, folder: string): SynologyListItem[] {
  const results: SynologyListItem[] = [];
  const pageSize = 500;
  let offset = 0;

  while (true) {
    const items = listSynologyFolderPage(scriptPath, folder, offset, pageSize);
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

function scanSynologyFolder(
  scriptPath: string,
  remoteRoot: string,
  currentFolder: string,
  results: VaultFile[],
  hashMode: VaultHashMode,
): void {
  const indexedAt = toOffsetIso();
  const items = listSynologyFolderAll(scriptPath, currentFolder);
  for (const item of items) {
    const filePath = item.path ?? item.real_path ?? item.additional?.real_path;
    if (!filePath) {
      continue;
    }

    const isDirectory =
      item.isdir === true || item.type === "dir" || item.additional?.type === "dir";
    if (isDirectory) {
      scanSynologyFolder(scriptPath, remoteRoot, filePath, results, hashMode);
      continue;
    }

    const relativeId = filePath
      .replace(new RegExp(`^${remoteRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "")
      .replace(/^\/+/, "");
    const fileExt = path.extname(filePath).replace(/^\./, "") || null;
    const fileSize = Number(item.additional?.size ?? item.size ?? 0);
    const fileMtime = Number(item.additional?.time?.mtime ?? item.time?.mtime ?? 0);

    results.push({
      id: relativeId,
      fileName: item.name ?? path.basename(filePath),
      fileExt,
      sourceType: fileExt,
      fileSize,
      filePath,
      contentHash:
        hashMode === "mtime"
          ? sha256Text(`${relativeId}:${filePath}:${fileSize}:${fileMtime}`)
          : sha256Text(`${relativeId}:${filePath}:${fileSize}:${fileMtime}`),
      fileMtime,
      indexedAt,
    });
  }
}

function synologyVaultFiles(
  remoteRoot: string,
  vaultPath: string,
  packageRoot: string,
  env: NodeJS.ProcessEnv,
  hashMode: VaultHashMode,
): VaultFile[] {
  const scriptPath = getSynologyScriptPath(packageRoot, env);
  const results: VaultFile[] = [];
  const normalizedRoot = remoteRoot.replace(/\/+$/g, "");
  scanSynologyFolder(scriptPath, normalizedRoot, normalizedRoot, results, hashMode);
  const sorted = results.sort((left, right) => left.id.localeCompare(right.id));
  if (hashMode !== "content") {
    return sorted;
  }

  return sorted.map((file) => ({
    ...file,
    contentHash: sha256FileSync(ensureLocalVaultFile(file, vaultPath, packageRoot, env)),
  }));
}

function getExistingVaultFiles(db: Database.Database): Map<string, VaultFile> {
  const rows = db.prepare(
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
    `,
  ).all() as VaultFile[];

  return new Map(rows.map((row) => [row.id, row]));
}

export function getVaultQueuePriority(fileExt: string | null): number {
  const normalized = (fileExt ?? "").toLowerCase();
  if (normalized === "pdf") {
    return 100;
  }
  if (normalized === "docx") {
    return 95;
  }
  if (normalized === "pptx") {
    return 90;
  }
  if (normalized === "xlsx") {
    return 85;
  }
  if (normalized === "md") {
    return 80;
  }
  if (normalized === "txt") {
    return 70;
  }
  if (normalized === "csv") {
    return 65;
  }
  if (normalized === "png" || normalized === "jpg" || normalized === "jpeg" || normalized === "webp") {
    return 10;
  }
  return 20;
}

export function collectVaultFiles(
  vaultPath: string,
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): VaultFile[] {
  const source = (env.VAULT_SOURCE ?? "local").trim().toLowerCase();
  const hashMode = ((env.VAULT_HASH_MODE ?? "content").trim().toLowerCase() === "mtime"
    ? "mtime"
    : "content") as VaultHashMode;
  if (source === "synology") {
    const remotePath = env.VAULT_SYNOLOGY_REMOTE_PATH;
    if (!remotePath) {
      throw new AppError("VAULT_SYNOLOGY_REMOTE_PATH is required when VAULT_SOURCE=synology", "config");
    }

    return synologyVaultFiles(remotePath, vaultPath, packageRoot, env, hashMode);
  }

  return localVaultFiles(vaultPath, hashMode);
}

export function ensureLocalVaultFile(
  file: VaultFile,
  vaultPath: string,
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const source = (env.VAULT_SOURCE ?? "local").trim().toLowerCase();
  if (source !== "synology") {
    return file.filePath;
  }

  const remoteRoot = env.VAULT_SYNOLOGY_REMOTE_PATH;
  if (!remoteRoot) {
    throw new AppError("VAULT_SYNOLOGY_REMOTE_PATH is required when VAULT_SOURCE=synology", "config");
  }

  const localPath = path.join(vaultPath, ...file.id.split("/"));
  if (isSynologyCacheFresh(localPath, file)) {
    return localPath;
  }

  ensureDirSync(path.dirname(localPath));
  const remotePath = path.posix.join(remoteRoot.replace(/\/+$/g, ""), file.id);
  const scriptPath = getSynologyScriptPath(packageRoot, env);
  execFileSync(
    "python3",
    [scriptPath, "download", "--path", remotePath, "--output", localPath],
    {
      encoding: "utf8",
      env,
    },
  );
  writeSynologyCacheMetadata(localPath, file);
  return localPath;
}

export function extractVaultText(filePath: string, packageRoot: string): string {
  const scriptPath = getExtractionScriptPath(packageRoot);
  const raw = execFileSync("python3", [scriptPath, filePath], {
    encoding: "utf8",
  });
  const payload = parseJsonPayload(raw) as { text?: unknown; error?: unknown };
  if (payload.error) {
    throw new AppError(String(payload.error), "runtime");
  }
  return typeof payload.text === "string" ? payload.text.trim() : "";
}

export function syncVaultIndex(
  db: Database.Database,
  currentFiles: VaultFile[],
  syncId: string,
): {
  files: number;
  changes: VaultChange[];
  queue: {
    pendingAdded: number;
    pendingReset: number;
    removed: number;
  };
} {
  const existing = getExistingVaultFiles(db);
  const current = new Map(currentFiles.map((file) => [file.id, file]));
  const existingQueue = new Map(
    (
      db.prepare(
        `
          SELECT file_id AS fileId, status
          FROM vault_processing_queue
        `,
      ).all() as Array<{ fileId: string; status: string }>
    ).map((row) => [row.fileId, row.status]),
  );
  const detectedAt = toOffsetIso();
  const changes: VaultChange[] = [];
  const queueStats = {
    pendingAdded: 0,
    pendingReset: 0,
    removed: 0,
  };

  for (const file of currentFiles) {
    const previous = existing.get(file.id);
    if (!previous) {
      changes.push({ fileId: file.id, action: "added", detectedAt, syncId });
      continue;
    }

    if (previous.contentHash !== file.contentHash) {
      changes.push({ fileId: file.id, action: "modified", detectedAt, syncId });
    }
  }

  for (const [id] of existing) {
    if (!current.has(id)) {
      changes.push({ fileId: id, action: "removed", detectedAt, syncId });
    }
  }

  const upsertStatement = db.prepare(
    `
      INSERT INTO vault_files(
        id, file_name, file_ext, source_type, file_size, file_path, content_hash, file_mtime, indexed_at
      ) VALUES (
        @id, @file_name, @file_ext, @source_type, @file_size, @file_path, @content_hash, @file_mtime, @indexed_at
      )
      ON CONFLICT(id) DO UPDATE SET
        file_name = excluded.file_name,
        file_ext = excluded.file_ext,
        source_type = excluded.source_type,
        file_size = excluded.file_size,
        file_path = excluded.file_path,
        content_hash = excluded.content_hash,
        file_mtime = excluded.file_mtime,
        indexed_at = excluded.indexed_at
    `,
  );
  const insertChange = db.prepare(
    `
      INSERT INTO vault_changelog(file_id, action, detected_at, sync_id)
      VALUES(@file_id, @action, @detected_at, @sync_id)
    `,
  );
  const deleteMissing = db.prepare("DELETE FROM vault_files WHERE id = ?");
  const deleteQueue = db.prepare("DELETE FROM vault_processing_queue WHERE file_id = ?");
  const upsertQueue = db.prepare(
    `
      INSERT INTO vault_processing_queue(
        file_id,
        status,
        priority,
        queued_at,
        processed_at,
        result_page_id,
        error_message,
        attempts,
        thread_id,
        workflow_version,
        decision,
        result_manifest_path,
        last_error_at,
        retry_after,
        created_page_ids,
        updated_page_ids,
        applied_type_names,
        proposed_type_names,
        skills_used
      ) VALUES (
        @file_id,
        'pending',
        @priority,
        @queued_at,
        NULL,
        NULL,
        NULL,
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
      )
      ON CONFLICT(file_id) DO UPDATE SET
        status = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.status
          ELSE 'pending'
        END,
        priority = excluded.priority,
        queued_at = excluded.queued_at,
        processed_at = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.processed_at
          ELSE NULL
        END,
        error_message = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.error_message
          ELSE NULL
        END,
        thread_id = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.thread_id
          ELSE NULL
        END,
        workflow_version = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.workflow_version
          ELSE NULL
        END,
        decision = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.decision
          ELSE NULL
        END,
        result_manifest_path = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.result_manifest_path
          ELSE NULL
        END,
        last_error_at = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.last_error_at
          ELSE NULL
        END,
        retry_after = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.retry_after
          ELSE NULL
        END,
        created_page_ids = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.created_page_ids
          ELSE NULL
        END,
        updated_page_ids = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.updated_page_ids
          ELSE NULL
        END,
        applied_type_names = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.applied_type_names
          ELSE NULL
        END,
        proposed_type_names = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.proposed_type_names
          ELSE NULL
        END,
        skills_used = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.skills_used
          ELSE NULL
        END
    `,
  );

  const transaction = db.transaction(() => {
    for (const file of currentFiles) {
      upsertStatement.run({
        id: file.id,
        file_name: file.fileName,
        file_ext: file.fileExt,
        source_type: file.sourceType,
        file_size: file.fileSize,
        file_path: file.filePath,
        content_hash: file.contentHash,
        file_mtime: file.fileMtime,
        indexed_at: file.indexedAt,
      });
    }

    for (const [id] of existing) {
      if (!current.has(id)) {
        deleteMissing.run(id);
        if (existingQueue.has(id)) {
          deleteQueue.run(id);
          queueStats.removed += 1;
        }
      }
    }

    for (const change of changes) {
      insertChange.run({
        file_id: change.fileId,
        action: change.action,
        detected_at: change.detectedAt,
        sync_id: change.syncId,
      });
      if (change.action === "added" || change.action === "modified") {
        const file = current.get(change.fileId);
        if (file) {
          const previousStatus = existingQueue.get(change.fileId);
          if (previousStatus) {
            if (previousStatus !== "processing") {
              queueStats.pendingReset += 1;
            }
          } else {
            queueStats.pendingAdded += 1;
          }
          upsertQueue.run({
            file_id: change.fileId,
            priority: getVaultQueuePriority(file.fileExt),
            queued_at: change.detectedAt,
          });
        }
      }
    }
  });

  transaction();

  return { files: currentFiles.length, changes, queue: queueStats };
}

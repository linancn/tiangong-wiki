import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

import { type SynologyClient, type SynologyListItem, normalizeSynologyRemotePath, withSynologyClient } from "./synology.js";
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

interface SynologyCacheMetadata {
  remotePath: string;
  fileSize: number;
  fileMtime: number | null;
}

export interface SynologyCacheStatus {
  kind: "not-applicable" | "fresh" | "stale" | "missing";
  localPath: string;
  metadataPath: string;
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

function normalizeVaultFileExtension(filePath: string): string | null {
  const fileExt = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return fileExt || null;
}

function createAllowedVaultFileTypeSet(vaultFileTypes: readonly string[]): Set<string> {
  return new Set(vaultFileTypes.map((item) => item.trim().replace(/^\./, "").toLowerCase()).filter(Boolean));
}

function isAllowedVaultFile(filePath: string, allowedFileTypes: Set<string>): boolean {
  const fileExt = normalizeVaultFileExtension(filePath);
  return fileExt !== null && allowedFileTypes.has(fileExt);
}

function localVaultFiles(vaultPath: string, hashMode: VaultHashMode, vaultFileTypes: readonly string[]): VaultFile[] {
  const indexedAt = toOffsetIso();
  const allowedFileTypes = createAllowedVaultFileTypeSet(vaultFileTypes);
  return listFilesRecursiveSync(vaultPath).filter((filePath) => isAllowedVaultFile(filePath, allowedFileTypes)).map((filePath) => {
    const stats = fileStatSync(filePath);
    const id = normalizeVaultId(vaultPath, filePath);
    const fileExt = normalizeVaultFileExtension(filePath);

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

function getSynologyCacheMetaPath(localPath: string): string {
  return `${localPath}.wiki-cache.json`;
}

export function getSynologyCacheLocalPath(vaultPath: string, file: Pick<VaultFile, "id" | "filePath">): string {
  return path.join(vaultPath, ...file.id.split("/"));
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

export function getSynologyCacheStatus(vaultPath: string, file: VaultFile, env: NodeJS.ProcessEnv = process.env): SynologyCacheStatus {
  const source = (env.VAULT_SOURCE ?? "local").trim().toLowerCase();
  const localPath = getSynologyCacheLocalPath(vaultPath, file);
  const metadataPath = getSynologyCacheMetaPath(localPath);

  if (source !== "synology") {
    return {
      kind: "not-applicable",
      localPath: file.filePath,
      metadataPath,
    };
  }

  if (isSynologyCacheFresh(localPath, file)) {
    return {
      kind: "fresh",
      localPath,
      metadataPath,
    };
  }

  if (pathExistsSync(localPath)) {
    return {
      kind: "stale",
      localPath,
      metadataPath,
    };
  }

  return {
    kind: "missing",
    localPath,
    metadataPath,
  };
}

function getSynologyItemPath(item: SynologyListItem): string | null {
  const candidate = item.path ?? item.real_path ?? item.additional?.real_path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function isSynologyDirectory(item: SynologyListItem): boolean {
  return item.isdir === true || item.type === "dir" || item.additional?.type === "dir";
}

async function scanSynologyFolder(
  client: SynologyClient,
  remoteRoot: string,
  currentFolder: string,
  results: VaultFile[],
  allowedFileTypes: Set<string>,
): Promise<void> {
  const indexedAt = toOffsetIso();
  const items = await client.listFolderAll(currentFolder);
  for (const item of items) {
    const filePath = getSynologyItemPath(item);
    if (!filePath) {
      continue;
    }

    if (isSynologyDirectory(item)) {
      await scanSynologyFolder(client, remoteRoot, filePath, results, allowedFileTypes);
      continue;
    }

    if (!isAllowedVaultFile(filePath, allowedFileTypes)) {
      continue;
    }

    const relativeId = path.posix.relative(remoteRoot, filePath).replace(/^\/+/, "");
    if (!relativeId || relativeId.startsWith("../")) {
      continue;
    }
    const fileExt = normalizeVaultFileExtension(filePath);
    const fileSize = Number(item.additional?.size ?? item.size ?? 0);
    const fileMtime = Number(item.additional?.time?.mtime ?? item.time?.mtime ?? 0);

    results.push({
      id: relativeId,
      fileName: item.name ?? path.basename(filePath),
      fileExt,
      sourceType: fileExt,
      fileSize,
      filePath,
      contentHash: sha256Text(`${relativeId}:${filePath}:${fileSize}:${fileMtime}`),
      fileMtime,
      indexedAt,
    });
  }
}

async function synologyVaultFiles(
  remoteRoot: string,
  vaultPath: string,
  env: NodeJS.ProcessEnv,
  hashMode: VaultHashMode,
  vaultFileTypes: readonly string[],
): Promise<VaultFile[]> {
  const results: VaultFile[] = [];
  const normalizedRoot = normalizeSynologyRemotePath(remoteRoot);
  const allowedFileTypes = createAllowedVaultFileTypeSet(vaultFileTypes);

  return withSynologyClient(env, async (client) => {
    await scanSynologyFolder(client, normalizedRoot, normalizedRoot, results, allowedFileTypes);
    const sorted = results.sort((left, right) => left.id.localeCompare(right.id));
    if (hashMode !== "content") {
      return sorted;
    }

    const hashed: VaultFile[] = [];
    for (const file of sorted) {
      const localPath = await ensureLocalVaultFile(file, vaultPath, env, client);
      hashed.push({
        ...file,
        contentHash: sha256FileSync(localPath),
      });
    }
    return hashed;
  });
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

export async function collectVaultFiles(
  vaultPath: string,
  vaultFileTypes: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<VaultFile[]> {
  const source = (env.VAULT_SOURCE ?? "local").trim().toLowerCase();
  const hashMode = ((env.VAULT_HASH_MODE ?? "content").trim().toLowerCase() === "mtime"
    ? "mtime"
    : "content") as VaultHashMode;
  if (source === "synology") {
    const remotePath = env.VAULT_SYNOLOGY_REMOTE_PATH;
    if (!remotePath) {
      throw new AppError("VAULT_SYNOLOGY_REMOTE_PATH is required when VAULT_SOURCE=synology", "config");
    }

    return synologyVaultFiles(remotePath, vaultPath, env, hashMode, vaultFileTypes);
  }

  return localVaultFiles(vaultPath, hashMode, vaultFileTypes);
}

export async function ensureLocalVaultFile(
  file: VaultFile,
  vaultPath: string,
  env: NodeJS.ProcessEnv = process.env,
  client?: SynologyClient,
): Promise<string> {
  const source = (env.VAULT_SOURCE ?? "local").trim().toLowerCase();
  if (source !== "synology") {
    return file.filePath;
  }

  const remoteRoot = env.VAULT_SYNOLOGY_REMOTE_PATH;
  if (!remoteRoot) {
    throw new AppError("VAULT_SYNOLOGY_REMOTE_PATH is required when VAULT_SOURCE=synology", "config");
  }

  const localPath = getSynologyCacheLocalPath(vaultPath, file);
  if (isSynologyCacheFresh(localPath, file)) {
    return localPath;
  }

  ensureDirSync(path.dirname(localPath));
  const remotePath = path.posix.join(normalizeSynologyRemotePath(remoteRoot), file.id);

  if (client) {
    await client.downloadFile(remotePath, localPath);
  } else {
    await withSynologyClient(env, async (synologyClient) => {
      await synologyClient.downloadFile(remotePath, localPath);
    });
  }
  writeSynologyCacheMetadata(localPath, file);
  return localPath;
}

const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".yaml", ".yml"]);
const ZIP_EXTS = new Set([".docx", ".pptx", ".xlsx"]);

function readTextDirect(filePath: string): string {
  try {
    const text = readFileSync(filePath, "utf8");
    return text.replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function printableRatio(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      count++;
    }
  }
  return count / Math.max(text.length, 1);
}

function tryPlainText(filePath: string): string {
  const text = readTextDirect(filePath);
  return printableRatio(text) >= 0.85 ? text : "";
}

function stripXmlText(xmlBuffer: Buffer): string {
  try {
    const xml = xmlBuffer.toString("utf8");
    const withoutPi = xml.replace(/<\?[^?]*\?>/g, "");
    const text = withoutPi.replace(/<[^>]+>/g, " ");
    return text.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function extractZipXml(filePath: string): string {
  try {
    const zip = new AdmZip(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const entries = zip.getEntries().sort((a, b) => a.entryName.localeCompare(b.entryName));
    const snippets: string[] = [];

    for (const entry of entries) {
      const name = entry.entryName.toLowerCase();
      if (ext === ".docx" && !name.startsWith("word/")) continue;
      if (ext === ".pptx" && !name.startsWith("ppt/slides/")) continue;
      if (ext === ".xlsx" && !(name.startsWith("xl/sharedstrings") || name.startsWith("xl/worksheets/"))) continue;
      if (!name.endsWith(".xml")) continue;

      const text = stripXmlText(entry.getData());
      if (text) snippets.push(text);
    }

    return snippets.join("\n").trim();
  } catch {
    return "";
  }
}

function extractPdfText(filePath: string): string {
  try {
    const result = execFileSync("/usr/bin/mdls", ["-raw", "-name", "kMDItemTextContent", filePath], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const text = (result || "").trim();
    if (text && text !== "(null)") return text;
  } catch { /* ignore */ }

  try {
    const result = execFileSync("/usr/bin/strings", ["-n", "6", filePath], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = result.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 400);
    if (lines.length) return lines.join("\n");
  } catch { /* ignore */ }

  return "";
}

export function extractVaultText(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  if (TEXT_EXTS.has(ext)) {
    return readTextDirect(filePath);
  }
  if (ZIP_EXTS.has(ext)) {
    const zipped = extractZipXml(filePath);
    return zipped || tryPlainText(filePath);
  }
  if (ext === ".pdf") {
    const pdfText = extractPdfText(filePath);
    return pdfText || tryPlainText(filePath);
  }

  return tryPlainText(filePath);
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
        claimed_at,
        started_at,
        heartbeat_at,
        processing_owner_id,
        processed_at,
        result_page_id,
        error_message,
        attempts,
        thread_id,
        workflow_version,
        decision,
        result_manifest_path,
        last_error_at,
        last_error_code,
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
        NULL,
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
        claimed_at = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.claimed_at
          ELSE NULL
        END,
        started_at = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.started_at
          ELSE NULL
        END,
        heartbeat_at = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.heartbeat_at
          ELSE NULL
        END,
        processing_owner_id = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.processing_owner_id
          ELSE NULL
        END,
        processed_at = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.processed_at
          ELSE NULL
        END,
        error_message = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.error_message
          ELSE NULL
        END,
        attempts = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.attempts
          ELSE 0
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
        last_error_code = CASE
          WHEN vault_processing_queue.status = 'processing' THEN vault_processing_queue.last_error_code
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

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import type { LoadedWikiConfig } from "../types/config.js";
import { AppError } from "../utils/errors.js";
import { segmentForFts } from "../utils/segmenter.js";

export const SCHEMA_VERSION = "1";
const FTS_INDEX_VERSION = "2";

export interface OpenDbResult {
  db: Database.Database;
  configChanged: boolean;
  vectorDimensions: number | null;
  vectorDimensionsChanged: boolean;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function getTableSql(db: Database.Database, tableName: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return row?.sql ?? null;
}

function getExistingTableColumns(db: Database.Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function ensureTableColumns(
  db: Database.Database,
  tableName: string,
  definitions: Record<string, string>,
): void {
  const existingColumns = getExistingTableColumns(db, tableName);
  for (const [columnName, definition] of Object.entries(definitions)) {
    if (!existingColumns.has(columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }
}

function createFtsTable(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title,
      tags,
      summary_text
    );
  `);
}

function normalizeTagsForFts(rawTags: string | null): string {
  if (!rawTags) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawTags) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => String(value).trim())
        .filter(Boolean)
        .join(" ");
    }
  } catch {
    // Fall back to the stored value if legacy data is not valid JSON.
  }

  return rawTags;
}

function buildFtsRow(row: {
  rowid: number;
  title: string;
  tags: string | null;
  summaryText: string | null;
}): { rowid: number; title: string; tags: string; summary_text: string } {
  return {
    rowid: row.rowid,
    title: segmentForFts(row.title),
    tags: segmentForFts(normalizeTagsForFts(row.tags)),
    summary_text: segmentForFts(row.summaryText ?? ""),
  };
}

function isLegacyExternalContentFts(db: Database.Database): boolean {
  const sql = getTableSql(db, "pages_fts");
  return typeof sql === "string" && /content\s*=\s*'pages'/i.test(sql);
}

function ensureBaseTables(db: Database.Database, embeddingDimensions: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      node_id TEXT UNIQUE,
      title TEXT NOT NULL,
      page_type TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      visibility TEXT DEFAULT 'private',
      tags TEXT,
      extra TEXT,
      file_path TEXT NOT NULL,
      content_hash TEXT,
      summary_text TEXT,
      embedding_status TEXT DEFAULT 'pending',
      file_mtime REAL,
      created_at TEXT,
      updated_at TEXT,
      indexed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(page_type);
    CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status);
    CREATE INDEX IF NOT EXISTS idx_pages_node ON pages(node_id);

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      source_page TEXT,
      metadata TEXT,
      UNIQUE(source, target, edge_type, source_page)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);

    CREATE TABLE IF NOT EXISTS vault_files (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_ext TEXT,
      source_type TEXT,
      file_size INTEGER,
      file_path TEXT NOT NULL,
      content_hash TEXT,
      file_mtime REAL,
      indexed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS vault_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      sync_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vchangelog_sync ON vault_changelog(sync_id);
    CREATE INDEX IF NOT EXISTS idx_vchangelog_time ON vault_changelog(detected_at);

    CREATE TABLE IF NOT EXISTS vault_processing_queue (
      file_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      queued_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      processed_at TEXT,
      result_page_id TEXT,
      error_message TEXT,
      attempts INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_vpq_status ON vault_processing_queue(status);
    CREATE INDEX IF NOT EXISTS idx_vpq_priority ON vault_processing_queue(priority DESC, queued_at ASC);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS daemon_write_jobs (
      job_id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      timeout_ms INTEGER NOT NULL,
      queue_depth_at_enqueue INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      error_message TEXT,
      error_details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_daemon_write_jobs_status ON daemon_write_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_daemon_write_jobs_enqueued_at ON daemon_write_jobs(enqueued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_daemon_write_jobs_finished_at ON daemon_write_jobs(finished_at DESC);
  `);

  ensureTableColumns(db, "vault_processing_queue", {
    claimed_at: "TEXT",
    started_at: "TEXT",
    thread_id: "TEXT",
    workflow_version: "TEXT",
    decision: "TEXT",
    result_manifest_path: "TEXT",
    last_error_at: "TEXT",
    retry_after: "TEXT",
    created_page_ids: "TEXT",
    updated_page_ids: "TEXT",
    applied_type_names: "TEXT",
    proposed_type_names: "TEXT",
    skills_used: "TEXT",
  });

  if (!tableExists(db, "vec_pages")) {
    db.exec(`
      CREATE VIRTUAL TABLE vec_pages USING vec0(
        page_rowid INTEGER PRIMARY KEY,
        page_id TEXT,
        embedding float[${embeddingDimensions}]
      );
    `);
  }
}

function getExistingColumns(db: Database.Database): Set<string> {
  return getExistingTableColumns(db, "pages");
}

function ensureDynamicColumns(db: Database.Database, config: LoadedWikiConfig): void {
  const existingColumns = getExistingColumns(db);
  for (const [columnName, columnType] of Object.entries(config.allColumnDefinitions)) {
    if (!existingColumns.has(columnName)) {
      db.exec(`ALTER TABLE pages ADD COLUMN ${columnName} ${columnType.toUpperCase()}`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pages_${columnName} ON pages(${columnName})`);
    }
  }
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function getVectorTableDimensions(db: Database.Database): number | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_pages'").get() as
    | { sql: string | null }
    | undefined;
  const sql = row?.sql ?? "";
  const match = sql.match(/embedding\s+float\[(\d+)\]/i);
  if (!match) {
    return null;
  }

  const dimensions = Number.parseInt(match[1], 10);
  return Number.isFinite(dimensions) && dimensions > 0 ? dimensions : null;
}

export function setMeta(db: Database.Database, key: string, value: string | null): void {
  if (value === null) {
    db.prepare("DELETE FROM sync_meta WHERE key = ?").run(key);
    return;
  }

  db.prepare(
    `
      INSERT INTO sync_meta(key, value)
      VALUES(@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  ).run({ key, value });
}

export function setMetaValues(db: Database.Database, values: Record<string, string | null>): void {
  const transaction = db.transaction((payload: Record<string, string | null>) => {
    for (const [key, value] of Object.entries(payload)) {
      setMeta(db, key, value);
    }
  });

  transaction(values);
}

export function rebuildFts(db: Database.Database): void {
  if (!tableExists(db, "pages_fts")) {
    return;
  }

  const rows = db.prepare(
    "SELECT rowid, title, tags, summary_text AS summaryText FROM pages ORDER BY rowid",
  ).all() as Array<{
    rowid: number;
    title: string;
    tags: string | null;
    summaryText: string | null;
  }>;
  const clearStatement = db.prepare("DELETE FROM pages_fts");
  const insertStatement = db.prepare(
    "INSERT INTO pages_fts(rowid, title, tags, summary_text) VALUES (@rowid, @title, @tags, @summary_text)",
  );

  const transaction = db.transaction(() => {
    clearStatement.run();
    for (const row of rows) {
      insertStatement.run(buildFtsRow(row));
    }
  });

  transaction();
}

function ensureFtsTable(db: Database.Database): void {
  const hasTable = tableExists(db, "pages_fts");
  const storedFtsIndexVersion = getMeta(db, "fts_index_version");
  const needsRecreate = !hasTable || isLegacyExternalContentFts(db);
  const needsRebuild = needsRecreate || storedFtsIndexVersion !== FTS_INDEX_VERSION;

  if (needsRecreate && hasTable) {
    db.exec("DROP TABLE pages_fts");
  }
  if (needsRecreate) {
    createFtsTable(db);
  }
  if (needsRebuild) {
    rebuildFts(db);
  }
  if (needsRebuild || storedFtsIndexVersion !== FTS_INDEX_VERSION) {
    setMeta(db, "fts_index_version", FTS_INDEX_VERSION);
  }
}

export function resetVectorTable(db: Database.Database, embeddingDimensions: number): void {
  db.exec("DROP TABLE IF EXISTS vec_pages");
  db.exec(`
    CREATE VIRTUAL TABLE vec_pages USING vec0(
      page_rowid INTEGER PRIMARY KEY,
      page_id TEXT,
      embedding float[${embeddingDimensions}]
    );
  `);
}

export function clearAllIndexedData(db: Database.Database): void {
  db.exec(`
    DELETE FROM edges;
    DELETE FROM pages;
    DELETE FROM vault_files;
    DELETE FROM vault_changelog;
    DELETE FROM vault_processing_queue;
  `);
  if (tableExists(db, "vec_pages")) {
    db.exec("DELETE FROM vec_pages");
  }
  if (tableExists(db, "pages_fts")) {
    rebuildFts(db);
  }
  db.prepare(
    "DELETE FROM sync_meta WHERE key IN ('last_sync_at', 'last_sync_id', 'last_full_rebuild_at', 'embedding_profile')",
  ).run();
}

export function openDb(
  dbPath: string,
  config: LoadedWikiConfig,
  embeddingDimensions: number,
): OpenDbResult {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);

  ensureBaseTables(db, embeddingDimensions);
  ensureFtsTable(db);
  const vectorDimensions = getVectorTableDimensions(db);
  const vectorDimensionsChanged = vectorDimensions !== null && vectorDimensions !== embeddingDimensions;

  const storedSchemaVersion = getMeta(db, "schema_version");
  if (storedSchemaVersion && storedSchemaVersion !== SCHEMA_VERSION) {
    db.close();
    throw new AppError(
      `Schema version mismatch: expected ${SCHEMA_VERSION}, found ${storedSchemaVersion}. Run tiangong-wiki init --force.`,
      "config",
    );
  }

  ensureDynamicColumns(db, config);
  const storedConfigVersion = getMeta(db, "config_version");
  const configChanged = Boolean(storedConfigVersion && storedConfigVersion !== config.configVersion);

  setMetaValues(db, {
    schema_version: SCHEMA_VERSION,
    ...(storedConfigVersion === null ? { config_version: config.configVersion } : {}),
  });

  return { db, configChanged, vectorDimensions, vectorDimensionsChanged };
}

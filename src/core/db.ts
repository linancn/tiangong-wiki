import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import type { LoadedWikiConfig } from "../types/config.js";
import { AppError } from "../utils/errors.js";

export const SCHEMA_VERSION = "1";

export interface OpenDbResult {
  db: Database.Database;
  configChanged: boolean;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
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
  `);

  ensureTableColumns(db, "vault_processing_queue", {
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

  if (!tableExists(db, "pages_fts")) {
    db.exec(`
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title,
        tags,
        summary_text,
        content='pages',
        content_rowid='rowid'
      );
    `);
  }

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
  db.prepare("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')").run();
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

  const storedSchemaVersion = getMeta(db, "schema_version");
  if (storedSchemaVersion && storedSchemaVersion !== SCHEMA_VERSION) {
    db.close();
    throw new AppError(
      `Schema version mismatch: expected ${SCHEMA_VERSION}, found ${storedSchemaVersion}. Run wiki init --force.`,
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

  return { db, configChanged };
}

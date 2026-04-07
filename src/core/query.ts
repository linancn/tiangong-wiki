import type Database from "better-sqlite3";

import type { LoadedWikiConfig } from "../types/config.js";
import { snakeToCamel } from "../utils/case.js";

type RawPageRow = Record<string, unknown>;

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }

  return JSON.parse(value) as T;
}

export function mapPageRow(row: RawPageRow, config: LoadedWikiConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: row.id,
    nodeId: row.node_id,
    title: row.title,
    pageType: row.page_type,
    status: row.status,
    visibility: row.visibility,
    tags: parseJsonField<string[]>(row.tags, []),
    extra: parseJsonField<Record<string, unknown>>(row.extra, {}),
    filePath: row.file_path,
    contentHash: row.content_hash,
    summaryText: row.summary_text,
    embeddingStatus: row.embedding_status,
    fileMtime: row.file_mtime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    indexedAt: row.indexed_at,
  };

  for (const columnName of config.allColumnNames) {
    result[snakeToCamel(columnName)] = row[columnName];
  }

  return result;
}

export function listPageColumns(config: LoadedWikiConfig): string[] {
  return [
    "id",
    "node_id",
    "title",
    "page_type",
    "status",
    "visibility",
    "tags",
    ...config.allColumnNames,
    "extra",
    "file_path",
    "content_hash",
    "summary_text",
    "embedding_status",
    "file_mtime",
    "created_at",
    "updated_at",
    "indexed_at",
  ];
}

export function selectPageById(
  db: Database.Database,
  config: LoadedWikiConfig,
  pageId: string,
): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT ${listPageColumns(config).join(", ")} FROM pages WHERE id = ?`)
    .get(pageId) as RawPageRow | undefined;

  return row ? mapPageRow(row, config) : null;
}

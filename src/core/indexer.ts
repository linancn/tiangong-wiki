import type Database from "better-sqlite3";

import type { LoadedWikiConfig } from "../types/config.js";
import type {
  ApplyChangesResult,
  ParsedPage,
  ScanEntry,
  ScanResult,
} from "../types/page.js";
import { normalizeDateField, parsePage } from "./frontmatter.js";
import { rebuildFts } from "./db.js";
import { normalizePageId, resolvePagePath } from "./paths.js";
import { fileStatSync, listFilesRecursiveSync, pathExistsSync, sha256FileSync } from "../utils/fs.js";
import { toDateOnly, toOffsetIso } from "../utils/time.js";

function getExistingPages(db: Database.Database): Map<string, { filePath: string; contentHash: string | null }> {
  const rows = db
    .prepare("SELECT id, file_path AS filePath, content_hash AS contentHash FROM pages")
    .all() as Array<{
    id: string;
    filePath: string;
    contentHash: string | null;
  }>;

  return new Map(rows.map((row) => [row.id, { filePath: row.filePath, contentHash: row.contentHash }]));
}

function makeScanEntry(filePath: string, wikiPath: string): ScanEntry {
  return {
    id: normalizePageId(filePath, wikiPath),
    filePath,
    contentHash: sha256FileSync(filePath),
    fileMtime: Number(new Date().getTime()),
  };
}

function createScanEntry(filePath: string, wikiPath: string): ScanEntry {
  const entry = makeScanEntry(filePath, wikiPath);
  const stats = fileStatSync(filePath);
  return { ...entry, fileMtime: stats.mtimeMs };
}

export function scanPages(
  db: Database.Database,
  wikiPath: string,
  configChanged: boolean,
  force = false,
): ScanResult {
  const existing = getExistingPages(db);
  const currentEntries = listFilesRecursiveSync(wikiPath, ".md").map((filePath) => createScanEntry(filePath, wikiPath));
  const seenIds = new Set<string>();

  const added: ScanEntry[] = [];
  const modified: ScanEntry[] = [];
  const unchanged: ScanEntry[] = [];

  for (const entry of currentEntries) {
    seenIds.add(entry.id);
    const existingEntry = existing.get(entry.id);
    if (!existingEntry) {
      added.push(entry);
      continue;
    }

    if (force || configChanged || existingEntry.contentHash !== entry.contentHash) {
      modified.push(entry);
      continue;
    }

    unchanged.push(entry);
  }

  const deleted = [...existing.entries()]
    .filter(([pageId]) => !seenIds.has(pageId))
    .map(([id, value]) => ({ id, filePath: value.filePath }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { added, modified, deleted, unchanged };
}

export function scanSpecificPages(
  db: Database.Database,
  wikiPath: string,
  pageIdsOrPaths: string[],
  configChanged: boolean,
  force = false,
): ScanResult {
  const existing = getExistingPages(db);
  const requestedIds = [...new Set(pageIdsOrPaths.map((value) => normalizePageId(value, wikiPath)))];
  const added: ScanEntry[] = [];
  const modified: ScanEntry[] = [];
  const unchanged: ScanEntry[] = [];
  const deleted: Array<{ id: string; filePath: string }> = [];

  for (const pageId of requestedIds) {
    const filePath = resolvePagePath(pageId, wikiPath);
    const existingEntry = existing.get(pageId);

    if (!pathExistsSync(filePath)) {
      if (existingEntry) {
        deleted.push({ id: pageId, filePath: existingEntry.filePath });
      }
      continue;
    }

    const entry = createScanEntry(filePath, wikiPath);
    if (!existingEntry) {
      added.push(entry);
      continue;
    }

    if (force || configChanged || existingEntry.contentHash !== entry.contentHash) {
      modified.push(entry);
      continue;
    }

    unchanged.push(entry);
  }

  return { added, modified, deleted, unchanged };
}

function serializeRow(
  parsed: ParsedPage,
  entry: ScanEntry,
  config: LoadedWikiConfig,
  previousEmbeddingStatus: string | null,
  summaryChanged: boolean,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: parsed.page.id,
    node_id: parsed.page.nodeId,
    title: parsed.page.title,
    page_type: parsed.page.pageType,
    status: parsed.page.status,
    visibility: parsed.page.visibility,
    tags: JSON.stringify(parsed.page.tags),
    extra: JSON.stringify(parsed.page.extra),
    file_path: parsed.page.filePath,
    content_hash: entry.contentHash,
    summary_text: parsed.summaryText,
    embedding_status: summaryChanged || !previousEmbeddingStatus ? "pending" : previousEmbeddingStatus,
    file_mtime: entry.fileMtime,
    created_at: parsed.page.createdAt,
    updated_at: parsed.page.updatedAt,
    indexed_at: toOffsetIso(),
  };

  for (const columnName of config.allColumnNames) {
    row[columnName] = parsed.columnValues[columnName] ?? null;
  }

  return row;
}

function buildInsertStatement(config: LoadedWikiConfig): string {
  const columns = [
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

  const placeholders = columns.map((column) => `@${column}`);
  return `INSERT INTO pages (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;
}

function buildUpdateStatement(config: LoadedWikiConfig): string {
  const columns = [
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

  return `UPDATE pages SET ${columns.map((column) => `${column} = @${column}`).join(", ")} WHERE id = @id`;
}

export function applyChanges(
  db: Database.Database,
  changes: ScanResult,
  wikiPath: string,
  config: LoadedWikiConfig,
  ftsExtensionVersion: string | null,
): ApplyChangesResult {
  const parseResults = [...changes.added, ...changes.modified].map((entry) => ({
    entry,
    result: parsePage(entry.filePath, wikiPath, config),
  }));
  const parseErrors = parseResults
    .filter((item) => !item.result.ok)
    .map((item) => (item.result.ok ? null : item.result.error))
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (parseErrors.length > 0) {
    return {
      inserted: [],
      updated: [],
      deleted: [],
      summaryChangedIds: [],
      parseErrors,
    };
  }

  const parsedEntries = parseResults.map((item) => ({
    entry: item.entry,
    parsed: (item.result as { ok: true; parsed: ParsedPage }).parsed,
  }));

  const insertStatement = db.prepare(buildInsertStatement(config));
  const updateStatement = db.prepare(buildUpdateStatement(config));
  const selectExistingPage = db.prepare(
    "SELECT rowid, summary_text AS summaryText, embedding_status AS embeddingStatus, created_at AS createdAt FROM pages WHERE id = ?",
  );
  const deleteEdgesBySourcePage = db.prepare("DELETE FROM edges WHERE source_page = ?");
  const insertEdge = db.prepare(
    `
      INSERT OR REPLACE INTO edges(source, target, edge_type, source_page, metadata)
      VALUES(@source, @target, @edge_type, @source_page, @metadata)
    `,
  );
  const deletePage = db.prepare("DELETE FROM pages WHERE id = ?");
  const deleteVecRow = db.prepare("DELETE FROM vec_pages WHERE page_rowid = ?");
  const selectPageRowid = db.prepare("SELECT rowid FROM pages WHERE id = ?");

  const inserted: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const summaryChangedIds: string[] = [];
  const hasContentChanges = parsedEntries.length > 0 || changes.deleted.length > 0;

  const transaction = db.transaction(() => {
    for (const { entry, parsed } of parsedEntries) {
      const existing = selectExistingPage.get(entry.id) as
        | { rowid: number; summaryText: string | null; embeddingStatus: string | null; createdAt: string | null }
        | undefined;
      const isInsert = !existing;
      const summaryChanged = isInsert || existing.summaryText !== parsed.summaryText;
      const today = toDateOnly();
      parsed.page.createdAt =
        normalizeDateField(parsed.rawData.createdAt) ?? existing?.createdAt ?? today;
      parsed.page.updatedAt = isInsert
        ? normalizeDateField(parsed.rawData.updatedAt) ?? today
        : today;
      const row = serializeRow(
        parsed,
        entry,
        config,
        existing?.embeddingStatus ?? null,
        summaryChanged,
      );

      if (isInsert) {
        insertStatement.run(row);
        inserted.push(entry.id);
      } else {
        updateStatement.run(row);
        updated.push(entry.id);
      }

      if (summaryChanged) {
        summaryChangedIds.push(entry.id);
      }

      deleteEdgesBySourcePage.run(entry.id);
      for (const edge of parsed.edges) {
        insertEdge.run({
          source: edge.source,
          target: edge.target,
          edge_type: edge.edgeType,
          source_page: edge.sourcePage,
          metadata: JSON.stringify(edge.metadata),
        });
      }
    }

    for (const page of changes.deleted) {
      const existing = selectPageRowid.get(page.id) as { rowid: number } | undefined;
      deleteEdgesBySourcePage.run(page.id);
      if (existing) {
        deleteVecRow.run(BigInt(existing.rowid));
      }
      deletePage.run(page.id);
      deleted.push(page.id);
    }

    if (hasContentChanges) {
      rebuildFts(db, config, ftsExtensionVersion);
    }
  });

  transaction();

  return {
    inserted,
    updated,
    deleted,
    summaryChangedIds,
    parseErrors: [],
  };
}

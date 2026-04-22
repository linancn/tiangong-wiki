import type Database from "better-sqlite3";

import type { FtsTokenizerMode } from "../types/config.js";
import { normalizeFtsQuery, segmentForFts } from "../utils/segmenter.js";

export const FTS_INDEX_VERSION = "3";

export interface FtsRowInput {
  rowid: number;
  title: string;
  tags: string | null;
  summaryText: string | null;
}

export interface FtsQueryPlan {
  whereClause: string;
  params: unknown[];
}

export interface FtsRuntimeState {
  mode: FtsTokenizerMode;
  extensionVersion: string | null;
  simpleExtensionPath: string | null;
}

export interface FtsInspectionResult {
  mode: FtsTokenizerMode;
  hasTable: boolean;
  rowCount: number;
  expectedIndexVersion: string;
  storedIndexVersion: string | null;
  storedTokenizerMode: string | null;
  storedExtensionVersion: string | null;
  lastRebuildAt: string | null;
  needsRecreate: boolean;
  needsRebuild: boolean;
  problems: string[];
}

export function createFtsTable(db: Database.Database, mode: FtsTokenizerMode): void {
  db.exec(`
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title,
      tags,
      summary_text
      ${mode === "simple" ? ", tokenize = 'simple'" : ""}
    );
  `);
}

export function normalizeTagsForFts(rawTags: string | null): string {
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

export function buildFtsRow(row: FtsRowInput, mode: FtsTokenizerMode): {
  rowid: number;
  title: string;
  tags: string;
  summary_text: string;
} {
  const tags = normalizeTagsForFts(row.tags);
  if (mode === "simple") {
    return {
      rowid: row.rowid,
      title: row.title,
      tags,
      summary_text: row.summaryText ?? "",
    };
  }

  return {
    rowid: row.rowid,
    title: segmentForFts(row.title),
    tags: segmentForFts(tags),
    summary_text: segmentForFts(row.summaryText ?? ""),
  };
}

export function buildFtsQueryPlan(query: string, mode: FtsTokenizerMode): FtsQueryPlan {
  if (mode === "simple") {
    return {
      whereClause: "pages_fts MATCH simple_query(?)",
      params: [query.trim()],
    };
  }

  return {
    whereClause: "pages_fts MATCH ?",
    params: [normalizeFtsQuery(query)],
  };
}

export function isLegacyExternalContentFts(sql: string | null): boolean {
  return typeof sql === "string" && /content\s*=\s*'pages'/i.test(sql);
}

export function isSimpleTokenizerSql(sql: string | null): boolean {
  return typeof sql === "string" && /tokenize\s*=\s*'simple'/i.test(sql);
}

export function ftsTableMatchesMode(sql: string | null, mode: FtsTokenizerMode): boolean {
  return mode === "simple" ? isSimpleTokenizerSql(sql) : !isSimpleTokenizerSql(sql);
}

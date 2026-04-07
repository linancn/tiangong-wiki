import matter from "gray-matter";
import path from "node:path";

import type { LoadedWikiConfig } from "../types/config.js";
import type { Edge, Page, ParsePageResult, ParsedPage } from "../types/page.js";
import { getTemplate } from "./config.js";
import { normalizePageId } from "./paths.js";
import { camelToSnake, humanizeFieldName } from "../utils/case.js";

const FIXED_FIELDS = new Set([
  "pageType",
  "title",
  "nodeId",
  "status",
  "visibility",
  "tags",
  "createdAt",
  "updatedAt",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeStringArray(value: unknown): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => (item === null || item === undefined ? "" : String(item).trim()))
      .filter(Boolean);
  }

  return [String(value).trim()].filter(Boolean);
}

function normalizeScalar(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeScalar(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeScalar(item)]));
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

function normalizeColumnValue(value: unknown): unknown {
  const normalized = normalizeScalar(value);
  if (typeof normalized === "boolean") {
    return normalized ? 1 : 0;
  }
  if (Array.isArray(normalized) || isPlainObject(normalized)) {
    return JSON.stringify(normalized);
  }
  return normalized;
}

function normalizeDateField(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

function normalizeReference(value: string, resolve: "nodeId" | "path"): string {
  const trimmed = value.trim();
  if (resolve === "nodeId") {
    return trimmed;
  }

  return trimmed
    .replace(/^\.?\//, "")
    .replace(/^pages\//, "")
    .split(path.sep)
    .join("/");
}

function extractFirstParagraph(body: string): string {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n\r?\n/)
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk && !chunk.startsWith("#"));

  if (!cleaned) {
    return "";
  }

  return cleaned.replace(/\s+/g, " ").slice(0, 200);
}

function valueToSummaryLine(fieldName: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (Array.isArray(value) && value.length === 0) {
    return null;
  }

  const label = humanizeFieldName(fieldName);
  const content = Array.isArray(value)
    ? value.map((item) => String(item)).join(", ")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

  return `${label}: ${content}`;
}

function buildSummaryText(
  pageType: string,
  title: string,
  tags: string[],
  data: Record<string, unknown>,
  config: LoadedWikiConfig,
  templateFields: string[],
  body: string,
): string {
  const lines: string[] = [`[${pageType}] ${title}`];

  if (tags.length > 0) {
    lines.push(`标签: ${tags.join(", ")}`);
  }

  for (const field of Object.keys(config.customColumns)) {
    const line = valueToSummaryLine(field, data[field]);
    if (line) {
      lines.push(line);
    }
  }

  const seen = new Set(["title", "tags"]);
  for (const field of [...config.defaultSummaryFields, ...templateFields]) {
    if (seen.has(field)) {
      continue;
    }
    seen.add(field);
    const line = valueToSummaryLine(field, data[field]);
    if (line) {
      lines.push(line);
    }
  }

  const bodyPreview = extractFirstParagraph(body);
  if (bodyPreview) {
    lines.push("---", bodyPreview);
  }

  return lines.join("\n");
}

function buildEdges(
  page: Page,
  data: Record<string, unknown>,
  config: LoadedWikiConfig,
  pageType: string,
): Edge[] {
  const template = getTemplate(config, pageType);
  const source = page.nodeId ?? page.id;
  const rules = [
    ...Object.entries(config.commonEdges),
    ...Object.entries(template.edges),
  ];

  const edges: Edge[] = [];

  for (const [field, rule] of rules) {
    const rawValues = normalizeStringArray(data[field]);
    const matcher = rule.match ? new RegExp(rule.match) : null;

    for (const value of rawValues) {
      if (matcher && !matcher.test(value)) {
        continue;
      }

      const target = normalizeReference(value, rule.resolve);
      if (!target) {
        continue;
      }
      if (rule.resolve === "path" && target.startsWith("vault/")) {
        continue;
      }

      edges.push({
        source,
        target,
        edgeType: rule.edgeType,
        sourcePage: page.id,
        metadata: { field },
      });
    }
  }

  return edges;
}

function buildExtraAndColumns(
  data: Record<string, unknown>,
  config: LoadedWikiConfig,
  pageType: string,
): {
  columnValues: Record<string, unknown>;
  extra: Record<string, unknown>;
  unregisteredFields: string[];
} {
  const template = getTemplate(config, pageType);
  const columnValues: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  const registeredFields = new Set<string>([
    ...FIXED_FIELDS,
    ...Object.keys(config.customColumns),
    ...Object.keys(template.columns),
    ...Object.keys(config.commonEdges),
    ...Object.keys(template.edges),
  ]);

  for (const [field, value] of Object.entries(data)) {
    if (config.customColumns[field] || template.columns[field]) {
      columnValues[camelToSnake(field)] = normalizeColumnValue(value);
      continue;
    }

    if (FIXED_FIELDS.has(field)) {
      continue;
    }

    extra[field] = normalizeScalar(value);
  }

  const unregisteredFields = Object.keys(data)
    .filter((field) => !registeredFields.has(field))
    .sort();

  return { columnValues, extra, unregisteredFields };
}

export function parsePage(filePath: string, wikiPath: string, config: LoadedWikiConfig): ParsePageResult {
  const pageId = normalizePageId(filePath, wikiPath);
  let parsedMatter: matter.GrayMatterFile<string>;

  try {
    parsedMatter = matter.read(filePath);
  } catch (error) {
    return {
      ok: false,
      error: {
        filePath,
        code: "yaml_parse_error",
        message: `Failed to parse frontmatter for ${pageId}`,
        details: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (!isPlainObject(parsedMatter.data)) {
    return {
      ok: false,
      error: {
        filePath,
        code: "invalid_frontmatter",
        message: `Frontmatter must be a YAML object for ${pageId}`,
      },
    };
  }

  const data = parsedMatter.data;
  const pageType = typeof data.pageType === "string" ? data.pageType.trim() : "";
  const title = typeof data.title === "string" ? data.title.trim() : "";

  if (!pageType) {
    return {
      ok: false,
      error: {
        filePath,
        code: "missing_page_type",
        message: `Missing pageType in ${pageId}`,
      },
    };
  }

  if (!config.templates[pageType]) {
    return {
      ok: false,
      error: {
        filePath,
        code: "unknown_page_type",
        message: `Unknown pageType "${pageType}" in ${pageId}`,
      },
    };
  }

  if (!title) {
    return {
      ok: false,
      error: {
        filePath,
        code: "missing_title",
        message: `Missing title in ${pageId}`,
      },
    };
  }

  const tags = normalizeStringArray(data.tags);
  const { columnValues, extra, unregisteredFields } = buildExtraAndColumns(data, config, pageType);
  const page: Page = {
    id: pageId,
    nodeId: typeof data.nodeId === "string" && data.nodeId.trim() ? data.nodeId.trim() : null,
    title,
    pageType,
    status: typeof data.status === "string" && data.status.trim() ? data.status.trim() : "draft",
    visibility:
      typeof data.visibility === "string" && data.visibility.trim() ? data.visibility.trim() : "private",
    tags,
    extra,
    filePath: path.resolve(filePath),
    contentHash: null,
    summaryText: "",
    embeddingStatus: "pending",
    fileMtime: null,
    createdAt: normalizeDateField(data.createdAt),
    updatedAt: normalizeDateField(data.updatedAt),
    indexedAt: null,
  };

  const template = getTemplate(config, pageType);
  const summaryText = buildSummaryText(pageType, title, tags, data, config, template.summaryFields, parsedMatter.content);
  page.summaryText = summaryText;
  const edges = buildEdges(page, data, config, pageType);

  const parsed: ParsedPage = {
    page,
    columnValues,
    edges,
    summaryText,
    body: parsedMatter.content,
    rawData: data,
    unregisteredFields,
  };

  return { ok: true, parsed };
}

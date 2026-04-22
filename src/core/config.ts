import path from "node:path";

import { AppError, assertCondition } from "../utils/errors.js";
import { camelToSnake } from "../utils/case.js";
import { pathExistsSync, readTextFileSync, sha256Text } from "../utils/fs.js";
import type {
  EdgeRule,
  FtsTokenizerMode,
  LoadedWikiConfig,
  SqliteColumnType,
  TemplateConfig,
  WikiConfig,
} from "../types/config.js";

const ALLOWED_SQLITE_TYPES = new Set<SqliteColumnType>(["text", "integer", "real", "numeric", "blob"]);
export const DEFAULT_VAULT_FILE_TYPES = ["md", "txt", "pdf", "docx", "pptx", "xlsx", "csv", "json", "yaml", "yml"] as const;

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(`${label} must be an object`, "config");
  }

  return value as Record<string, unknown>;
}

function ensureStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AppError(`${label} must be a string array`, "config");
  }

  return value;
}

function ensureFtsTokenizerMode(value: unknown, label: string): FtsTokenizerMode {
  if (value === undefined) {
    return "default";
  }

  if (value === "default" || value === "simple") {
    return value;
  }

  throw new AppError(`${label} must be "default" or "simple"`, "config");
}

function ensureVaultFileTypes(value: unknown, label: string): string[] {
  const normalized = ensureStringArray(value, label).map((item, index) => {
    const fileType = item.trim().replace(/^\./, "").toLowerCase();
    if (!fileType) {
      throw new AppError(`${label}[${index}] must not be empty`, "config");
    }
    return fileType;
  });

  return [...new Set(normalized)];
}

function ensureColumnMap(value: unknown, label: string): Record<string, SqliteColumnType> {
  const objectValue = ensureObject(value, label);
  const entries = Object.entries(objectValue).map(([key, rawType]) => {
    if (typeof rawType !== "string" || !ALLOWED_SQLITE_TYPES.has(rawType as SqliteColumnType)) {
      throw new AppError(`${label}.${key} must be a valid SQLite column type`, "config");
    }

    return [key, rawType as SqliteColumnType] as const;
  });

  return Object.fromEntries(entries);
}

function ensureEdgeRule(value: unknown, label: string): EdgeRule {
  const objectValue = ensureObject(value, label);
  assertCondition(typeof objectValue.edgeType === "string" && objectValue.edgeType, `${label}.edgeType is required`, "config");
  assertCondition(
    objectValue.resolve === "nodeId" || objectValue.resolve === "path",
    `${label}.resolve must be "nodeId" or "path"`,
    "config",
  );

  if (objectValue.match !== undefined && typeof objectValue.match !== "string") {
    throw new AppError(`${label}.match must be a string when provided`, "config");
  }

  return {
    edgeType: objectValue.edgeType,
    resolve: objectValue.resolve,
    ...(objectValue.match ? { match: objectValue.match } : {}),
  };
}

function ensureEdgeMap(value: unknown, label: string): Record<string, EdgeRule> {
  const objectValue = ensureObject(value, label);
  return Object.fromEntries(
    Object.entries(objectValue).map(([field, rule]) => [field, ensureEdgeRule(rule, `${label}.${field}`)]),
  );
}

function ensureTemplateConfig(value: unknown, label: string): TemplateConfig {
  const objectValue = ensureObject(value, label);
  assertCondition(typeof objectValue.file === "string" && objectValue.file, `${label}.file is required`, "config");

  return {
    file: objectValue.file,
    columns: ensureColumnMap(objectValue.columns ?? {}, `${label}.columns`),
    edges: ensureEdgeMap(objectValue.edges ?? {}, `${label}.edges`),
    summaryFields: ensureStringArray(objectValue.summaryFields ?? [], `${label}.summaryFields`),
  };
}

export function loadConfig(configPath: string): LoadedWikiConfig {
  if (!pathExistsSync(configPath)) {
    throw new AppError(`Config file not found: ${configPath}`, "config");
  }

  let parsedJson: unknown;
  const rawContent = readTextFileSync(configPath);
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (error) {
    throw new AppError(`Failed to parse config JSON: ${configPath}`, "config", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const raw = ensureObject(parsedJson, "wiki.config.json");
  assertCondition(Number.isInteger(raw.schemaVersion), "schemaVersion must be an integer", "config");

  const baseConfig: WikiConfig = {
    schemaVersion: Number(raw.schemaVersion),
    fts: {
      tokenizer: ensureFtsTokenizerMode(
        ensureObject(raw.fts ?? {}, "fts").tokenizer,
        "fts.tokenizer",
      ),
    },
    customColumns: ensureColumnMap(raw.customColumns ?? {}, "customColumns"),
    defaultSummaryFields: ensureStringArray(raw.defaultSummaryFields ?? [], "defaultSummaryFields"),
    vaultFileTypes: ensureVaultFileTypes(raw.vaultFileTypes ?? DEFAULT_VAULT_FILE_TYPES, "vaultFileTypes"),
    commonEdges: ensureEdgeMap(raw.commonEdges ?? {}, "commonEdges"),
    templates: Object.fromEntries(
      Object.entries(ensureObject(raw.templates, "templates")).map(([pageType, template]) => [
        pageType,
        ensureTemplateConfig(template, `templates.${pageType}`),
      ]),
    ),
  };

  assertCondition(Object.keys(baseConfig.templates).length > 0, "templates must not be empty", "config");

  const allColumnDefinitions: Record<string, SqliteColumnType> = {};

  for (const [field, type] of Object.entries(baseConfig.customColumns)) {
    allColumnDefinitions[camelToSnake(field)] = type;
  }

  for (const [pageType, template] of Object.entries(baseConfig.templates)) {
    assertCondition(template.file.endsWith(".md"), `templates.${pageType}.file must point to a .md file`, "config");

    for (const [field, type] of Object.entries(template.columns)) {
      const columnName = camelToSnake(field);
      if (allColumnDefinitions[columnName] && allColumnDefinitions[columnName] !== type) {
        throw new AppError(`Column ${field} is declared with conflicting types`, "config");
      }
      allColumnDefinitions[columnName] = type;
    }
  }

  return {
    ...baseConfig,
    configPath: path.resolve(configPath),
    configVersion: sha256Text(rawContent),
    allColumnDefinitions,
    allColumnNames: Object.keys(allColumnDefinitions).sort(),
  };
}

export function getTemplate(config: LoadedWikiConfig, pageType: string): TemplateConfig {
  const template = config.templates[pageType];
  if (!template) {
    throw new AppError(`Unknown pageType: ${pageType}`, "config");
  }
  return template;
}

export function resolveTemplateFilePath(config: LoadedWikiConfig, wikiRoot: string, pageType: string): string {
  const template = getTemplate(config, pageType);
  return path.resolve(wikiRoot, template.file);
}

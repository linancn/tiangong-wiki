import matter from "gray-matter";
import path from "node:path";

import { getTemplate, resolveTemplateFilePath } from "../core/config.js";
import { loadRuntimeConfig } from "../core/runtime.js";
import { AppError } from "../utils/errors.js";
import { pathExistsSync, readTextFileSync } from "../utils/fs.js";

const REQUIRED_TEMPLATE_FIELDS = [
  "pageType",
  "title",
  "status",
  "visibility",
  "sourceRefs",
  "relatedPages",
  "tags",
  "createdAt",
  "updatedAt",
] as const;

const FIXED_TEMPLATE_FIELDS = new Set([
  ...REQUIRED_TEMPLATE_FIELDS,
  "nodeId",
]);

type TemplateLintLevel = "error" | "warning" | "info";

export interface TemplateLintItem {
  pageType: string;
  template: string;
  check: string;
  message: string;
}

export interface TemplateLintResult {
  errors: TemplateLintItem[];
  warnings: TemplateLintItem[];
  info: TemplateLintItem[];
  summary: {
    templates: number;
    errors: number;
    warnings: number;
    info: number;
  };
}

export interface TemplateLintOptions {
  pageType?: string;
  level?: string;
}

function ensureTemplateLintLevel(value: string | undefined): TemplateLintLevel {
  const normalized = (value ?? "info").toLowerCase();
  if (normalized === "error" || normalized === "warning" || normalized === "info") {
    return normalized;
  }
  throw new AppError(`Invalid lint level: ${value}`, "config");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasField(data: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, field);
}

function collectBodySections(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^##\s+\S+/.test(line));
}

function addItem(
  collection: TemplateLintItem[],
  pageType: string,
  template: string,
  check: string,
  message: string,
): void {
  collection.push({ pageType, template, check, message });
}

export function runTemplateLint(
  env: NodeJS.ProcessEnv = process.env,
  options: TemplateLintOptions = {},
): TemplateLintResult {
  const level = ensureTemplateLintLevel(options.level);
  const { paths, config } = loadRuntimeConfig(env);

  if (options.pageType) {
    getTemplate(config, options.pageType);
  }

  const pageTypes = (options.pageType ? [options.pageType] : Object.keys(config.templates)).sort((left, right) =>
    left.localeCompare(right),
  );

  const result: TemplateLintResult = {
    errors: [],
    warnings: [],
    info: [],
    summary: {
      templates: pageTypes.length,
      errors: 0,
      warnings: 0,
      info: 0,
    },
  };

  for (const pageType of pageTypes) {
    const templateConfig = config.templates[pageType];
    const templatePath = resolveTemplateFilePath(config, paths.wikiRoot, pageType);
    const templateLabel = templateConfig.file;

    if (!pathExistsSync(templatePath)) {
      addItem(
        result.errors,
        pageType,
        templateLabel,
        "template_file_missing",
        `Template file not found: ${path.relative(paths.wikiRoot, templatePath)}`,
      );
      continue;
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(readTextFileSync(templatePath));
    } catch (error) {
      addItem(
        result.errors,
        pageType,
        templateLabel,
        "template_parse_error",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }

    if (!isPlainObject(parsed.data)) {
      addItem(
        result.errors,
        pageType,
        templateLabel,
        "invalid_frontmatter",
        "Template frontmatter must be a YAML object.",
      );
      continue;
    }

    const data = parsed.data;
    const registeredFields = new Set<string>([
      ...FIXED_TEMPLATE_FIELDS,
      ...Object.keys(config.customColumns),
      ...Object.keys(config.commonEdges),
      ...Object.keys(templateConfig.columns),
      ...Object.keys(templateConfig.edges),
    ]);

    const missingRequiredFields = REQUIRED_TEMPLATE_FIELDS.filter((field) => !hasField(data, field));
    if (missingRequiredFields.length > 0) {
      addItem(
        result.errors,
        pageType,
        templateLabel,
        "missing_required_fields",
        `Missing required template fields: ${missingRequiredFields.join(", ")}`,
      );
    }

    if (data.pageType !== pageType) {
      addItem(
        result.errors,
        pageType,
        templateLabel,
        "template_page_type_mismatch",
        `Frontmatter pageType must be "${pageType}", got "${String(data.pageType ?? "")}"`,
      );
    }

    const unregisteredFields = Object.keys(data)
      .filter((field) => !registeredFields.has(field))
      .sort();
    if (unregisteredFields.length > 0) {
      addItem(
        result.errors,
        pageType,
        templateLabel,
        "unregistered_template_fields",
        `Fields present in template frontmatter but not declared in schema: ${unregisteredFields.join(", ")}`,
      );
    }

    const unregisteredSummaryFields = templateConfig.summaryFields
      .filter((field) => !registeredFields.has(field))
      .sort();
    if (unregisteredSummaryFields.length > 0) {
      addItem(
        result.errors,
        pageType,
        templateLabel,
        "summary_fields_unregistered",
        `summaryFields reference undeclared fields: ${unregisteredSummaryFields.join(", ")}`,
      );
    }

    const missingCommonEdgeFields = Object.keys(config.commonEdges)
      .filter((field) => !hasField(data, field))
      .sort();
    if (missingCommonEdgeFields.length > 0) {
      addItem(
        result.warnings,
        pageType,
        templateLabel,
        "common_edge_fields_missing",
        `Common edge fields missing from template frontmatter: ${missingCommonEdgeFields.join(", ")}`,
      );
    }

    const missingDeclaredFields = [...Object.keys(templateConfig.columns), ...Object.keys(templateConfig.edges)]
      .filter((field) => !hasField(data, field))
      .sort();
    if (missingDeclaredFields.length > 0) {
      addItem(
        result.warnings,
        pageType,
        templateLabel,
        "declared_fields_missing",
        `Fields declared in config but absent from template frontmatter: ${missingDeclaredFields.join(", ")}`,
      );
    }

    const arrayBackedFields = [...Object.keys(config.commonEdges), ...Object.keys(templateConfig.edges)].sort();
    const nonArrayEdgeFields = arrayBackedFields.filter((field) => hasField(data, field) && !Array.isArray(data[field]));
    if (nonArrayEdgeFields.length > 0) {
      addItem(
        result.errors,
        pageType,
        templateLabel,
        "edge_fields_not_array",
        `Edge fields must be arrays in template frontmatter: ${nonArrayEdgeFields.join(", ")}`,
      );
    }

    const sections = collectBodySections(parsed.content);
    if (sections.length < 2) {
      addItem(
        result.warnings,
        pageType,
        templateLabel,
        "body_sections_min",
        `Template body should contain at least 2 level-2 sections, found ${sections.length}`,
      );
    }
  }

  result.summary = {
    templates: pageTypes.length,
    errors: result.errors.length,
    warnings: level === "warning" || level === "info" ? result.warnings.length : 0,
    info: level === "info" ? result.info.length : 0,
  };

  return {
    errors: result.errors,
    warnings: level === "warning" || level === "info" ? result.warnings : [],
    info: level === "info" ? result.info : [],
    summary: result.summary,
  };
}

export function renderTemplateLintResult(result: TemplateLintResult): string {
  const lines = [`tiangong-wiki template lint: ${result.summary.templates} templates checked`, ""];
  const sections: Array<{ label: string; items: TemplateLintItem[] }> = [
    { label: "ERROR", items: result.errors },
    { label: "WARN", items: result.warnings },
    { label: "INFO", items: result.info },
  ];

  for (const section of sections) {
    for (const item of section.items) {
      lines.push(`  ${section.label.padEnd(5)} ${item.pageType} (${item.template})`);
      lines.push(`         ${item.message}`);
      lines.push("");
    }
  }

  lines.push(
    `Summary: ${result.summary.errors} errors, ${result.summary.warnings} warnings, ${result.summary.info} info`,
  );
  return lines.join("\n");
}

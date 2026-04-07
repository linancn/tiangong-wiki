import { Command } from "commander";
import path from "node:path";

import { parsePage } from "../core/frontmatter.js";
import { openRuntimeDb } from "../core/runtime.js";
import { readAllPages } from "../core/sync.js";
import type { LintItem, LintResult } from "../types/page.js";
import { ensureTextOrJson, writeJson, writeText } from "../utils/output.js";
import { listFilesRecursiveSync } from "../utils/fs.js";
import { normalizePageId, resolvePagePath } from "../core/paths.js";

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function olderThanSixMonths(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.getTime())) {
    return false;
  }

  const threshold = new Date();
  threshold.setMonth(threshold.getMonth() - 6);
  return updatedAt < threshold;
}

function addItem(target: LintItem[], page: string, check: string, message: string): void {
  target.push({ page, check, message });
}

function renderHumanReadable(result: LintResult, level: string): string {
  const lines = [`wiki lint: ${result.pages} pages checked`, ""];
  const sections: Array<{ label: string; items: LintItem[] }> = [];

  if (level === "error" || level === "warning" || level === "info") {
    sections.push({ label: "ERROR", items: result.errors });
  }
  if (level === "warning" || level === "info") {
    sections.push({ label: "WARN", items: result.warnings });
  }
  if (level === "info") {
    sections.push({ label: "INFO", items: result.info });
  }

  for (const section of sections) {
    for (const item of section.items) {
      lines.push(`  ${section.label.padEnd(5)} ${item.page}`);
      lines.push(`         ${item.message}`);
      lines.push("");
    }
  }

  lines.push(
    `Summary: ${result.errors.length} errors, ${result.warnings.length} warnings, ${result.info.length} info`,
  );
  return lines.join("\n");
}

export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Validate wiki pages, references, and graph integrity")
    .option("--path <pagePath>", "Lint only one page")
    .option("--level <level>", "error, warning, or info", "info")
    .option("--format <format>", "text or json", "text")
    .action((options) => {
      const format = ensureTextOrJson(options.format);
      const level = options.level ?? "info";
      const { db, config, paths } = openRuntimeDb(process.env);
      try {
        const pageFiles = options.path
          ? [resolvePagePath(normalizePageId(options.path, paths.wikiPath), paths.wikiPath)]
          : listFilesRecursiveSync(paths.wikiPath, ".md");

        const indexedPages = readAllPages(db);
        const pageIdSet = new Set(indexedPages.map((page) => page.id));
        const nodeIdSet = new Set(indexedPages.map((page) => page.nodeId).filter(Boolean) as string[]);
        const archivedIds = new Set(
          indexedPages.filter((page) => page.status === "archived").map((page) => page.id),
        );
        const archivedNodeIds = new Set(
          indexedPages.filter((page) => page.status === "archived" && page.nodeId).map((page) => page.nodeId as string),
        );
        const vaultIds = new Set(
          (db.prepare("SELECT id FROM vault_files").all() as Array<{ id: string }>).map((row) => row.id),
        );
        const edges = db
          .prepare("SELECT source, target, source_page AS sourcePage FROM edges")
          .all() as Array<{ source: string; target: string; sourcePage: string }>;

        const result: LintResult = { pages: pageFiles.length, errors: [], warnings: [], info: [] };

        for (const filePath of pageFiles) {
          const parsed = parsePage(filePath, paths.wikiPath, config);
          const pageId = path.relative(paths.wikiPath, filePath).split(path.sep).join("/");

          if (!parsed.ok) {
            addItem(result.errors, pageId, parsed.error.code, parsed.error.message);
            continue;
          }

          const { parsed: page } = parsed;
          const sourceRefs = normalizeStringArray(page.rawData.sourceRefs);

          for (const reference of sourceRefs) {
            if (reference.startsWith("vault/") && !vaultIds.has(reference.replace(/^vault\//, ""))) {
              addItem(
                result.errors,
                page.page.id,
                "vault_ref_exists",
                `sourceRefs: ${reference} does not exist in vault`,
              );
            }
          }

          for (const edge of page.edges) {
            const isPathTarget = edge.target.endsWith(".md");
            if (isPathTarget && !pageIdSet.has(edge.target)) {
              addItem(result.errors, page.page.id, "page_ref_exists", `${edge.edgeType}: ${edge.target} not found`);
            }
            if (!isPathTarget && !nodeIdSet.has(edge.target)) {
              addItem(result.errors, page.page.id, "node_ref_exists", `${edge.edgeType}: ${edge.target} not found`);
            }
            if (isPathTarget && archivedIds.has(edge.target)) {
              addItem(result.warnings, page.page.id, "archived_page_ref", `${edge.target} is archived`);
            }
            if (!isPathTarget && archivedNodeIds.has(edge.target)) {
              addItem(result.warnings, page.page.id, "archived_node_ref", `${edge.target} is archived`);
            }
          }

          if (sourceRefs.length === 0) {
            addItem(result.warnings, page.page.id, "source_refs_empty", "sourceRefs is empty");
          }

          if (page.page.status === "active" && olderThanSixMonths(page.page.updatedAt)) {
            addItem(result.warnings, page.page.id, "stale_page", "updatedAt is older than six months");
          }

          const identifiers = [page.page.id, page.page.nodeId].filter(Boolean);
          const hasOutgoing = page.edges.length > 0 || edges.some((edge) => edge.sourcePage === page.page.id);
          const hasIncoming = edges.some((edge) => identifiers.includes(edge.target));
          if (!hasOutgoing && !hasIncoming) {
            addItem(result.warnings, page.page.id, "orphan_page", "No incoming or outgoing links");
          }

          if (page.unregisteredFields.length > 0) {
            addItem(
              result.info,
              page.page.id,
              "unregistered_fields",
              `Unregistered fields: ${page.unregisteredFields.join(", ")}`,
            );
          }
        }

        const draftCount = indexedPages.filter((page) => page.status === "draft").length;
        const pendingEmbeddings = indexedPages.filter((page) => page.embeddingStatus !== "done").length;
        addItem(result.info, "*", "draft_count", `${draftCount} pages in draft status`);
        addItem(result.info, "*", "embedding_pending", `${pendingEmbeddings} pages with pending embedding`);

        if (format === "json") {
          const filtered = {
            errors: result.errors,
            warnings: level === "warning" || level === "info" ? result.warnings : [],
            info: level === "info" ? result.info : [],
            summary: {
              pages: result.pages,
              errors: result.errors.length,
              warnings: level === "warning" || level === "info" ? result.warnings.length : 0,
              info: level === "info" ? result.info.length : 0,
            },
          };
          writeJson(filtered);
          return;
        }

        writeText(renderHumanReadable(result, level));
      } finally {
        db.close();
      }
    });
}

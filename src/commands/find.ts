import type { Command } from "commander";

import type { LoadedWikiConfig } from "../types/config.js";
import { openRuntimeDb } from "../core/runtime.js";
import { compactPageSummary } from "../core/presenters.js";
import { listPageColumns, mapPageRow } from "../core/query.js";
import { AppError } from "../utils/errors.js";
import { camelToSnake } from "../utils/case.js";
import { writeJson } from "../utils/output.js";

function resolveSortColumn(sort: string | undefined, config: LoadedWikiConfig): string {
  if (!sort) {
    return "updated_at";
  }

  const normalized = camelToSnake(sort.replace(/-/g, "_"));
  const allowed = new Set([
    "id",
    "node_id",
    "title",
    "page_type",
    "status",
    "visibility",
    "updated_at",
    "created_at",
    ...config.allColumnNames,
  ]);

  if (!allowed.has(normalized)) {
    throw new AppError(`Unsupported sort column: ${sort}`, "config");
  }

  return normalized;
}

export function registerFindCommand(program: Command, config?: LoadedWikiConfig): void {
  const command = program
    .command("find")
    .description("Find wiki pages by structured metadata filters")
    .option("--type <pageType>", "Filter by pageType")
    .option("--status <status>", "Filter by status")
    .option("--visibility <visibility>", "Filter by visibility")
    .option("--tag <tag>", "Filter by tag")
    .option("--node-id <nodeId>", "Filter by nodeId")
    .option("--updated-after <date>", "Filter by updatedAt >= date")
    .option("--sort <column>", "Sort column")
    .option("--limit <number>", "Max rows to return", "50");

  const dynamicFields = config
    ? [...new Set([...Object.keys(config.customColumns), ...Object.values(config.templates).flatMap((template) => Object.keys(template.columns))])]
    : [];

  for (const field of dynamicFields) {
    command.option(`--${camelToSnake(field).replace(/_/g, "-")} <value>`, `Filter by ${field}`);
  }

  command.action((options) => {
    const { db, config: runtimeConfig } = openRuntimeDb(process.env);
    try {
      const where: string[] = [];
      const params: unknown[] = [];

      if (options.type) {
        where.push("page_type = ?");
        params.push(options.type);
      }
      if (options.status) {
        where.push("status = ?");
        params.push(options.status);
      }
      if (options.visibility) {
        where.push("visibility = ?");
        params.push(options.visibility);
      }
      if (options.nodeId) {
        where.push("node_id = ?");
        params.push(options.nodeId);
      }
      if (options.updatedAfter) {
        where.push("updated_at >= ?");
        params.push(options.updatedAfter);
      }
      if (options.tag) {
        where.push("EXISTS (SELECT 1 FROM json_each(pages.tags) WHERE json_each.value = ?)");
        params.push(options.tag);
      }

      for (const field of dynamicFields) {
        const value = options[field];
        if (value !== undefined) {
          where.push(`${camelToSnake(field)} = ?`);
          params.push(value);
        }
      }

      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new AppError(`Invalid --limit value: ${options.limit}`, "config");
      }

      const sortColumn = resolveSortColumn(options.sort, runtimeConfig);
      const query = `
        SELECT ${listPageColumns(runtimeConfig).join(", ")}
        FROM pages
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ${sortColumn} DESC, title ASC
        LIMIT ?
      `;
      const rows = db.prepare(query).all(...params, limit) as Array<Record<string, unknown>>;
      writeJson(rows.map((row) => compactPageSummary(mapPageRow(row, runtimeConfig), runtimeConfig)));
    } finally {
      db.close();
    }
  });
}

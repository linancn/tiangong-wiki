import { Command } from "commander";

import { openRuntimeDb } from "../core/runtime.js";
import { compactPageSummary } from "../core/presenters.js";
import { listPageColumns, mapPageRow } from "../core/query.js";
import { AppError } from "../utils/errors.js";
import { camelToSnake } from "../utils/case.js";
import { writeJson } from "../utils/output.js";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List wiki pages")
    .option("--type <pageType>", "Optional pageType filter")
    .option("--sort <column>", "Sort column", "updatedAt")
    .option("--limit <number>", "Max rows to return", "50")
    .action((options) => {
      const { db, config } = openRuntimeDb(process.env);
      try {
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new AppError(`Invalid --limit value: ${options.limit}`, "config");
        }

        const sortColumn = camelToSnake(options.sort ?? "updatedAt");
        const allowedSortColumns = new Set(["updated_at", "created_at", "title", "page_type", ...config.allColumnNames]);
        if (!allowedSortColumns.has(sortColumn)) {
          throw new AppError(`Unsupported --sort column: ${options.sort}`, "config");
        }

        const rows = db
          .prepare(
            `
              SELECT ${listPageColumns(config).join(", ")}
              FROM pages
              ${options.type ? "WHERE page_type = ?" : ""}
              ORDER BY ${sortColumn} DESC, title ASC
              LIMIT ?
            `,
          )
          .all(...(options.type ? [options.type, limit] : [limit])) as Array<Record<string, unknown>>;

        writeJson(rows.map((row) => compactPageSummary(mapPageRow(row, config), config)));
      } finally {
        db.close();
      }
    });
}

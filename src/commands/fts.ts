import { Command } from "commander";

import { openRuntimeDb } from "../core/runtime.js";
import { compactPageSummary } from "../core/presenters.js";
import { listPageColumns, mapPageRow } from "../core/query.js";
import { AppError } from "../utils/errors.js";
import { writeJson } from "../utils/output.js";
import { normalizeFtsQuery } from "../utils/segmenter.js";

export function registerFtsCommand(program: Command): void {
  program
    .command("fts")
    .description("Run full-text search over title, tags, and summary text")
    .argument("<query>", "FTS query")
    .option("--type <pageType>", "Optional pageType filter")
    .option("--limit <number>", "Max rows to return", "20")
    .action((query, options) => {
      const { db, config } = openRuntimeDb(process.env);
      try {
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new AppError(`Invalid --limit value: ${options.limit}`, "config");
        }
        const normalizedQuery = normalizeFtsQuery(query);

        const rows = db
          .prepare(
            `
              SELECT ${listPageColumns(config).map((column) => `pages.${column}`).join(", ")}, bm25(pages_fts) AS rank
              FROM pages_fts
              JOIN pages ON pages.rowid = pages_fts.rowid
              WHERE pages_fts MATCH ?
              ${options.type ? "AND pages.page_type = ?" : ""}
              ORDER BY rank
              LIMIT ?
            `,
          )
          .all(...(options.type ? [normalizedQuery, options.type, limit] : [normalizedQuery, limit])) as Array<
          Record<string, unknown>
        >;

        writeJson(
          rows.map((row) => ({
            ...compactPageSummary(mapPageRow(row, config), config),
            rank: row.rank,
          })),
        );
      } finally {
        db.close();
      }
    });
}

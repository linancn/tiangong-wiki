import { Command } from "commander";

import { EmbeddingClient } from "../core/embedding.js";
import { openRuntimeDb } from "../core/runtime.js";
import { compactPageSummary } from "../core/presenters.js";
import { listPageColumns, mapPageRow } from "../core/query.js";
import { AppError } from "../utils/errors.js";
import { writeJson } from "../utils/output.js";

function distanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description("Run semantic search over page summary embeddings")
    .argument("<query>", "Natural language query")
    .option("--type <pageType>", "Optional pageType filter")
    .option("--limit <number>", "Max rows to return", "10")
    .action(async (query, options) => {
      const embeddingClient = EmbeddingClient.fromEnv(process.env);
      if (!embeddingClient) {
        throw new AppError("Embedding not configured", "not_configured");
      }

      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new AppError(`Invalid --limit value: ${options.limit}`, "config");
      }

      const [queryEmbedding] = await embeddingClient.embedBatch([query]);
      const { db, config } = openRuntimeDb(process.env);
      try {
        const rows = db
          .prepare(
            `
              SELECT ${listPageColumns(config).map((column) => `pages.${column}`).join(", ")}, vec_pages.distance AS distance
              FROM vec_pages
              JOIN pages ON pages.id = vec_pages.page_id
              WHERE vec_pages.embedding MATCH ?
                AND k = ?
                ${options.type ? "AND pages.page_type = ?" : ""}
              ORDER BY vec_pages.distance
              LIMIT ?
            `,
          )
          .all(
            ...(options.type
              ? [new Float32Array(queryEmbedding), limit, options.type, limit]
              : [new Float32Array(queryEmbedding), limit, limit]),
          ) as Array<Record<string, unknown>>;

        writeJson(
          rows.map((row) => ({
            ...compactPageSummary(mapPageRow(row, config), config),
            summaryText: row.summary_text,
            similarity: distanceToSimilarity(Number(row.distance)),
          })),
        );
      } finally {
        db.close();
      }
    });
}

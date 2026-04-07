import { Command } from "commander";
import path from "node:path";

import { EmbeddingClient } from "../core/embedding.js";
import { openRuntimeDb, loadRuntimeConfig } from "../core/runtime.js";
import { AppError } from "../utils/errors.js";
import { ensureTextOrJson, writeJson, writeText } from "../utils/output.js";

interface TypeDescriptor {
  pageType: string;
  file: string;
  filePath: string;
  columns: string[];
  edges: string[];
  summaryFields: string[];
}

interface SimilarPageHit {
  pageType: string;
  pageId: string;
  title: string;
  similarity: number;
}

function distanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

function normalizeKeywords(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toTypeDescriptor(
  pageType: string,
  definition: ReturnType<typeof loadRuntimeConfig>["config"]["templates"][string],
  wikiRoot: string,
): TypeDescriptor {
  return {
    pageType,
    file: definition.file,
    filePath: path.resolve(wikiRoot, definition.file),
    columns: Object.keys(definition.columns),
    edges: Object.keys(definition.edges),
    summaryFields: definition.summaryFields,
  };
}

async function recommendTypesFromEmbeddings(
  text: string,
  keywords: string[],
  limit: number,
): Promise<{
  query: { text: string; keywords: string[] };
  recommendations: Array<{
    pageType: string;
    score: number;
    signals: string[];
    similarPages: string[];
  }>;
}> {
  const embeddingClient = EmbeddingClient.fromEnv(process.env);
  if (!embeddingClient) {
    throw new AppError("Embedding not configured", "not_configured");
  }

  const queryText = [text.trim(), keywords.length > 0 ? `keywords: ${keywords.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const [queryEmbedding] = await embeddingClient.embedBatch([queryText]);
  const neighborLimit = Math.max(limit * 8, 24);
  const { db } = openRuntimeDb(process.env);

  try {
    const hasVectors = (
      db.prepare("SELECT COUNT(*) AS count FROM vec_pages").get() as { count: number }
    ).count;
    if (hasVectors === 0) {
      throw new AppError("No page embeddings found. Run wiki sync with embedding enabled first.", "not_configured");
    }

    const rows = db
      .prepare(
        `
          SELECT
            pages.page_type AS pageType,
            pages.id AS pageId,
            pages.title AS title,
            vec_pages.distance AS distance
          FROM vec_pages
          JOIN pages ON pages.id = vec_pages.page_id
          WHERE vec_pages.embedding MATCH ?
            AND k = ?
          ORDER BY vec_pages.distance
          LIMIT ?
        `,
      )
      .all(new Float32Array(queryEmbedding), neighborLimit, neighborLimit) as Array<{
      pageType: string;
      pageId: string;
      title: string;
      distance: number;
    }>;

    if (rows.length === 0) {
      throw new AppError("No similar embedded pages found for type recommendation.", "runtime");
    }

    const grouped = new Map<
      string,
      {
        totalSimilarity: number;
        maxSimilarity: number;
        supportCount: number;
        hits: SimilarPageHit[];
      }
    >();

    for (const row of rows) {
      const similarity = distanceToSimilarity(Number(row.distance));
      const bucket = grouped.get(row.pageType) ?? {
        totalSimilarity: 0,
        maxSimilarity: 0,
        supportCount: 0,
        hits: [],
      };
      bucket.totalSimilarity += similarity;
      bucket.maxSimilarity = Math.max(bucket.maxSimilarity, similarity);
      bucket.supportCount += 1;
      bucket.hits.push({
        pageType: row.pageType,
        pageId: row.pageId,
        title: row.title,
        similarity,
      });
      grouped.set(row.pageType, bucket);
    }

    const recommendations = [...grouped.entries()]
      .map(([pageType, bucket]) => {
        const topHits = bucket.hits
          .sort((left, right) => right.similarity - left.similarity)
          .slice(0, 3);
        return {
          pageType,
          score: Number(bucket.totalSimilarity.toFixed(6)),
          signals: [
            `supportCount:${bucket.supportCount}`,
            `maxSimilarity:${bucket.maxSimilarity.toFixed(4)}`,
            `avgSimilarity:${(bucket.totalSimilarity / bucket.supportCount).toFixed(4)}`,
          ],
          similarPages: topHits.map((hit) => `${hit.pageId}@${hit.similarity.toFixed(4)}`),
        };
      })
      .sort((left, right) => right.score - left.score || left.pageType.localeCompare(right.pageType))
      .slice(0, limit);

    return {
      query: { text, keywords },
      recommendations,
    };
  } finally {
    db.close();
  }
}

export function registerTypeCommand(program: Command): void {
  const typeCommand = program.command("type").description("Inspect and recommend wiki page types");

  typeCommand
    .command("list")
    .option("--format <format>", "Output format: text or json", "text")
    .action((options) => {
      const format = ensureTextOrJson(options.format);
      const { paths, config } = loadRuntimeConfig(process.env);
      const payload = Object.entries(config.templates)
        .map(([pageType, definition]) => toTypeDescriptor(pageType, definition, paths.wikiRoot))
        .sort((left, right) => left.pageType.localeCompare(right.pageType));

      if (format === "json") {
        writeJson(payload);
        return;
      }

      writeText(payload.map((entry) => `${entry.pageType} -> ${entry.file}`).join("\n"));
    });

  typeCommand
    .command("show")
    .argument("<pageType>", "Registered pageType")
    .option("--format <format>", "Output format: text or json", "text")
    .action((pageType, options) => {
      const format = ensureTextOrJson(options.format);
      const { paths, config } = loadRuntimeConfig(process.env);
      const definition = config.templates[pageType];
      if (!definition) {
        throw new AppError(`Unknown type: ${pageType}`, "not_found");
      }

      const payload = {
        ...toTypeDescriptor(pageType, definition, paths.wikiRoot),
        columns: definition.columns,
        edges: definition.edges,
      };

      if (format === "json") {
        writeJson(payload);
        return;
      }

      writeText(
        [
          `pageType: ${payload.pageType}`,
          `file: ${payload.file}`,
          `columns: ${Object.keys(definition.columns).join(", ") || "(none)"}`,
          `edges: ${Object.keys(definition.edges).join(", ") || "(none)"}`,
          `summaryFields: ${definition.summaryFields.join(", ") || "(none)"}`,
        ].join("\n"),
      );
    });

  typeCommand
    .command("recommend")
    .requiredOption("--text <text>", "Short summary or extracted content")
    .option("--keywords <keywords>", "Comma-separated keywords")
    .option("--limit <limit>", "Max number of recommendations", "5")
    .option("--format <format>", "Output format: text or json", "text")
    .action(async (options) => {
      const format = ensureTextOrJson(options.format);
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new AppError(`Invalid --limit value: ${options.limit}`, "config");
      }

      const payload = await recommendTypesFromEmbeddings(
        String(options.text ?? ""),
        normalizeKeywords(options.keywords),
        limit,
      );

      if (format === "json") {
        writeJson(payload);
        return;
      }

      writeText(
        payload.recommendations
          .map((entry) => `${entry.pageType} (${entry.score.toFixed(4)}) ${entry.signals.join(" | ")}`)
          .join("\n"),
      );
    });
}

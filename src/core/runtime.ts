import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { DEFAULT_EMBEDDING_DIMENSIONS, EmbeddingClient } from "./embedding.js";
import { resolveRuntimePaths } from "./paths.js";
import type { LoadedWikiConfig } from "../types/config.js";
import type { RuntimePaths } from "../types/page.js";

export function getEmbeddingDimensionFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EMBEDDING_DIMENSIONS ?? String(DEFAULT_EMBEDDING_DIMENSIONS);
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_EMBEDDING_DIMENSIONS;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): {
  paths: RuntimePaths;
  config: LoadedWikiConfig;
} {
  const paths = resolveRuntimePaths(env);
  const config = loadConfig(paths.configPath);
  return { paths, config };
}

export function openRuntimeDb(env: NodeJS.ProcessEnv = process.env) {
  const { paths, config } = loadRuntimeConfig(env);
  const embeddingClient = EmbeddingClient.fromEnv(env);
  const { db, vectorDimensions, vectorDimensionsChanged } = openDb(
    paths.dbPath,
    config,
    embeddingClient?.settings.dimensions ?? getEmbeddingDimensionFromEnv(env),
    paths.packageRoot,
  );
  return { db, paths, config, embeddingClient, vectorDimensions, vectorDimensionsChanged };
}

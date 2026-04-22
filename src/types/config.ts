export type SqliteColumnType = "text" | "integer" | "real" | "numeric" | "blob";
export type FtsTokenizerMode = "default" | "simple";

export interface FtsConfig {
  tokenizer: FtsTokenizerMode;
}

export interface EdgeRule {
  edgeType: string;
  resolve: "nodeId" | "path";
  match?: string;
}

export interface TemplateConfig {
  file: string;
  columns: Record<string, SqliteColumnType>;
  edges: Record<string, EdgeRule>;
  summaryFields: string[];
}

export interface WikiConfig {
  schemaVersion: number;
  fts: FtsConfig;
  customColumns: Record<string, SqliteColumnType>;
  defaultSummaryFields: string[];
  vaultFileTypes: string[];
  commonEdges: Record<string, EdgeRule>;
  templates: Record<string, TemplateConfig>;
}

export interface LoadedWikiConfig extends WikiConfig {
  configPath: string;
  configVersion: string;
  allColumnDefinitions: Record<string, SqliteColumnType>;
  allColumnNames: string[];
}

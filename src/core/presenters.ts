import type { LoadedWikiConfig } from "../types/config.js";

export function compactPageSummary(
  page: Record<string, unknown>,
  config: LoadedWikiConfig,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: page.id,
    title: page.title,
    pageType: page.pageType,
    status: page.status,
    visibility: page.visibility,
    filePath: page.filePath,
    tags: page.tags,
    updatedAt: page.updatedAt,
  };

  if (page.nodeId) {
    summary.nodeId = page.nodeId;
  }

  for (const columnName of config.allColumnNames) {
    const camelName = columnName.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
    const value = page[camelName];
    if (value !== null && value !== undefined && value !== "") {
      summary[camelName] = value;
    }
  }

  return summary;
}

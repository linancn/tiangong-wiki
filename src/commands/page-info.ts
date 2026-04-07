import { Command } from "commander";
import path from "node:path";

import { openRuntimeDb } from "../core/runtime.js";
import { selectPageById } from "../core/query.js";
import { normalizePageId } from "../core/paths.js";
import { AppError } from "../utils/errors.js";
import { writeJson } from "../utils/output.js";

function normalizePageInfoId(input: string, wikiPath: string): string {
  if (input.endsWith(".md") || path.isAbsolute(input)) {
    return normalizePageId(input, wikiPath);
  }
  return input;
}

export function registerPageInfoCommand(program: Command): void {
  program
    .command("page-info")
    .description("Show full metadata and edge details for one page")
    .argument("<pageId>", "Page id relative to wiki/pages")
    .action((inputPageId) => {
      const { db, config, paths } = openRuntimeDb(process.env);
      try {
        const pageId = normalizePageInfoId(inputPageId, paths.wikiPath);
        const page = selectPageById(db, config, pageId);
        if (!page) {
          throw new AppError(`Page not found: ${pageId}`, "not_found");
        }

        const identifiers = [page.id, page.nodeId].filter(Boolean);
        const outgoing = db
          .prepare(
            `
              SELECT source, target, edge_type AS edgeType, source_page AS sourcePage, metadata
              FROM edges
              WHERE source_page = ?
              ORDER BY edge_type, target
            `,
          )
          .all(page.id) as Array<Record<string, unknown>>;
        const incoming = db
          .prepare(
            `
              SELECT source, target, edge_type AS edgeType, source_page AS sourcePage, metadata
              FROM edges
              WHERE target IN (${identifiers.map(() => "?").join(", ")})
              ORDER BY edge_type, source
            `,
          )
          .all(...identifiers) as Array<Record<string, unknown>>;

        writeJson({
          ...page,
          outgoingEdges: outgoing.map((edge) => ({
            ...edge,
            metadata: edge.metadata ? JSON.parse(String(edge.metadata)) : {},
          })),
          incomingEdges: incoming.map((edge) => ({
            ...edge,
            metadata: edge.metadata ? JSON.parse(String(edge.metadata)) : {},
          })),
        });
      } finally {
        db.close();
      }
    });
}

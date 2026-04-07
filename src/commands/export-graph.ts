import { Command } from "commander";

import { openRuntimeDb } from "../core/runtime.js";
import { writeJson, writeText } from "../utils/output.js";
import { writeTextFileSync } from "../utils/fs.js";
import { toOffsetIso } from "../utils/time.js";

export function registerExportGraphCommand(program: Command): void {
  program
    .command("export-graph")
    .description("Export graph nodes and edges as JSON")
    .option("--output <filePath>", "Write JSON to a file")
    .action((options) => {
      const { db } = openRuntimeDb(process.env);
      try {
        const nodes = db
          .prepare(
            `
              SELECT
                id,
                node_id AS nodeId,
                title,
                page_type AS pageType,
                file_path AS filePath
              FROM pages
              WHERE node_id IS NOT NULL
              ORDER BY node_id
            `,
          )
          .all();
        const edges = db
          .prepare(
            `
              SELECT
                source,
                target,
                edge_type AS edgeType,
                source_page AS sourcePage,
                metadata
              FROM edges
              ORDER BY edge_type, source, target
            `,
          )
          .all() as Array<Record<string, unknown>>;
        const normalizedEdges = edges
          .map((edge: Record<string, unknown>) => ({
            ...edge,
            metadata: edge.metadata ? JSON.parse(String(edge.metadata)) : {},
          }));

        const payload = {
          generatedAt: toOffsetIso(),
          nodes,
          edges: normalizedEdges,
        };
        const content = `${JSON.stringify(payload, null, 2)}\n`;
        if (options.output) {
          writeTextFileSync(options.output, content);
          writeJson({ output: options.output, nodes: nodes.length, edges: normalizedEdges.length });
          return;
        }

        writeText(content);
      } finally {
        db.close();
      }
    });
}

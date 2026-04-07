import { Command } from "commander";

import { openRuntimeDb } from "../core/runtime.js";
import { AppError } from "../utils/errors.js";
import { writeJson } from "../utils/output.js";

type Direction = "outgoing" | "incoming" | "both";

function buildGraphQuery(direction: Direction, edgeType?: string): { sql: string; params: unknown[] } {
  if (direction === "outgoing") {
    return {
      sql: `
        WITH RECURSIVE walk(depth, node, source, target, edge_type, trail) AS (
          SELECT
            1,
            e.target,
            e.source,
            e.target,
            e.edge_type,
            '|' || ? || '|' || e.target || '|'
          FROM edges e
          WHERE e.source = ?
          ${edgeType ? "AND e.edge_type = ?" : ""}
          UNION ALL
          SELECT
            walk.depth + 1,
            e.target,
            e.source,
            e.target,
            e.edge_type,
            walk.trail || e.target || '|'
          FROM walk
          JOIN edges e ON e.source = walk.node
          WHERE walk.depth < ?
          ${edgeType ? "AND e.edge_type = ?" : ""}
            AND instr(walk.trail, '|' || e.target || '|') = 0
        )
        SELECT DISTINCT source, target, edge_type AS edgeType FROM walk
      `,
      params: [],
    };
  }

  if (direction === "incoming") {
    return {
      sql: `
        WITH RECURSIVE walk(depth, node, source, target, edge_type, trail) AS (
          SELECT
            1,
            e.source,
            e.source,
            e.target,
            e.edge_type,
            '|' || ? || '|' || e.source || '|'
          FROM edges e
          WHERE e.target = ?
          ${edgeType ? "AND e.edge_type = ?" : ""}
          UNION ALL
          SELECT
            walk.depth + 1,
            e.source,
            e.source,
            e.target,
            e.edge_type,
            walk.trail || e.source || '|'
          FROM walk
          JOIN edges e ON e.target = walk.node
          WHERE walk.depth < ?
          ${edgeType ? "AND e.edge_type = ?" : ""}
            AND instr(walk.trail, '|' || e.source || '|') = 0
        )
        SELECT DISTINCT source, target, edge_type AS edgeType FROM walk
      `,
      params: [],
    };
  }

  return {
    sql: `
      WITH RECURSIVE walk(depth, node, source, target, edge_type, trail) AS (
        SELECT
          1,
          CASE WHEN e.source = ? THEN e.target ELSE e.source END,
          e.source,
          e.target,
          e.edge_type,
          '|' || ? || '|' || CASE WHEN e.source = ? THEN e.target ELSE e.source END || '|'
        FROM edges e
        WHERE (e.source = ? OR e.target = ?)
        ${edgeType ? "AND e.edge_type = ?" : ""}
        UNION ALL
        SELECT
          walk.depth + 1,
          CASE WHEN e.source = walk.node THEN e.target ELSE e.source END,
          e.source,
          e.target,
          e.edge_type,
          walk.trail || CASE WHEN e.source = walk.node THEN e.target ELSE e.source END || '|'
        FROM walk
        JOIN edges e ON (e.source = walk.node OR e.target = walk.node)
        WHERE walk.depth < ?
        ${edgeType ? "AND e.edge_type = ?" : ""}
          AND instr(
            walk.trail,
            '|' || CASE WHEN e.source = walk.node THEN e.target ELSE e.source END || '|'
          ) = 0
      )
      SELECT DISTINCT source, target, edge_type AS edgeType FROM walk
    `,
    params: [],
  };
}

export function registerGraphCommand(program: Command): void {
  program
    .command("graph")
    .description("Traverse the wiki graph with recursive CTEs")
    .argument("<root>", "Root nodeId or page id")
    .option("--depth <number>", "Traversal depth", "1")
    .option("--edge-type <edgeType>", "Optional edge type filter")
    .option("--direction <direction>", "outgoing, incoming, or both", "both")
    .action((root, options) => {
      const { db } = openRuntimeDb(process.env);
      try {
        const depth = Number.parseInt(options.depth, 10);
        if (!Number.isFinite(depth) || depth < 1) {
          throw new AppError(`Invalid --depth value: ${options.depth}`, "config");
        }

        const direction = (options.direction ?? "both") as Direction;
        if (!["outgoing", "incoming", "both"].includes(direction)) {
          throw new AppError(`Invalid --direction value: ${options.direction}`, "config");
        }

        const rootRow = db
          .prepare("SELECT id, node_id AS nodeId, title, page_type AS pageType FROM pages WHERE node_id = ? OR id = ? LIMIT 1")
          .get(root, root) as { id: string; nodeId: string | null; title: string; pageType: string } | undefined;
        const rootKey = rootRow?.nodeId ?? rootRow?.id ?? root;

        const { sql } = buildGraphQuery(direction, options.edgeType);
        let params: unknown[];
        if (direction === "both") {
          params = options.edgeType
            ? [rootKey, rootKey, rootKey, rootKey, rootKey, options.edgeType, depth, options.edgeType]
            : [rootKey, rootKey, rootKey, rootKey, rootKey, depth];
        } else {
          params = options.edgeType
            ? [rootKey, rootKey, options.edgeType, depth, options.edgeType]
            : [rootKey, rootKey, depth];
        }

        const edges = db.prepare(sql).all(...params) as Array<{
          source: string;
          target: string;
          edgeType: string;
        }>;

        const identifiers = [...new Set([rootKey, ...edges.flatMap((edge) => [edge.source, edge.target])])];
        const lookupPage = db.prepare(
          "SELECT id, node_id AS nodeId, title, page_type AS pageType, file_path AS filePath FROM pages WHERE node_id = ? OR id = ? LIMIT 1",
        );
        const nodes = identifiers.map((identifier) => {
          const row = lookupPage.get(identifier, identifier) as
            | {
                id: string;
                nodeId: string | null;
                title: string;
                pageType: string;
                filePath: string;
              }
            | undefined;
          if (!row) {
            return { nodeId: identifier };
          }
          return {
            id: row.id,
            nodeId: row.nodeId ?? row.id,
            title: row.title,
            pageType: row.pageType,
            filePath: row.filePath,
          };
        });

        writeJson({
          root: rootKey,
          nodes,
          edges,
        });
      } finally {
        db.close();
      }
    });
}

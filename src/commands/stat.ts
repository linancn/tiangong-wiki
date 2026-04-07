import { Command } from "commander";

import { openRuntimeDb } from "../core/runtime.js";
import { getMeta } from "../core/db.js";
import { readAllPages } from "../core/sync.js";
import { writeJson } from "../utils/output.js";

export function registerStatCommand(program: Command): void {
  program
    .command("stat")
    .description("Show aggregate wiki index statistics")
    .action(() => {
      const { db, config } = openRuntimeDb(process.env);
      try {
        const pages = readAllPages(db);
        const edges = db
          .prepare("SELECT source, target, source_page AS sourcePage FROM edges")
          .all() as Array<{ source: string; target: string; sourcePage: string }>;
        const byType: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        const embeddingStatus: Record<string, number> = {};

        for (const page of pages) {
          byType[page.pageType] = (byType[page.pageType] ?? 0) + 1;
          byStatus[page.status] = (byStatus[page.status] ?? 0) + 1;
          embeddingStatus[page.embeddingStatus] = (embeddingStatus[page.embeddingStatus] ?? 0) + 1;
        }

        const orphanPages = pages.filter((page) => {
          const identifiers = [page.id, page.nodeId].filter(Boolean);
          const hasOutgoing = edges.some((edge) => edge.sourcePage === page.id);
          const hasIncoming = edges.some((edge) => identifiers.includes(edge.target));
          return !hasOutgoing && !hasIncoming;
        }).length;

        const vaultFiles = db.prepare("SELECT COUNT(*) AS count FROM vault_files").get() as { count: number };

        writeJson({
          totalPages: pages.length,
          byType,
          byStatus,
          totalEdges: edges.length,
          orphanPages,
          embeddingStatus,
          vaultFiles: vaultFiles.count,
          lastSyncAt: getMeta(db, "last_sync_at"),
          registeredTemplates: Object.keys(config.templates).length,
        });
      } finally {
        db.close();
      }
    });
}

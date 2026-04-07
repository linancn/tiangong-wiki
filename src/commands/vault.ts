import { Command } from "commander";

import { openRuntimeDb } from "../core/runtime.js";
import { getMeta } from "../core/db.js";
import { getVaultQueueSnapshot } from "../core/vault-processing.js";
import type { VaultQueueStatus } from "../types/page.js";
import { AppError } from "../utils/errors.js";
import { writeJson } from "../utils/output.js";

function normalizeQueueStatus(value: string | undefined): VaultQueueStatus | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "pending" || value === "processing" || value === "done" || value === "skipped" || value === "error") {
    return value;
  }

  throw new AppError(`Unsupported queue status: ${value}`, "config");
}

export function registerVaultCommand(program: Command): void {
  const vault = program.command("vault").description("Inspect indexed vault files and changelog entries");

  vault
    .command("list")
    .option("--path <prefix>", "Filter by relative path prefix")
    .option("--ext <ext>", "Filter by file extension")
    .action((options) => {
      const { db } = openRuntimeDb(process.env);
      try {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options.path) {
          clauses.push("id LIKE ?");
          params.push(`${options.path}%`);
        }
        if (options.ext) {
          clauses.push("file_ext = ?");
          params.push(String(options.ext).replace(/^\./, ""));
        }

        const rows = db
          .prepare(
            `
              SELECT
                id,
                file_name AS fileName,
                file_ext AS fileExt,
                source_type AS sourceType,
                file_size AS fileSize,
                file_path AS filePath,
                content_hash AS contentHash,
                file_mtime AS fileMtime,
                indexed_at AS indexedAt
              FROM vault_files
              ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
              ORDER BY id
            `,
          )
          .all(...params);

        writeJson(rows);
      } finally {
        db.close();
      }
    });

  vault
    .command("diff")
    .option("--since <date>", "Show changes since a timestamp")
    .option("--path <prefix>", "Filter by relative path prefix")
    .action((options) => {
      const { db } = openRuntimeDb(process.env);
      try {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options.since) {
          clauses.push("detected_at >= ?");
          params.push(options.since);
        } else {
          const lastSyncId = getMeta(db, "last_sync_id");
          if (lastSyncId) {
            clauses.push("sync_id = ?");
            params.push(lastSyncId);
          }
        }
        if (options.path) {
          clauses.push("file_id LIKE ?");
          params.push(`${options.path}%`);
        }

        const rows = db
          .prepare(
            `
              SELECT
                file_id AS fileId,
                action,
                detected_at AS detectedAt,
                sync_id AS syncId
              FROM vault_changelog
              ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
              ORDER BY detected_at DESC, id DESC
            `,
          )
          .all(...params);

        writeJson({
          changes: rows,
          since: options.since ?? null,
          totalChanges: rows.length,
        });
      } finally {
        db.close();
      }
    });

  vault
    .command("queue")
    .option("--status <status>", "Filter queue items by status")
    .action((options) => {
      const status = normalizeQueueStatus(options.status);
      const snapshot = getVaultQueueSnapshot(process.env, status);
      writeJson(snapshot);
    });
}

import { Command } from "commander";

import { executeServerBackedOperation, requestDaemonJson } from "../daemon/client.js";
import { runSyncCommand, type SyncCommandResult } from "../operations/write.js";
import { writeJson } from "../utils/output.js";

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Incrementally sync wiki pages, embeddings, and vault metadata")
    .option("--path <pagePath>", "Only sync a single wiki page")
    .option("--force", "Force a full rebuild of the index")
    .option("--skip-embedding", "Skip embedding generation")
    .option("--process", "Process vault queue items after sync")
    .option("--vault-file <fileId>", "Only process one vault queue file_id (relative to VAULT_PATH)")
    .action(async (options) => {
      const result = await executeServerBackedOperation<SyncCommandResult>({
        kind: "write",
        local: () =>
          runSyncCommand(process.env, {
            targetPaths: options.path ? [options.path] : undefined,
            force: options.force === true,
            skipEmbedding: options.skipEmbedding === true,
            process: options.process === true,
            vaultFileId: options.vaultFile ?? undefined,
          }),
        remote: (endpoint) =>
          requestDaemonJson<SyncCommandResult>({
            endpoint,
            method: "POST",
            path: "/sync",
            body: {
              path: options.path ?? undefined,
              force: options.force === true,
              skipEmbedding: options.skipEmbedding === true,
              process: options.process === true,
              vaultFileId: options.vaultFile ?? undefined,
            },
          }),
      });
      writeJson(result);
    });
}

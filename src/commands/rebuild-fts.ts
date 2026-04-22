import { Command } from "commander";

import { executeServerBackedOperation, requestDaemonJson } from "../daemon/client.js";
import { buildCliWriteActor } from "../daemon/write-actor.js";
import { rebuildFtsCommand, type RebuildFtsCommandResult } from "../operations/write.js";
import { writeJson } from "../utils/output.js";

export function registerRebuildFtsCommand(program: Command): void {
  program
    .command("rebuild-fts")
    .description("Validate or rebuild the SQLite FTS index")
    .option("--mode <mode>", "Override tokenizer mode for this command (default|simple)")
    .option("--check", "Only inspect FTS drift and metadata without rebuilding")
    .action(async (options) => {
      const result = await executeServerBackedOperation<RebuildFtsCommandResult>({
        kind: options.check === true ? "read" : "write",
        local: () =>
          rebuildFtsCommand(process.env, {
            mode: options.mode ?? undefined,
            check: options.check === true,
          }),
        remote: (endpoint) =>
          options.check === true
            ? requestDaemonJson<RebuildFtsCommandResult>({
                endpoint,
                method: "GET",
                path: "/fts/rebuild",
                query: {
                  check: true,
                  mode: options.mode ?? undefined,
                },
              })
            : requestDaemonJson<RebuildFtsCommandResult>({
                endpoint,
                method: "POST",
                path: "/fts/rebuild",
                body: {
                  actor: buildCliWriteActor(process.env),
                  mode: options.mode ?? undefined,
                },
                timeoutMs: 310_000,
              }),
      });
      writeJson(result);
    });
}

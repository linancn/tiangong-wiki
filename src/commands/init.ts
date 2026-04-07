import { Command } from "commander";
import path from "node:path";

import { resolveRuntimePaths } from "../core/paths.js";
import { EmbeddingClient } from "../core/embedding.js";
import { syncWorkspace } from "../core/sync.js";
import { getWikiAgentStatus } from "../core/vault-processing.js";
import { AppError } from "../utils/errors.js";
import {
  copyDirectoryContentsSync,
  copyFileIfMissingSync,
  ensureDirSync,
  isDirectoryEmptySync,
  pathExistsSync,
} from "../utils/fs.js";
import { spawnDetachedCurrentProcess } from "../utils/process.js";
import { writeJson } from "../utils/output.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize wiki workspace assets and run the first structured sync")
    .option("--force", "Force a full rebuild of the index")
    .action(async (options) => {
      const paths = resolveRuntimePaths(process.env);
      ensureDirSync(paths.wikiRoot);
      ensureDirSync(paths.wikiPath);
      ensureDirSync(paths.templatesPath);

      const defaultConfigPath = path.join(paths.packageRoot, "assets", "wiki.config.default.json");
      const defaultTemplatesPath = path.join(paths.packageRoot, "assets", "templates");

      const copiedConfig = copyFileIfMissingSync(defaultConfigPath, paths.configPath);
      let copiedTemplates = 0;
      if (isDirectoryEmptySync(paths.templatesPath) && pathExistsSync(defaultTemplatesPath)) {
        copyDirectoryContentsSync(defaultTemplatesPath, paths.templatesPath);
        copiedTemplates = 1;
      }

      const structuredSync = await syncWorkspace({
        force: options.force === true,
        skipEmbedding: true,
      });

      let backgroundEmbeddingStarted = false;
      let backgroundPid: number | undefined;
      if (EmbeddingClient.fromEnv(process.env)) {
        backgroundPid = spawnDetachedCurrentProcess(["embed-pending"], { env: process.env });
        backgroundEmbeddingStarted = typeof backgroundPid === "number";
      }

      const wikiAgent = getWikiAgentStatus(process.env);
      if (wikiAgent.enabled && wikiAgent.missing.length > 0) {
        throw new AppError(
          `WIKI_AGENT_ENABLED=true but missing required settings: ${wikiAgent.missing.join(", ")}`,
          "config",
        );
      }

      writeJson({
        initialized: true,
        copiedConfig,
        copiedTemplates,
        sync: structuredSync,
        backgroundEmbeddingStarted,
        ...(backgroundEmbeddingStarted ? { backgroundPid } : {}),
        backgroundQueueProcessingStarted: false,
      });
    });
}

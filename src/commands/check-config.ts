import { Command } from "commander";
import path from "node:path";

import { loadRuntimeConfig } from "../core/runtime.js";
import { EmbeddingClient } from "../core/embedding.js";
import { getWikiAgentStatus } from "../core/vault-processing.js";
import { resolveTemplateFilePath } from "../core/config.js";
import { AppError } from "../utils/errors.js";
import { ensureTextOrJson, formatKeyValueLines, writeJson, writeText } from "../utils/output.js";
import { pathExistsSync } from "../utils/fs.js";

export function registerCheckConfigCommand(program: Command): void {
  program
    .command("check-config")
    .description("Validate environment variables, config, templates, and optionally the embedding endpoint")
    .option("--probe", "Probe the embedding endpoint when configured")
    .option("--format <format>", "Output format: text or json", "text")
    .action(async (options) => {
      const format = ensureTextOrJson(options.format);
      const { paths, config } = loadRuntimeConfig(process.env);
      const embeddingClient = EmbeddingClient.fromEnv(process.env);
      const wikiAgent = getWikiAgentStatus(process.env);
      if (wikiAgent.enabled && wikiAgent.missing.length > 0) {
        throw new AppError(
          `WIKI_AGENT_ENABLED=true but missing required settings: ${wikiAgent.missing.join(", ")}`,
          "config",
        );
      }
      const templateChecks = Object.keys(config.templates).map((pageType) => {
        const templatePath = resolveTemplateFilePath(config, paths.wikiRoot, pageType);
        return {
          pageType,
          templatePath,
          exists: pathExistsSync(templatePath),
        };
      });

      let probe = "skipped";
      if (options.probe && embeddingClient) {
        await embeddingClient.probe();
        probe = "ok";
      } else if (options.probe) {
        probe = "not_configured";
      }

      const payload = {
        wikiPath: paths.wikiPath,
        vaultPath: paths.vaultPath,
        dbPath: paths.dbPath,
        configPath: paths.configPath,
        templatesPath: paths.templatesPath,
        configVersion: config.configVersion,
        embeddingConfigured: embeddingClient !== null,
        agentProcessing: wikiAgent,
        probe,
        templateChecks,
      };

      if (format === "json") {
        writeJson(payload);
        return;
      }

      writeText(
        [
          "wiki check-config",
          formatKeyValueLines({
            wikiPath: paths.wikiPath,
            vaultPath: paths.vaultPath,
            dbPath: paths.dbPath,
            configPath: paths.configPath,
            templatesPath: paths.templatesPath,
            embeddingConfigured: embeddingClient !== null,
            agentEnabled: wikiAgent.enabled,
            agentConfigured: wikiAgent.configured,
            agentBaseUrl: wikiAgent.baseUrl ?? "",
            agentModel: wikiAgent.model ?? "",
            agentBatchSize: wikiAgent.batchSize,
            agentMissing: wikiAgent.missing.join(", "),
            probe,
          }),
          "",
          ...templateChecks.map(
            (entry) =>
              `${entry.exists ? "OK" : "MISSING"} ${entry.pageType} -> ${path.relative(paths.wikiRoot, entry.templatePath)}`,
          ),
        ].join("\n"),
      );
    });
}

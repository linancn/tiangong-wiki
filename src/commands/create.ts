import { Command } from "commander";

import { getTemplate } from "../core/config.js";
import { createPageFromTemplate } from "../core/page-files.js";
import { loadRuntimeConfig } from "../core/runtime.js";
import { syncWorkspace } from "../core/sync.js";
import { writeJson } from "../utils/output.js";

export function registerCreateCommand(program: Command): void {
  program
    .command("create")
    .description("Create a new wiki page from a registered template and index it immediately")
    .requiredOption("--type <pageType>", "Registered pageType")
    .requiredOption("--title <title>", "Page title")
    .option("--node-id <nodeId>", "Optional nodeId")
    .action(async (options) => {
      const { paths, config } = loadRuntimeConfig(process.env);
      const pageType = options.type;
      getTemplate(config, pageType);
      const created = createPageFromTemplate(paths, config, {
        pageType,
        title: options.title,
        nodeId: options.nodeId ?? undefined,
      });
      await syncWorkspace({ targetPaths: [created.pageId] });

      writeJson({
        created: created.pageId,
        filePath: created.filePath,
      });
    });
}

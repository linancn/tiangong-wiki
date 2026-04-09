#!/usr/bin/env node

import { Command } from "commander";

import packageJson from "../package.json" with { type: "json" };
import { registerAssetCommand } from "./commands/asset.js";
import { registerCheckConfigCommand } from "./commands/check-config.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerDashboardCommand } from "./commands/dashboard.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerExportGraphCommand } from "./commands/export-graph.js";
import { registerExportIndexCommand } from "./commands/export-index.js";
import { registerFindCommand } from "./commands/find.js";
import { registerFtsCommand } from "./commands/fts.js";
import { registerGraphCommand } from "./commands/graph.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLintCommand } from "./commands/lint.js";
import { registerListCommand } from "./commands/list.js";
import { registerPageInfoCommand } from "./commands/page-info.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStatCommand } from "./commands/stat.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerTemplateCommand } from "./commands/template.js";
import { registerTypeCommand } from "./commands/type.js";
import { registerVaultCommand } from "./commands/vault.js";
import { applyCliEnvironment } from "./core/cli-env.js";
import { loadRuntimeConfig } from "./core/runtime.js";
import { embedPendingPages } from "./core/sync.js";
import { processVaultQueueBatch } from "./core/vault-processing.js";
import { handleCliError, writeJson } from "./utils/output.js";

function buildProgram(): Command {
  const program = new Command();
  program
    .name("tiangong-wiki")
    .description("Tiangong Wiki — local-first indexing and query CLI")
    .version(packageJson.version)
    .showHelpAfterError();

  let runtimeConfig;
  try {
    runtimeConfig = loadRuntimeConfig(process.env).config;
  } catch {
    runtimeConfig = undefined;
  }

  registerSetupCommand(program);
  registerInitCommand(program);
  registerDoctorCommand(program);
  registerSyncCommand(program);
  registerCheckConfigCommand(program);
  registerAssetCommand(program);
  registerFindCommand(program, runtimeConfig);
  registerSearchCommand(program);
  registerFtsCommand(program);
  registerGraphCommand(program);
  registerPageInfoCommand(program);
  registerListCommand(program);
  registerStatCommand(program);
  registerCreateCommand(program);
  registerTemplateCommand(program);
  registerTypeCommand(program);
  registerVaultCommand(program);
  registerLintCommand(program);
  registerExportGraphCommand(program);
  registerExportIndexCommand(program);
  registerDaemonCommand(program);
  registerDashboardCommand(program);

  program
    .command("embed-pending", { hidden: true })
    .description("Internal background embedding worker")
    .action(async () => {
      await embedPendingPages(process.env);
    });

  program
    .command("process-vault-queue", { hidden: true })
    .description("Internal background vault queue worker")
    .action(async () => {
      writeJson(await processVaultQueueBatch(process.env));
    });

  return program;
}

try {
  applyCliEnvironment(process.env, process.cwd());
  const program = buildProgram();
  await program.parseAsync(process.argv);
} catch (error) {
  handleCliError(error);
}

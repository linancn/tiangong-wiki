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
import { registerRebuildFtsCommand } from "./commands/rebuild-fts.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerSkillCommand } from "./commands/skill.js";
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

function extractEnvFileOption(argv: string[]): { envFile: string | null; argv: string[] } {
  const nextArgv = argv.slice(0, 2);
  let envFile: string | null = null;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--env-file requires a value");
      }
      envFile = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--env-file=")) {
      const value = arg.slice("--env-file=".length);
      if (!value) {
        throw new Error("--env-file requires a value");
      }
      envFile = value;
      continue;
    }

    nextArgv.push(arg);
  }

  return { envFile, argv: nextArgv };
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("tiangong-wiki")
    .description("Tiangong Wiki — local-first indexing and query CLI")
    .version(packageJson.version)
    .option("--env-file <path>", "Load runtime environment from a specific .wiki.env file")
    .showHelpAfterError();

  let runtimeConfig;
  try {
    runtimeConfig = loadRuntimeConfig(process.env).config;
  } catch {
    runtimeConfig = undefined;
  }

  registerSetupCommand(program);
  registerSkillCommand(program);
  registerInitCommand(program);
  registerDoctorCommand(program);
  registerSyncCommand(program);
  registerCheckConfigCommand(program);
  registerAssetCommand(program);
  registerFindCommand(program, runtimeConfig);
  registerSearchCommand(program);
  registerFtsCommand(program);
  registerRebuildFtsCommand(program);
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
  const { envFile, argv } = extractEnvFileOption(process.argv);
  if (envFile) {
    process.env.WIKI_ENV_FILE = envFile;
  }
  applyCliEnvironment(process.env, process.cwd());
  const program = buildProgram();
  await program.parseAsync(argv);
} catch (error) {
  handleCliError(error);
}

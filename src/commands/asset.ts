import { Command } from "commander";

import { refAsset, saveAsset } from "../operations/asset.js";
import { writeJson } from "../utils/output.js";

export function registerAssetCommand(program: Command): void {
  const asset = program.command("asset").description("Manage wiki assets (images, files)");

  asset
    .command("save <source-file>")
    .description("Save a file to wiki assets directory")
    .option("--name <slug>", "Target filename in kebab-case, without extension")
    .option("--type <asset-type>", "Asset type (determines subdirectory)", "image")
    .action(async (sourceFile: string, options: { name?: string; type?: string }) => {
      writeJson(saveAsset(process.env, sourceFile, options));
    });

  asset
    .command("ref <asset-path-or-name>")
    .description("Compute relative path from a page to an asset")
    .requiredOption("--page <page-id>", "Page ID that will reference this asset")
    .option("--type <asset-type>", "Asset type (determines lookup directory)", "image")
    .action(async (assetPathOrName: string, options: { page: string; type?: string }) => {
      writeJson(refAsset(process.env, assetPathOrName, options));
    });
}

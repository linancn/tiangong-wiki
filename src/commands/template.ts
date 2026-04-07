import { Command } from "commander";
import matter from "gray-matter";
import path from "node:path";

import { loadRuntimeConfig } from "../core/runtime.js";
import { ensureTextOrJson, writeJson, writeText } from "../utils/output.js";
import { ensureDirSync, pathExistsSync, readTextFileSync, writeTextFileSync } from "../utils/fs.js";
import { AppError } from "../utils/errors.js";

function templateSkeleton(pageType: string, title: string): string {
  return matter.stringify(
    [
      "## Summary",
      "",
      "- Add a concise overview.",
      "",
      "## Details",
      "",
      "- Expand the template fields and sections for this page type.",
    ].join("\n"),
    {
      pageType,
      title,
      nodeId: "",
      status: "draft",
      visibility: "private",
      sourceRefs: [],
      relatedPages: [],
      tags: [],
      createdAt: "2026-04-06",
      updatedAt: "2026-04-06",
    },
  );
}

export function registerTemplateCommand(program: Command): void {
  const template = program.command("template").description("List, show, or create wiki templates");

  template
    .command("list")
    .option("--format <format>", "Output format: text or json", "text")
    .action((options) => {
      const format = ensureTextOrJson(options.format);
      const { paths, config } = loadRuntimeConfig(process.env);
      const payload = Object.entries(config.templates).map(([pageType, definition]) => ({
        pageType,
        file: definition.file,
        filePath: path.resolve(paths.wikiRoot, definition.file),
      }));

      if (format === "json") {
        writeJson(payload);
        return;
      }

      writeText(payload.map((entry) => `${entry.pageType} -> ${entry.file}`).join("\n"));
    });

  template
    .command("show")
    .argument("<pageType>", "Registered pageType")
    .option("--format <format>", "Output format: text or json", "text")
    .action((pageType, options) => {
      const format = ensureTextOrJson(options.format);
      const { paths, config } = loadRuntimeConfig(process.env);
      const templateConfig = config.templates[pageType];
      if (!templateConfig) {
        throw new AppError(`Unknown template: ${pageType}`, "not_found");
      }

      const filePath = path.resolve(paths.wikiRoot, templateConfig.file);
      const content = readTextFileSync(filePath);
      if (format === "json") {
        writeJson({ pageType, filePath, content });
        return;
      }

      writeText(content);
    });

  template
    .command("create")
    .requiredOption("--type <pageType>", "New pageType")
    .requiredOption("--title <title>", "Human title used inside the template frontmatter")
    .action((options) => {
      const { paths, config } = loadRuntimeConfig(process.env);
      if (config.templates[options.type]) {
        throw new AppError(`Template already exists: ${options.type}`, "config");
      }

      const templateRelativePath = path.join("templates", `${options.type}.md`).split(path.sep).join("/");
      const templatePath = path.resolve(paths.wikiRoot, templateRelativePath);
      ensureDirSync(path.dirname(templatePath));
      if (pathExistsSync(templatePath)) {
        throw new AppError(`Template file already exists: ${templatePath}`, "config");
      }

      writeTextFileSync(templatePath, templateSkeleton(options.type, options.title));

      const updatedConfig = {
        schemaVersion: config.schemaVersion,
        customColumns: config.customColumns,
        defaultSummaryFields: config.defaultSummaryFields,
        commonEdges: config.commonEdges,
        templates: {
          ...config.templates,
          [options.type]: {
            file: templateRelativePath,
            columns: {},
            edges: {},
            summaryFields: [],
          },
        },
      };

      writeTextFileSync(paths.configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`);

      writeJson({
        pageType: options.type,
        templatePath,
        configPath: paths.configPath,
      });
    });
}

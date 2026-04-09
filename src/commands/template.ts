import { Command } from "commander";

import { executeServerBackedOperation, requestDaemonJson } from "../daemon/client.js";
import { renderTemplateLintResult, runTemplateLint } from "../operations/template-lint.js";
import { createTemplate, listTemplates, showTemplate } from "../operations/type-template.js";
import { ensureTextOrJson, writeJson, writeText } from "../utils/output.js";

export function registerTemplateCommand(program: Command): void {
  const template = program.command("template").description("List, show, or create wiki templates");

  template
    .command("list")
    .option("--format <format>", "Output format: text or json", "text")
    .action(async (options) => {
      const format = ensureTextOrJson(options.format);
      const payload = await executeServerBackedOperation({
        kind: "read",
        local: () => listTemplates(process.env),
        remote: (endpoint) =>
          requestDaemonJson({
            endpoint,
            method: "GET",
            path: "/template/list",
          }),
      });

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
    .action(async (pageType, options) => {
      const format = ensureTextOrJson(options.format);
      const payload = await executeServerBackedOperation({
        kind: "read",
        local: () => showTemplate(process.env, pageType),
        remote: (endpoint) =>
          requestDaemonJson({
            endpoint,
            method: "GET",
            path: "/template/show",
            query: { pageType },
          }),
      });
      if (format === "json") {
        writeJson(payload);
        return;
      }

      writeText(String(payload.content ?? ""));
    });

  template
    .command("lint")
    .argument("[pageType]", "Optional pageType to lint")
    .option("--level <level>", "error, warning, or info", "info")
    .option("--format <format>", "Output format: text or json", "text")
    .action(async (pageType, options) => {
      const format = ensureTextOrJson(options.format);
      const payload = await executeServerBackedOperation({
        kind: "read",
        local: () =>
          runTemplateLint(process.env, {
            pageType: typeof pageType === "string" ? pageType : undefined,
            level: options.level ?? undefined,
          }),
        remote: (endpoint) =>
          requestDaemonJson({
            endpoint,
            method: "GET",
            path: "/template/lint",
            query: {
              pageType: typeof pageType === "string" ? pageType : undefined,
              level: options.level ?? undefined,
            },
          }),
      });

      if (format === "json") {
        writeJson(payload);
        return;
      }

      writeText(renderTemplateLintResult(payload));
    });

  template
    .command("create")
    .requiredOption("--type <pageType>", "New pageType")
    .requiredOption("--title <title>", "Human title used inside the template frontmatter")
    .action(async (options) => {
      const payload = await executeServerBackedOperation({
        kind: "write",
        local: () =>
          Promise.resolve(
            createTemplate(process.env, {
              type: options.type,
              title: options.title,
            }),
          ),
        remote: (endpoint) =>
          requestDaemonJson({
            endpoint,
            method: "POST",
            path: "/template/create",
            body: {
              type: options.type,
              title: options.title,
            },
          }),
      });
      writeJson(payload);
    });
}

import path from "node:path";
import { writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupWorkspace,
  createWorkspace,
  readFile,
  runCli,
  runCliJson,
  updateWikiConfig,
} from "../helpers.js";

describe("template lint", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("passes for the default templates", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    runCli(["init"], workspace.env);

    const lint = runCliJson<{
      errors: Array<unknown>;
      warnings: Array<unknown>;
      info: Array<unknown>;
      summary: { templates: number; errors: number; warnings: number; info: number };
    }>(["template", "lint", "--format", "json"], workspace.env);

    expect(lint.errors).toEqual([]);
    expect(lint.warnings).toEqual([]);
    expect(lint.info).toEqual([]);
    expect(lint.summary.templates).toBe(11);
    expect(lint.summary.errors).toBe(0);
    expect(lint.summary.warnings).toBe(0);
    expect(lint.summary.info).toBe(0);
  });

  it("reports schema drift between template frontmatter and config declarations", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    runCli(["init"], workspace.env);

    const methodTemplatePath = path.join(workspace.wikiRoot, "templates", "method.md");
    const mutatedTemplate = readFile(methodTemplatePath)
      .replace(/applicableTo: \[\]\r?\n/, "surpriseField: yes\n")
      .replace(/\r?\n## /g, "\n### ");
    writeFileSync(methodTemplatePath, mutatedTemplate, "utf8");

    updateWikiConfig(workspace, (config) => {
      const templates = config.templates as Record<string, any>;
      templates.method = {
        ...templates.method,
        summaryFields: [...templates.method.summaryFields, "ghostField"],
      };
      return config;
    });

    const lint = runCliJson<{
      errors: Array<{ pageType: string; check: string; message: string }>;
      warnings: Array<{ pageType: string; check: string; message: string }>;
      summary: { templates: number; errors: number; warnings: number };
    }>(["template", "lint", "method", "--format", "json"], workspace.env);

    expect(lint.summary.templates).toBe(1);
    expect(lint.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageType: "method",
          check: "unregistered_template_fields",
          message: expect.stringContaining("surpriseField"),
        }),
        expect.objectContaining({
          pageType: "method",
          check: "summary_fields_unregistered",
          message: expect.stringContaining("ghostField"),
        }),
      ]),
    );
    expect(lint.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageType: "method",
          check: "declared_fields_missing",
          message: expect.stringContaining("applicableTo"),
        }),
        expect.objectContaining({
          pageType: "method",
          check: "body_sections_min",
        }),
      ]),
    );
  });
});

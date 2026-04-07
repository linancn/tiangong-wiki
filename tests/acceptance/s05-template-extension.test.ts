import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  readFile,
  runCliJson,
  updateWikiConfig,
} from "../helpers.js";

describe("acceptance: S5 template extension", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("registers a new page type through template files and config without code changes", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    runCliJson(["init"], workspace.env);

    const createdTemplate = runCliJson<{ pageType: string; templatePath: string; configPath: string }>(
      ["template", "create", "--type", "lab-report", "--title", "实验报告"],
      workspace.env,
    );
    expect(createdTemplate.pageType).toBe("lab-report");
    expect(readFile(createdTemplate.configPath)).toContain("\"lab-report\"");

    const templateList = runCliJson<Array<{ pageType: string }>>(
      ["template", "list", "--format", "json"],
      workspace.env,
    );
    expect(templateList).toHaveLength(12);
    expect(templateList.map((item) => item.pageType)).toContain("lab-report");

    updateWikiConfig(workspace, (config) => {
      const templates = config.templates as Record<string, any>;
      templates["lab-report"] = {
        ...templates["lab-report"],
        columns: {
          experimentId: "text",
        },
        summaryFields: ["experimentId"],
      };
      return config;
    });

    const templateContent = `---
pageType: lab-report
title: 实验报告
nodeId: lab-report
status: draft
visibility: private
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
experimentId:
---

## 实验目标

说明这次实验要验证什么。

## 实验步骤

按顺序记录关键步骤与输入条件。

## 观察结果

记录结果数据、异常和现象。

## 结论

总结这次实验给出的结论与下一步动作。
`;
    const templatePath = createdTemplate.templatePath;
    expect(readFile(templatePath)).toContain("## Summary");

    // Overwrite the generated skeleton with a custom template body.
    expect(templatePath.endsWith("lab-report.md")).toBe(true);
    writeFileSync(templatePath, templateContent, "utf8");

    const page = runCliJson<{ created: string }>(
      ["create", "--type", "lab-report", "--title", "第一次实验报告"],
      workspace.env,
    );
    expect(page.created.startsWith("lab-reports/")).toBe(true);

    runCliJson(["sync"], workspace.env);

    const found = runCliJson<Array<{ id: string; pageType: string }>>(
      ["find", "--type", "lab-report"],
      workspace.env,
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: page.created,
          pageType: "lab-report",
        }),
      ]),
    );
  });
});

import matter from "gray-matter";
import path from "node:path";

import { getTemplate, resolveTemplateFilePath } from "./config.js";
import type { LoadedWikiConfig } from "../types/config.js";
import type { RuntimePaths } from "../types/page.js";
import { AppError } from "../utils/errors.js";
import { ensureDirSync, pathExistsSync, readTextFileSync, writeTextFileSync } from "../utils/fs.js";
import { slugify } from "../utils/slug.js";
import { toDateOnly } from "../utils/time.js";

export const PAGE_TYPE_DIRS: Record<string, string> = {
  concept: "concepts",
  misconception: "misconceptions",
  bridge: "bridges",
  "source-summary": "source-summaries",
  lesson: "lessons",
  method: "methods",
  person: "people",
  achievement: "achievements",
  resume: "resumes",
  "research-note": "research-notes",
  faq: "faqs",
};

function makeUniquePagePath(baseDir: string, slug: string): string {
  let candidate = path.join(baseDir, `${slug}.md`);
  let counter = 2;
  while (pathExistsSync(candidate)) {
    candidate = path.join(baseDir, `${slug}-${counter}.md`);
    counter += 1;
  }
  return candidate;
}

function normalizeFrontmatterArrays(
  patch: Record<string, unknown>,
  templateData: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sourceRefs: patch.sourceRefs ?? templateData.sourceRefs ?? [],
    relatedPages: patch.relatedPages ?? templateData.relatedPages ?? [],
    tags: patch.tags ?? templateData.tags ?? [],
  };
}

export function createPageFromTemplate(
  paths: RuntimePaths,
  config: LoadedWikiConfig,
  options: {
    pageType: string;
    title: string;
    nodeId?: string | null;
    frontmatterPatch?: Record<string, unknown>;
    bodyMarkdown?: string;
  },
): { pageId: string; filePath: string } {
  const { pageType, title } = options;
  getTemplate(config, pageType);

  const templatePath = resolveTemplateFilePath(config, paths.wikiRoot, pageType);
  if (!pathExistsSync(templatePath)) {
    throw new AppError(`Template file not found: ${templatePath}`, "not_found");
  }

  const template = matter(readTextFileSync(templatePath));
  const slug = slugify(title);
  const targetDir = path.join(paths.wikiPath, PAGE_TYPE_DIRS[pageType] ?? `${pageType}s`);
  ensureDirSync(targetDir);
  const filePath = makeUniquePagePath(targetDir, slug);
  const pageId = path.relative(paths.wikiPath, filePath).split(path.sep).join("/");
  const today = toDateOnly();
  const patch = options.frontmatterPatch ?? {};
  const templateData = (template.data ?? {}) as Record<string, unknown>;

  const data = {
    ...templateData,
    ...patch,
    pageType,
    title,
    nodeId:
      options.nodeId !== undefined
        ? options.nodeId
        : patch.nodeId !== undefined
          ? patch.nodeId
          : slug,
    status: patch.status ?? templateData.status ?? "draft",
    visibility: patch.visibility ?? templateData.visibility ?? "private",
    ...normalizeFrontmatterArrays(patch, templateData),
    createdAt: patch.createdAt ?? templateData.createdAt ?? today,
    updatedAt: patch.updatedAt ?? templateData.updatedAt ?? today,
  };

  const output = matter.stringify(options.bodyMarkdown ?? template.content, data);
  writeTextFileSync(filePath, output);
  return { pageId, filePath };
}

export function updatePageById(
  paths: RuntimePaths,
  pageId: string,
  options: {
    frontmatterPatch?: Record<string, unknown>;
    bodyMarkdown?: string;
  },
): { pageId: string; filePath: string } {
  const filePath = path.join(paths.wikiPath, ...pageId.split("/"));
  if (!pathExistsSync(filePath)) {
    throw new AppError(`Page file not found: ${pageId}`, "not_found");
  }

  const existing = matter(readTextFileSync(filePath));
  const patch = options.frontmatterPatch ?? {};
  const currentData = (existing.data ?? {}) as Record<string, unknown>;
  const today = toDateOnly();
  const nextData = {
    ...currentData,
    ...patch,
    ...normalizeFrontmatterArrays(patch, currentData),
    updatedAt: patch.updatedAt ?? today,
  };

  const output = matter.stringify(options.bodyMarkdown ?? existing.content, nextData);
  writeTextFileSync(filePath, output);
  return { pageId, filePath };
}

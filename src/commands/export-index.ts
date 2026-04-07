import { Command } from "commander";

import { openRuntimeDb } from "../core/runtime.js";
import { readAllPages } from "../core/sync.js";
import { writeText } from "../utils/output.js";
import { writeTextFileSync } from "../utils/fs.js";
import { toOffsetIso } from "../utils/time.js";
import { AppError } from "../utils/errors.js";

function renderGroup(title: string, pages: ReturnType<typeof readAllPages>): string {
  if (pages.length === 0) {
    return `## ${title}\n`;
  }

  return [
    `## ${title} (${pages.length})`,
    "",
    ...pages.map((page) => {
      const tagText = page.tags.length > 0 ? `, tags: ${page.tags.join(", ")}` : "";
      return `- [${page.title}](${page.id}) — ${page.status}${tagText}`;
    }),
    "",
  ].join("\n");
}

export function registerExportIndexCommand(program: Command): void {
  program
    .command("export-index")
    .description("Export a human-readable Markdown index of pages")
    .option("--output <filePath>", "Write Markdown output to a file")
    .option("--group-by <mode>", "Group by pageType or tags", "pageType")
    .action((options) => {
      const { db } = openRuntimeDb(process.env);
      try {
        const pages = readAllPages(db);
        const groupBy = options.groupBy ?? "pageType";
        if (!["pageType", "tags"].includes(groupBy)) {
          throw new AppError(`Unsupported --group-by value: ${groupBy}`, "config");
        }

        const edgeCountRow = db.prepare("SELECT COUNT(*) AS count FROM edges").get() as { count: number };
        const groups = new Map<string, typeof pages>();
        if (groupBy === "pageType") {
          for (const page of pages) {
            const group = groups.get(page.pageType) ?? [];
            group.push(page);
            groups.set(page.pageType, group);
          }
        } else {
          for (const page of pages) {
            const tags = page.tags.length > 0 ? page.tags : ["untagged"];
            for (const tag of tags) {
              const group = groups.get(tag) ?? [];
              group.push(page);
              groups.set(tag, group);
            }
          }
        }

        const content = [
          "# Wiki Index",
          "",
          `Generated: ${toOffsetIso()} | ${pages.length} pages | ${edgeCountRow.count} edges`,
          "",
          ...[...groups.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([title, groupPages]) => renderGroup(title, groupPages)),
        ].join("\n");

        if (options.output) {
          writeTextFileSync(options.output, `${content}\n`);
        }

        writeText(content);
      } finally {
        db.close();
      }
    });
}

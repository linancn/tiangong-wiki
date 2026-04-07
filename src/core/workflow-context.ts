import { chmodSync } from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../types/page.js";
import { ensureDirSync, writeTextFileSync } from "../utils/fs.js";
import { sha256Text } from "../utils/fs.js";

export interface WorkflowArtifactSet {
  queueItemId: string;
  artifactId: string;
  rootDir: string;
  queueItemPath: string;
  promptPath: string;
  resultPath: string;
  skillArtifactsPath: string;
}

export interface VaultWorkflowPromptInput {
  workspaceRoot: string;
  packageRoot: string;
  vaultFilePath: string;
  resultJsonPath: string;
  allowTemplateEvolution: boolean;
}

function readableArtifactPrefix(queueItemId: string): string {
  const normalized = queueItemId
    .replace(/[\\/]+/g, "__")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "queue-item";
  }
  return normalized.slice(0, 80);
}

export function toWorkflowArtifactId(queueItemId: string): string {
  return `${readableArtifactPrefix(queueItemId)}--${sha256Text(queueItemId).slice(0, 12)}`;
}

export function getWorkflowArtifactSet(paths: RuntimePaths, queueItemId: string): WorkflowArtifactSet {
  const artifactId = toWorkflowArtifactId(queueItemId);
  const rootDir = path.join(paths.queueArtifactsPath, artifactId);
  return {
    queueItemId,
    artifactId,
    rootDir,
    queueItemPath: path.join(rootDir, "queue-item.json"),
    promptPath: path.join(rootDir, "prompt.md"),
    resultPath: path.join(rootDir, "result.json"),
    skillArtifactsPath: path.join(rootDir, "skill-artifacts"),
  };
}

export function buildVaultWorkflowPrompt(input: VaultWorkflowPromptInput): string {
  return [
    "Process one vault queue item.",
    "",
    `WORKSPACE_ROOT=${input.workspaceRoot}`,
    `SKILL_PACKAGE_ROOT=${input.packageRoot}`,
    `VAULT_FILE_PATH=${input.vaultFilePath}`,
    `RESULT_JSON_PATH=${input.resultJsonPath}`,
    `ALLOW_TEMPLATE_EVOLUTION=${input.allowTemplateEvolution ? "true" : "false"}`,
    "",
    "A wiki CLI wrapper is already available on PATH for this run.",
    "Read queue-item.json next to RESULT_JSON_PATH before acting.",
    "Then read only the target vault file and the minimum wiki CLI outputs needed for a decision.",
    "If you need the task contract, read SKILL_PACKAGE_ROOT/references/vault-to-wiki-instruction.md.",
    "If you need CLI details, read SKILL_PACKAGE_ROOT/references/cli-interface.md.",
    "Use installed skills only as needed.",
    "Keep the run narrowly focused on the target vault file, the current ontology, and the best candidate pages.",
    "Do not inspect the whole workspace, list broad file trees, or read large reference files unless a concrete command failure blocks you.",
    "Do not call wiki --help; prefer targeted commands, or wiki <command> --help only when a specific command is unclear.",
    "Use only the supported CLI surface: wiki type list --format json, wiki type show <type> --format json, wiki type recommend --text <summary> --keywords <a,b> --format json, wiki find, wiki fts <query>, wiki page-info <pageId>, wiki sync --path <page>, wiki lint --path <page> --format json.",
    "Do not use guessed commands such as wiki page find or wiki page list. wiki find and wiki list already emit JSON; do not add --format json to them.",
    "Do not assume any current wiki type, template, or default target type.",
    "Discover the current ontology and relevant existing pages through the wiki CLI before making changes.",
    "If the vault file clearly revises an existing page, prefer the smallest in-place update that preserves provenance.",
    "Use source-summary only when the source itself deserves a reusable standalone page; revision notes usually do not.",
    "Start with likely existing pages before using type recommendation. Use wiki type recommend only when the target type is still unclear.",
    "Do not put raw vault file paths into sourceRefs. sourceRefs may only contain existing wiki page ids; keep raw file provenance in the page body or a dedicated source field such as vaultPath when that type supports it.",
    "For every changed page, run wiki sync --path <page> and wiki lint --path <page> --format json before finishing.",
    "The authoritative threadId is queue-item.json.threadId. Read it from there and copy it unchanged into result.json.threadId. If it is empty on first read, read queue-item.json again immediately before writing the manifest.",
    "Write RESULT_JSON_PATH as one JSON object with: status, decision, reason, threadId, skillsUsed, createdPageIds, updatedPageIds, appliedTypeNames, proposedTypes, actions, lint.",
    "Allowed status values only: done, skipped, error. Use done for successful apply or propose_only runs, skipped for skip, and error only when the workflow itself failed. Never use success, completed, failed, or other aliases.",
    "Allowed decision values only: apply, skip, propose_only. Never use update_existing, create_new, update, create, or other aliases.",
    "actions must be an array of objects, never strings. Allowed action kinds only: create_page, update_page, create_template.",
    "Every action object must include kind and summary. create_page requires pageType and title. update_page requires pageId. create_template requires pageType and title.",
    "proposedTypes entries must be objects with name, reason, suggestedTemplateSections. lint entries must be objects with pageId, errors, warnings.",
    'Example RESULT_JSON_PATH: {"status":"done","decision":"apply","reason":"Updated the existing method.","threadId":"<copy queue-item.json.threadId>","skillsUsed":["wiki-skill"],"createdPageIds":[],"updatedPageIds":["methods/example.md"],"appliedTypeNames":["method"],"proposedTypes":[],"actions":[{"kind":"update_page","pageId":"methods/example.md","pageType":"method","summary":"Updated the page with durable knowledge."}],"lint":[{"pageId":"methods/example.md","errors":0,"warnings":0}]}',
    "If no page change is justified, still write RESULT_JSON_PATH with decision=skip or decision=propose_only and then stop.",
    "Use RESULT_JSON_PATH only for the final structured manifest. Write raw JSON only, with no Markdown fences and no prose before or after the JSON object.",
    "The queue item metadata is stored next to RESULT_JSON_PATH as queue-item.json.",
    "Stop immediately after RESULT_JSON_PATH is fully written.",
  ].join("\n");
}

export function ensureWorkflowArtifactSet(
  paths: RuntimePaths,
  input: {
    queueItemId: string;
    queueItem: Record<string, unknown>;
    promptMarkdown?: string;
  },
): WorkflowArtifactSet {
  const artifacts = getWorkflowArtifactSet(paths, input.queueItemId);
  ensureDirSync(paths.queueArtifactsPath);
  ensureDirSync(artifacts.rootDir);
  ensureDirSync(artifacts.skillArtifactsPath);

  const wikiCliWrapperPath = path.join(artifacts.skillArtifactsPath, "wiki");
  writeTextFileSync(artifacts.queueItemPath, `${JSON.stringify(input.queueItem, null, 2)}\n`);
  writeTextFileSync(
    wikiCliWrapperPath,
    [
      "#!/bin/sh",
      'wrapper_path=${WIKI_CLI_WRAPPER:-$0}',
      'wrapper_dir=${wrapper_path%/*}',
      'if [ "$wrapper_dir" = "$wrapper_path" ]; then',
      '  wrapper_dir=.',
      "fi",
      "original_ifs=$IFS",
      "IFS=:",
      'clean_path=""',
      "for entry in $PATH; do",
      '  if [ "$entry" = "$wrapper_dir" ]; then',
      "    continue",
      "  fi",
      '  if [ -z "$clean_path" ]; then',
      "    clean_path=$entry",
      "  else",
      '    clean_path="${clean_path}:$entry"',
      "  fi",
      "done",
      "IFS=$original_ifs",
      "PATH=$clean_path",
      "export PATH",
      'if ! command -v wiki >/dev/null 2>&1; then',
      '  echo "wiki CLI not found on PATH after removing wrapper directory: ${wrapper_dir}" >&2',
      "  exit 127",
      "fi",
      'exec wiki "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(wikiCliWrapperPath, 0o755);
  writeTextFileSync(
    artifacts.promptPath,
    input.promptMarkdown ??
      [
        "# Vault To Wiki Workflow",
        "",
        "This prompt is intentionally minimal and will be populated by the workflow runner.",
      ].join("\n"),
  );
  writeTextFileSync(artifacts.resultPath, "");

  return artifacts;
}

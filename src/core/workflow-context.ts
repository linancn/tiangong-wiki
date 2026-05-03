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
  vaultFilePath: string;
  resultJsonPath: string;
  allowTemplateEvolution: boolean;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveNodeExecutable(): string {
  const currentExec = path.basename(process.execPath).toLowerCase();
  if (currentExec === "node" || currentExec.startsWith("node")) {
    return process.execPath;
  }

  const npmNodeExecPath = process.env.npm_node_execpath?.trim();
  if (npmNodeExecPath) {
    return npmNodeExecPath;
  }

  return "node";
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
    `VAULT_FILE_PATH=${input.vaultFilePath}`,
    `RESULT_JSON_PATH=${input.resultJsonPath}`,
    `ALLOW_TEMPLATE_EVOLUTION=${input.allowTemplateEvolution ? "true" : "false"}`,
    "",
    "## Goal",
    "",
    "Extract reusable, high-value information units from a vault file and express them as wiki pages. The wiki is a knowledge base, not a notebook. Every page must earn its place by being independently useful for retrieval, graph traversal, or downstream reuse. If a source contains nothing worth extracting, skip it.",
    "",
    "## Environment",
    "",
    "Workspace-local skills are available from WORKSPACE_ROOT through normal Codex skill discovery.",
    "A local tiangong-wiki CLI launcher is already available on PATH for this run.",
    "On Windows native shells, use `tiangong-wiki.cmd` instead of the suffixless `tiangong-wiki` command.",
    "",
    "The tiangong-wiki CLI provides these discovery and search capabilities:",
    "- `tiangong-wiki type list` / `tiangong-wiki type show <type>` — discover registered page types and their purpose",
    "- `tiangong-wiki template show <type>` — see the exact frontmatter fields and body structure for a type",
    "- `tiangong-wiki find [options]` — find pages by structured metadata filters",
    "- `tiangong-wiki search <query>` — semantic search over page summary embeddings",
    "- `tiangong-wiki fts <query>` — full-text search over title, tags, and summary",
    "- `tiangong-wiki list [options]` — list existing wiki pages",
    "- `tiangong-wiki page-info <pageId>` — show full metadata and edges for one page",
    "- `tiangong-wiki graph <root>` — traverse the wiki knowledge graph",
    "- `tiangong-wiki stat` — show aggregate wiki index statistics",
    "- `tiangong-wiki asset save <source-file> [--name <slug>]` — save an image to wiki assets, returns the asset path",
    "- `tiangong-wiki asset ref <name-or-path> --page <page-id>` — compute the relative path from a page to an asset for markdown references",
    "",
    "Use whichever combination you judge necessary. These are tools at your disposal, not a mandatory checklist.",
    "",
    "## Step 1 — Read and Discover",
    "",
    "1. Read queue-item.json next to RESULT_JSON_PATH.",
    "2. Read the target vault file at VAULT_FILE_PATH. Refer to `references/vault-to-wiki-instruction.md` (Phase 1) in the wiki package for file-type-specific reading strategies, parser skill discovery, image handling, and metadata utilization.",
    "3. Discover the current page type ontology via `tiangong-wiki type list` and `tiangong-wiki type show <type>`. Do not assume any type, template, or default target type.",
    "4. Search the existing wiki for overlapping or related content:",
    "   - Use `tiangong-wiki fts` and `tiangong-wiki search` with key terms from the source.",
    "   - For each candidate hit, use `tiangong-wiki page-info` to understand its scope, type, and current edges.",
    "   - Determine: does this source reinforce, extend, contradict, or have no overlap with existing pages?",
    "",
    "These questions must be answered before proceeding to Step 2.",
    "",
    "Keep the run narrowly focused on the target vault file, the current ontology, and the best candidate pages.",
    "Do not inspect the whole workspace, list broad file trees, or read large reference files unless a concrete command failure blocks you.",
    "Do not call tiangong-wiki --help or perform broad discovery unless a specific command failure forces it.",
    "",
    "## Step 2 — Decide",
    "",
    "### 2a. Identify Information Units",
    "",
    "Before choosing any type, decompose the source into independently reusable information units. An information unit is a concept, method, lesson, pattern, insight, person profile, achievement, or any other piece of information that has standalone value.",
    "",
    "Ask for each candidate unit:",
    "- Can it be understood and reused without reading the original source?",
    "- Would someone searching the wiki benefit from finding this as a standalone page?",
    "- Is it specific enough to have a single clear topic?",
    "",
    "If the answer to any of these is no, the unit is not worth extracting. If the entire source yields zero extractable units, set decision=skip.",
    "",
    "### 2b. Type Selection",
    "",
    "For each information unit, select the page type that best captures its nature:",
    "1. Run `tiangong-wiki type list` and understand the purpose of each registered type.",
    "2. Match the unit to the type whose semantic intent fits best. Consult `tiangong-wiki template show <type>` to verify the template structure supports the content you want to express.",
    "3. You must be able to articulate why this type fits. If you find yourself choosing a type simply because it is the easiest to fill, reconsider.",
    "",
    "### 2c. Update vs Create vs Skip",
    "",
    "For each information unit, search the wiki (Step 1 results) and decide:",
    "- **Update**: An existing page already covers this topic. Add new information, correct outdated content, or enrich it. Preserve existing valid content.",
    "- **Create**: No existing page covers this topic. Create a new page.",
    "- **Skip**: An existing page already fully covers this content with equal or better quality. Do not duplicate.",
    "",
    "### 2d. Page Granularity and Splitting",
    "",
    "Each page should have a single, clear core topic and express it completely.",
    "- Aim for roughly 1000 words or fewer per page body. This is a guideline, not a hard limit, but if a page grows significantly beyond this, it likely covers more than one topic and should be split.",
    "- A single vault source may produce multiple pages when it contains multiple independent information units. At most 5 pages per vault source.",
    "- When splitting, each resulting page must independently satisfy the information unit criteria above.",
    "- If a new vault source is complex, split it into multiple pages. Each split page still goes through the update-vs-create check above.",
    "",
    "### 2e. Building Relations",
    "",
    "Relations are how the knowledge graph gains structure and navigability.",
    "",
    "Priority order for choosing relation types:",
    "1. **Type-specific edges** (e.g., prerequisites, correctedConcepts, fromConcepts/toConcepts, bridges_from/bridges_to): Use these whenever the relationship matches the semantic intent defined by the type schema. Discover available edges via `tiangong-wiki template show <type>`.",
    "2. **sourceRefs** (edgeType: sourced_from): Records wiki-internal knowledge dependency. Use when the new page's content builds upon, extends, synthesizes, or is derived from existing wiki pages. This is the primary mechanism for knowledge lineage within the wiki. Do not put vault paths into sourceRefs — that is what vaultPath is for.",
    "3. **relatedPages** (edgeType: related): Use only for genuine thematic relationships that do not fit any type-specific edge or sourceRefs. This is a last resort, not a default.",
    "",
    "If during discovery you find that the new source, combined with existing wiki pages, enables a higher-level synthesis (e.g., two existing concepts can now be bridged, or a pattern emerges across multiple existing pages), you may create that synthesis page and use sourceRefs to link back to its constituent pages.",
    "",
    "Orphan pages with no relations are acceptable when the source introduces a topic with genuinely no overlap to existing wiki content.",
    "",
    "## Step 3 — Create or Update Pages",
    "",
    "### Field Conventions",
    "",
    "- **vaultPath**: MUST be relative to the vault root. Never use absolute paths. Derive it by stripping the vault root prefix from VAULT_FILE_PATH. This field tracks which original source file produced this page.",
    "- **sourceRefs**: Wiki-internal knowledge dependency. Points to existing wiki page paths that this page's content builds upon. Do not use for vault file references. Leave empty only when this page genuinely has no dependency on existing wiki knowledge.",
    "- **relatedPages**: Thematic relations only. Do not use as a substitute for sourceRefs or type-specific edges.",
    "- **createdAt / updatedAt**: Leave placeholders unchanged or omit them. The system will normalize them to YYYY-MM-DD during indexing and refresh updatedAt on modified pages.",
    "- **nodeId**: Lowercase kebab-case slug derived from the topic (not the source document name).",
    "  - For English titles: use key words directly (e.g., \"API Rate Limiting\" → `api-rate-limiting`).",
    "  - For Chinese titles: use a short English translation of the core topic, NOT pinyin (e.g., \"平台产品需求文档\" → `platform-product-requirements`, NOT `ping-tai-chan-pin-xu-qiu-wen-dang`).",
    "  - Keep under 50 characters. Drop filler words.",
    "",
    "Consult the template for your chosen type before writing a page.",
    "If ALLOW_TEMPLATE_EVOLUTION=false, do not create templates or new page types.",
    "",
    "### Quality Gate",
    "",
    "For every changed page, run:",
    "1. `tiangong-wiki sync --path <page>`",
    "2. `tiangong-wiki lint --path <page> --format json`",
    "",
    "Fix all errors before proceeding. Also review warnings: if a warning indicates a field mismatch between your page and the type schema (e.g., unregistered fields, empty required references), fix it. Only ignore warnings that are clearly cosmetic or irrelevant to schema correctness.",
    "",
    "## Step 4 — Write Result Manifest",
    "",
    "The authoritative threadId is queue-item.json.threadId. Read it from there and copy it unchanged into result.json.threadId. If it is empty on first read, read queue-item.json again immediately before writing the manifest.",
    "",
    "Write RESULT_JSON_PATH as one JSON object with: status, decision, reason, threadId, skillsUsed, createdPageIds, updatedPageIds, appliedTypeNames, proposedTypes, actions, lint.",
    "",
    "### Allowed Values",
    "",
    "- **status**: done | skipped | error. Use done for successful apply or propose_only runs, skipped for skip, and error only when the workflow itself failed. Never use success, completed, failed, or other aliases.",
    "- **decision**: apply | skip | propose_only. Never use update_existing, create_new, update, create, or other aliases.",
    "- **actions**: Array of objects, never strings. Allowed action kinds: create_page, update_page, create_template. Every action object must include kind and summary. create_page requires pageType and title. update_page requires pageId. create_template requires pageType and title.",
    "- **proposedTypes**: Objects with name, reason, suggestedTemplateSections.",
    "- **lint**: Objects with pageId, errors, warnings.",
    "",
    "### Example",
    "",
    '{"status":"done","decision":"apply","reason":"Updated the existing method.","threadId":"<copy queue-item.json.threadId>","skillsUsed":["tiangong-wiki-skill"],"createdPageIds":[],"updatedPageIds":["methods/example.md"],"appliedTypeNames":["method"],"proposedTypes":[],"actions":[{"kind":"update_page","pageId":"methods/example.md","pageType":"method","summary":"Updated the page with durable knowledge."}],"lint":[{"pageId":"methods/example.md","errors":0,"warnings":0}]}',
    "",
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

  const wikiCliWrapperPath = path.join(artifacts.skillArtifactsPath, "tiangong-wiki");
  const wikiCliCmdWrapperPath = path.join(artifacts.skillArtifactsPath, "tiangong-wiki.cmd");
  const nodeExecutable = resolveNodeExecutable();
  const cliEntrypoint = path.join(paths.packageRoot, "dist", "index.js");
  writeTextFileSync(artifacts.queueItemPath, `${JSON.stringify(input.queueItem, null, 2)}\n`);
  writeTextFileSync(
    wikiCliWrapperPath,
    [
      "#!/bin/sh",
      'node_bin=${WIKI_CLI_NODE:-}',
      'if [ -z "$node_bin" ]; then',
      `  node_bin=${shellSingleQuote(nodeExecutable)}`,
      "fi",
      'cli_entry=${WIKI_CLI_ENTRYPOINT:-}',
      'if [ -z "$cli_entry" ]; then',
      `  cli_entry=${shellSingleQuote(cliEntrypoint)}`,
      "fi",
      'if [ ! -f "$cli_entry" ]; then',
      '  echo "tiangong-wiki CLI entrypoint not found: ${cli_entry}" >&2',
      "  exit 127",
      "fi",
      'exec "$node_bin" "$cli_entry" "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(wikiCliWrapperPath, 0o755);
  writeTextFileSync(
    wikiCliCmdWrapperPath,
    [
      "@echo off",
      "setlocal",
      "if not defined WIKI_CLI_NODE set \"WIKI_CLI_NODE=%~dp0node.exe\"",
      `if not exist "%WIKI_CLI_NODE%" set "WIKI_CLI_NODE=${nodeExecutable.replace(/"/g, '""')}"`,
      "if not defined WIKI_CLI_ENTRYPOINT (",
      `  set "WIKI_CLI_ENTRYPOINT=${cliEntrypoint.replace(/"/g, '""')}"`,
      ")",
      "if not exist \"%WIKI_CLI_ENTRYPOINT%\" (",
      "  echo tiangong-wiki CLI entrypoint not found: %WIKI_CLI_ENTRYPOINT% 1>&2",
      "  exit /b 127",
      ")",
      "\"%WIKI_CLI_NODE%\" \"%WIKI_CLI_ENTRYPOINT%\" %*",
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
  );
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

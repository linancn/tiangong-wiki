import Database from "better-sqlite3";
import path from "node:path";

import {
  CODEX_WORKFLOW_VERSION,
  CodexSdkWorkflowRunner,
  type CodexWorkflowInput,
  type CodexWorkflowRunner,
} from "./codex-workflow.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { resolveAgentSettings, resolveRuntimePaths } from "./paths.js";
import { assertTemplateEvolutionAllowed, resolveTemplateEvolutionSettings } from "./template-evolution.js";
import { ensureLocalVaultFile } from "./vault.js";
import {
  buildVaultWorkflowPrompt,
  ensureWorkflowArtifactSet,
  getWorkflowArtifactSet,
} from "./workflow-context.js";
import { readWorkflowResult, type WorkflowResultManifest } from "./workflow-result.js";
import type { VaultFile, VaultQueueItem, VaultQueueStatus } from "../types/page.js";
import { AppError } from "../utils/errors.js";
import { readTextFileSync } from "../utils/fs.js";
import { toOffsetIso } from "../utils/time.js";

interface QueueProcessResult {
  enabled: boolean;
  processed: number;
  done: number;
  skipped: number;
  errored: number;
  items: Array<{
    fileId: string;
    status: VaultQueueStatus;
    pageId?: string | null;
    reason: string;
    threadId?: string | null;
    decision?: string | null;
    skillsUsed?: string[];
    createdPageIds?: string[];
    updatedPageIds?: string[];
    proposedTypeNames?: string[];
    resultManifestPath?: string | null;
  }>;
}

const INLINE_WORKFLOW_ATTEMPTS = 2;

function parseOptionalStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
  }
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mapQueueRow(row: Record<string, unknown>): VaultQueueItem {
  return {
    fileId: String(row.fileId),
    status: row.status as VaultQueueStatus,
    priority: Number(row.priority ?? 0),
    queuedAt: String(row.queuedAt),
    processedAt: typeof row.processedAt === "string" ? row.processedAt : null,
    resultPageId: typeof row.resultPageId === "string" ? row.resultPageId : null,
    errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : null,
    attempts: Number(row.attempts ?? 0),
    threadId: typeof row.threadId === "string" ? row.threadId : null,
    workflowVersion: typeof row.workflowVersion === "string" ? row.workflowVersion : null,
    decision: typeof row.decision === "string" ? (row.decision as VaultQueueItem["decision"]) : null,
    resultManifestPath: typeof row.resultManifestPath === "string" ? row.resultManifestPath : null,
    lastErrorAt: typeof row.lastErrorAt === "string" ? row.lastErrorAt : null,
    retryAfter: typeof row.retryAfter === "string" ? row.retryAfter : null,
    createdPageIds: parseOptionalStringArray(row.createdPageIds),
    updatedPageIds: parseOptionalStringArray(row.updatedPageIds),
    appliedTypeNames: parseOptionalStringArray(row.appliedTypeNames),
    proposedTypeNames: parseOptionalStringArray(row.proposedTypeNames),
    skillsUsed: parseOptionalStringArray(row.skillsUsed),
    fileName: typeof row.fileName === "string" ? row.fileName : undefined,
    fileExt: typeof row.fileExt === "string" ? row.fileExt : null,
    sourceType: typeof row.sourceType === "string" ? row.sourceType : null,
    fileSize: typeof row.fileSize === "number" ? row.fileSize : undefined,
    filePath: typeof row.filePath === "string" ? row.filePath : undefined,
  };
}

function claimQueueItems(
  db: Database.Database,
  limit: number,
): VaultQueueItem[] {
  const select = db.prepare(
    `
      SELECT
        file_id AS fileId,
        status,
        priority,
        queued_at AS queuedAt,
        processed_at AS processedAt,
        result_page_id AS resultPageId,
        error_message AS errorMessage,
        attempts,
        thread_id AS threadId,
        workflow_version AS workflowVersion,
        decision,
        result_manifest_path AS resultManifestPath,
        last_error_at AS lastErrorAt,
        retry_after AS retryAfter,
        created_page_ids AS createdPageIds,
        updated_page_ids AS updatedPageIds,
        applied_type_names AS appliedTypeNames,
        proposed_type_names AS proposedTypeNames,
        skills_used AS skillsUsed,
        vault_files.file_name AS fileName,
        vault_files.file_ext AS fileExt,
        vault_files.source_type AS sourceType,
        vault_files.file_size AS fileSize,
        vault_files.file_path AS filePath
      FROM vault_processing_queue
      LEFT JOIN vault_files ON vault_files.id = vault_processing_queue.file_id
      WHERE status IN ('pending', 'error')
      ORDER BY priority DESC, queued_at ASC
      LIMIT ?
    `,
  );
  const markProcessing = db.prepare(
    `
      UPDATE vault_processing_queue
      SET status = 'processing', error_message = NULL
      WHERE file_id = ? AND status IN ('pending', 'error')
    `,
  );

  return db.transaction((claimLimit: number) => {
    const items = (select.all(claimLimit) as Array<Record<string, unknown>>).map(mapQueueRow);
    for (const item of items) {
      markProcessing.run(item.fileId);
    }
    return items;
  })(limit);
}

function fetchQueueItemsByStatus(
  db: Database.Database,
  status?: VaultQueueStatus,
): VaultQueueItem[] {
  const rows = db.prepare(
    `
      SELECT
        file_id AS fileId,
        status,
        priority,
        queued_at AS queuedAt,
        processed_at AS processedAt,
        result_page_id AS resultPageId,
        error_message AS errorMessage,
        attempts,
        thread_id AS threadId,
        workflow_version AS workflowVersion,
        decision,
        result_manifest_path AS resultManifestPath,
        last_error_at AS lastErrorAt,
        retry_after AS retryAfter,
        created_page_ids AS createdPageIds,
        updated_page_ids AS updatedPageIds,
        applied_type_names AS appliedTypeNames,
        proposed_type_names AS proposedTypeNames,
        skills_used AS skillsUsed,
        vault_files.file_name AS fileName,
        vault_files.file_ext AS fileExt,
        vault_files.source_type AS sourceType,
        vault_files.file_size AS fileSize,
        vault_files.file_path AS filePath
      FROM vault_processing_queue
      LEFT JOIN vault_files ON vault_files.id = vault_processing_queue.file_id
      ${status ? "WHERE status = ?" : ""}
      ORDER BY priority DESC, queued_at ASC
    `,
  ).all(...(status ? [status] : [])) as Array<Record<string, unknown>>;
  return rows.map(mapQueueRow);
}

function fetchVaultFile(db: Database.Database, fileId: string): VaultFile | null {
  const row = db.prepare(
    `
      SELECT
        id,
        file_name AS fileName,
        file_ext AS fileExt,
        source_type AS sourceType,
        file_size AS fileSize,
        file_path AS filePath,
        content_hash AS contentHash,
        file_mtime AS fileMtime,
        indexed_at AS indexedAt
      FROM vault_files
      WHERE id = ?
    `,
  ).get(fileId) as VaultFile | undefined;
  return row ?? null;
}

function updateQueueStatus(
  db: Database.Database,
  fileId: string,
  payload: {
    status: VaultQueueStatus;
    processedAt: string | null;
    resultPageId?: string | null;
    errorMessage?: string | null;
    incrementAttempts?: boolean;
  },
): void {
  db.prepare(
    `
      UPDATE vault_processing_queue
      SET
        status = @status,
        processed_at = @processed_at,
        result_page_id = COALESCE(@result_page_id, result_page_id),
        error_message = @error_message,
        attempts = CASE WHEN @increment_attempts = 1 THEN attempts + 1 ELSE attempts END
      WHERE file_id = @file_id
    `,
  ).run({
    file_id: fileId,
    status: payload.status,
    processed_at: payload.processedAt,
    result_page_id: payload.resultPageId ?? null,
    error_message: payload.errorMessage ?? null,
    increment_attempts: payload.incrementAttempts ? 1 : 0,
  });
}

function updateQueueWorkflowTracking(
  db: Database.Database,
  fileId: string,
  payload: {
    threadId: string;
    resultManifestPath: string;
  },
): void {
  db.prepare(
    `
      UPDATE vault_processing_queue
      SET
        thread_id = @thread_id,
        workflow_version = @workflow_version,
        result_manifest_path = @result_manifest_path
      WHERE file_id = @file_id
    `,
  ).run({
    file_id: fileId,
    thread_id: payload.threadId,
    workflow_version: CODEX_WORKFLOW_VERSION,
    result_manifest_path: payload.resultManifestPath,
  });
}

function serializeArray(value: string[]): string {
  return JSON.stringify(value);
}

function formatManifestLogFields(manifest: WorkflowResultManifest): string {
  return `decision=${manifest.decision} skills=${manifest.skillsUsed.join(",") || "-"} created=${manifest.createdPageIds.join(",") || "-"} updated=${manifest.updatedPageIds.join(",") || "-"} proposed=${manifest.proposedTypes.map((item) => item.name).join(",") || "-"}`;
}

function applyWorkflowManifest(
  db: Database.Database,
  fileId: string,
  manifest: WorkflowResultManifest,
  resultManifestPath: string,
): { status: VaultQueueStatus; pageId: string | null } {
  const resultPageId = manifest.createdPageIds[0] ?? manifest.updatedPageIds[0] ?? null;
  const status = manifest.status;
  const processedAt = toOffsetIso();

  db.prepare(
    `
      UPDATE vault_processing_queue
      SET
        status = @status,
        processed_at = @processed_at,
        result_page_id = @result_page_id,
        error_message = NULL,
        workflow_version = @workflow_version,
        decision = @decision,
        result_manifest_path = @result_manifest_path,
        last_error_at = NULL,
        retry_after = NULL,
        created_page_ids = @created_page_ids,
        updated_page_ids = @updated_page_ids,
        applied_type_names = @applied_type_names,
        proposed_type_names = @proposed_type_names,
        skills_used = @skills_used
      WHERE file_id = @file_id
    `,
  ).run({
    file_id: fileId,
    status,
    processed_at: processedAt,
    result_page_id: resultPageId,
    workflow_version: CODEX_WORKFLOW_VERSION,
    decision: manifest.decision,
    result_manifest_path: resultManifestPath,
    created_page_ids: serializeArray(manifest.createdPageIds),
    updated_page_ids: serializeArray(manifest.updatedPageIds),
    applied_type_names: serializeArray(manifest.appliedTypeNames),
    proposed_type_names: serializeArray(manifest.proposedTypes.map((item) => item.name)),
    skills_used: serializeArray(manifest.skillsUsed),
  });

  return { status, pageId: resultPageId };
}

function isInlineRetryCapable(runner: CodexWorkflowRunner): boolean {
  return runner.inlineRetryCapable === true;
}

function normalizeWorkflowErrorDetail(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }

  if (value instanceof Error) {
    const normalized = value.message.trim();
    return normalized ? normalized : null;
  }

  return null;
}

function formatWorkflowError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AppError)) {
    return message;
  }

  const directDetails = normalizeWorkflowErrorDetail(error.details);
  if (directDetails && directDetails !== message) {
    return `${message}: ${directDetails}`;
  }

  if (!error.details || typeof error.details !== "object" || Array.isArray(error.details)) {
    return message;
  }

  const cause = normalizeWorkflowErrorDetail((error.details as Record<string, unknown>).cause);
  if (!cause || cause === message) {
    return message;
  }

  return `${message}: ${cause}`;
}

// A runner failure can happen after the agent has already written a final result.json.
// Recover that manifest instead of blindly re-injecting the same task.
function readRecoverableWorkflowResult(
  resultPath: string | null | undefined,
  expectedThreadId: string | null,
): WorkflowResultManifest | null {
  if (!resultPath || !expectedThreadId) {
    return null;
  }

  try {
    const manifest = readWorkflowResult(resultPath);
    if (manifest.threadId !== expectedThreadId || manifest.status === "error") {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

function shouldAttemptManifestRecovery(error: unknown): boolean {
  if (error instanceof AppError && error.type === "config") {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Codex workflow ") || message.startsWith("Workflow result ");
}

function shouldRetryWorkflowAttempt(error: unknown, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) {
    return false;
  }

  if (error instanceof AppError && error.type === "config") {
    return false;
  }

  return true;
}

function readPersistedWorkflowThreadId(queueItemPath: string): string | null {
  try {
    const raw = readTextFileSync(queueItemPath).trim();
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.threadId === "string" && parsed.threadId.trim() ? parsed.threadId.trim() : null;
  } catch {
    return null;
  }
}

function updateQueueWorkflowError(
  db: Database.Database,
  fileId: string,
  payload: {
    errorMessage: string;
    threadId?: string | null;
    resultManifestPath?: string | null;
  },
): void {
  const processedAt = toOffsetIso();
  db.prepare(
    `
      UPDATE vault_processing_queue
      SET
        status = 'error',
        processed_at = @processed_at,
        error_message = @error_message,
        attempts = attempts + 1,
        thread_id = COALESCE(@thread_id, thread_id),
        workflow_version = @workflow_version,
        result_manifest_path = COALESCE(@result_manifest_path, result_manifest_path),
        last_error_at = @last_error_at
      WHERE file_id = @file_id
    `,
  ).run({
    file_id: fileId,
    processed_at: processedAt,
    error_message: payload.errorMessage.slice(0, 1_000),
    thread_id: payload.threadId ?? null,
    workflow_version: CODEX_WORKFLOW_VERSION,
    result_manifest_path: payload.resultManifestPath ?? null,
    last_error_at: processedAt,
  });
}

function prepareCodexWorkflowInput(
  paths: ReturnType<typeof resolveRuntimePaths>,
  item: VaultQueueItem,
  file: VaultFile,
  localFilePath: string,
  env: NodeJS.ProcessEnv,
  allowTemplateEvolution: boolean,
): {
  artifacts: ReturnType<typeof getWorkflowArtifactSet>;
  input: CodexWorkflowInput;
} {
  const workspaceRoot = path.resolve(paths.wikiRoot, "..");
  const artifacts = getWorkflowArtifactSet(paths, item.fileId);
  const promptText = buildVaultWorkflowPrompt({
    workspaceRoot,
    vaultFilePath: localFilePath,
    resultJsonPath: artifacts.resultPath,
    allowTemplateEvolution,
  });

  ensureWorkflowArtifactSet(paths, {
    queueItemId: item.fileId,
    queueItem: {
      fileId: item.fileId,
      threadId: item.threadId ?? null,
      workspaceRoot,
      wikiRoot: paths.wikiRoot,
      wikiPath: paths.wikiPath,
      vaultPath: paths.vaultPath,
      localFilePath,
      resultJsonPath: artifacts.resultPath,
      skillArtifactsPath: artifacts.skillArtifactsPath,
      file,
      queue: {
        status: item.status,
        priority: item.priority,
        queuedAt: item.queuedAt,
        attempts: item.attempts,
      },
    },
    promptMarkdown: promptText,
  });

  return {
    artifacts,
    input: {
      queueItemId: item.fileId,
      workspaceRoot,
      packageRoot: paths.packageRoot,
      promptPath: artifacts.promptPath,
      promptText,
      queueItemPath: artifacts.queueItemPath,
      resultPath: artifacts.resultPath,
      skillArtifactsPath: artifacts.skillArtifactsPath,
      model: env.WIKI_AGENT_MODEL ?? null,
      env,
    },
  };
}

export function getVaultQueueSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  status?: VaultQueueStatus,
): {
  items: VaultQueueItem[];
  totalPending: number;
  totalProcessing: number;
  totalDone: number;
  totalSkipped: number;
  totalError: number;
} {
  const paths = resolveRuntimePaths(env);
  const config = loadConfig(paths.configPath);
  const { db } = openDb(paths.dbPath, config, Number.parseInt(env.EMBEDDING_DIMENSIONS ?? "384", 10) || 384);

  try {
    const items = fetchQueueItemsByStatus(db, status);
    const counts = db.prepare(
      `
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS totalPending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS totalProcessing,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS totalDone,
          SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS totalSkipped,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS totalError
        FROM vault_processing_queue
      `,
    ).get() as Record<string, number | null>;

    return {
      items,
      totalPending: counts.totalPending ?? 0,
      totalProcessing: counts.totalProcessing ?? 0,
      totalDone: counts.totalDone ?? 0,
      totalSkipped: counts.totalSkipped ?? 0,
      totalError: counts.totalError ?? 0,
    };
  } finally {
    db.close();
  }
}

export async function processVaultQueueBatch(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    maxItems?: number;
    log?: (message: string) => void;
    workflowRunner?: CodexWorkflowRunner;
  } = {},
): Promise<QueueProcessResult> {
  const agentSettings = resolveAgentSettings(env, { strict: true });
  if (!agentSettings.enabled || agentSettings.batchSize === 0) {
    return {
      enabled: false,
      processed: 0,
      done: 0,
      skipped: 0,
      errored: 0,
      items: [],
    };
  }

  const paths = resolveRuntimePaths(env);
  const config = loadConfig(paths.configPath);
  const { db } = openDb(paths.dbPath, config, Number.parseInt(env.EMBEDDING_DIMENSIONS ?? "384", 10) || 384);

  try {
    const items = claimQueueItems(db, options.maxItems ?? agentSettings.batchSize);
    const result: QueueProcessResult = {
      enabled: true,
      processed: 0,
      done: 0,
      skipped: 0,
      errored: 0,
      items: [],
    };
    const workflowRunner = options.workflowRunner ?? new CodexSdkWorkflowRunner();
    const templateEvolution = resolveTemplateEvolutionSettings(env);
    const maxWorkflowAttempts = isInlineRetryCapable(workflowRunner) ? INLINE_WORKFLOW_ATTEMPTS : 1;

    const countOutcome = (status: VaultQueueStatus) => {
      if (status === "done") {
        result.done += 1;
      } else if (status === "skipped") {
        result.skipped += 1;
      } else if (status === "error") {
        result.errored += 1;
      }
      result.processed += 1;
    };

    for (const item of items) {
      const file = fetchVaultFile(db, item.fileId);
      if (!file) {
        updateQueueStatus(db, item.fileId, {
          status: "error",
          processedAt: toOffsetIso(),
          errorMessage: `Vault file missing from index: ${item.fileId}`,
          incrementAttempts: true,
        });
        countOutcome("error");
        result.items.push({
          fileId: item.fileId,
          status: "error",
          reason: "Vault file missing from index",
        });
        continue;
      }

      let threadId = item.threadId ?? null;
      let resultManifestPath: string | null = null;

      try {
        const localFilePath = await ensureLocalVaultFile(file, paths.vaultPath, env);
        const { artifacts, input } = prepareCodexWorkflowInput(
          paths,
          item,
          file,
          localFilePath,
          env,
          templateEvolution.canApply,
        );
        resultManifestPath = artifacts.resultPath;

        let finalOutcome:
          | {
              outcome: { status: VaultQueueStatus; pageId: string | null };
              manifest: WorkflowResultManifest;
              handleThreadId: string;
            }
          | null = null;
        let lastWorkflowError: unknown;

        for (let attempt = 1; attempt <= maxWorkflowAttempts; attempt += 1) {
          try {
            const handle = threadId
              ? await workflowRunner.resumeWorkflow(threadId, input)
              : await workflowRunner.startWorkflow(input);
            threadId = handle.threadId;
            updateQueueWorkflowTracking(db, item.fileId, {
              threadId: handle.threadId,
              resultManifestPath: artifacts.resultPath,
            });

            const manifest = await workflowRunner.collectResult(handle, input);
            assertTemplateEvolutionAllowed(manifest, templateEvolution);
            finalOutcome = {
              outcome: applyWorkflowManifest(db, item.fileId, manifest, artifacts.resultPath),
              manifest,
              handleThreadId: handle.threadId,
            };
            break;
          } catch (error) {
            lastWorkflowError = error;
            threadId = readPersistedWorkflowThreadId(artifacts.queueItemPath) ?? threadId;
            if (threadId) {
              updateQueueWorkflowTracking(db, item.fileId, {
                threadId,
                resultManifestPath: artifacts.resultPath,
              });
            }

            const recoveredManifest = shouldAttemptManifestRecovery(error)
              ? readRecoverableWorkflowResult(artifacts.resultPath, threadId)
              : null;
            if (recoveredManifest) {
              assertTemplateEvolutionAllowed(recoveredManifest, templateEvolution);
              finalOutcome = {
                outcome: applyWorkflowManifest(db, item.fileId, recoveredManifest, artifacts.resultPath),
                manifest: recoveredManifest,
                handleThreadId: recoveredManifest.threadId,
              };
              options.log?.(
                `${item.fileId}: recovered persisted workflow result status=${recoveredManifest.status} thread=${recoveredManifest.threadId} ${formatManifestLogFields(recoveredManifest)} result=${artifacts.resultPath} message=${formatWorkflowError(error)}`,
              );
              break;
            }

            if (!shouldRetryWorkflowAttempt(error, attempt, maxWorkflowAttempts)) {
              throw error;
            }

            options.log?.(
              `${item.fileId}: retrying workflow attempt ${attempt + 1}/${maxWorkflowAttempts} thread=${threadId ?? "-"} result=${artifacts.resultPath} message=${formatWorkflowError(error)}`,
            );
          }
        }

        if (!finalOutcome) {
          throw (lastWorkflowError ?? new AppError("Workflow completed without a result", "runtime"));
        }

        options.log?.(
          `${item.fileId}: ${finalOutcome.outcome.status} thread=${finalOutcome.handleThreadId} ${formatManifestLogFields(finalOutcome.manifest)} result=${artifacts.resultPath}`,
        );
        countOutcome(finalOutcome.outcome.status);
        result.items.push({
          fileId: item.fileId,
          status: finalOutcome.outcome.status,
          pageId: finalOutcome.outcome.pageId,
          reason: finalOutcome.manifest.reason,
          threadId: finalOutcome.handleThreadId,
          decision: finalOutcome.manifest.decision,
          skillsUsed: finalOutcome.manifest.skillsUsed,
          createdPageIds: finalOutcome.manifest.createdPageIds,
          updatedPageIds: finalOutcome.manifest.updatedPageIds,
          proposedTypeNames: finalOutcome.manifest.proposedTypes.map((entry) => entry.name),
          resultManifestPath: artifacts.resultPath,
        });
      } catch (error) {
        const recoveredManifest = shouldAttemptManifestRecovery(error)
          ? readRecoverableWorkflowResult(resultManifestPath, threadId)
          : null;
        if (recoveredManifest && resultManifestPath) {
          assertTemplateEvolutionAllowed(recoveredManifest, templateEvolution);
          const recoveredOutcome = applyWorkflowManifest(db, item.fileId, recoveredManifest, resultManifestPath);
          options.log?.(
            `${item.fileId}: recovered persisted workflow result after terminal failure status=${recoveredOutcome.status} thread=${recoveredManifest.threadId} ${formatManifestLogFields(recoveredManifest)} result=${resultManifestPath} message=${formatWorkflowError(error)}`,
          );
          countOutcome(recoveredOutcome.status);
          result.items.push({
            fileId: item.fileId,
            status: recoveredOutcome.status,
            pageId: recoveredOutcome.pageId,
            reason: recoveredManifest.reason,
            threadId: recoveredManifest.threadId,
            decision: recoveredManifest.decision,
            skillsUsed: recoveredManifest.skillsUsed,
            createdPageIds: recoveredManifest.createdPageIds,
            updatedPageIds: recoveredManifest.updatedPageIds,
            proposedTypeNames: recoveredManifest.proposedTypes.map((entry) => entry.name),
            resultManifestPath,
          });
          continue;
        }

        const message = formatWorkflowError(error);
        updateQueueWorkflowError(db, item.fileId, {
          errorMessage: message,
          threadId,
          resultManifestPath,
        });
        options.log?.(
          `${item.fileId}: error thread=${threadId ?? "-"} result=${resultManifestPath ?? "-"} message=${message}`,
        );
        countOutcome("error");
        result.items.push({
          fileId: item.fileId,
          status: "error",
          pageId: item.resultPageId ?? null,
          reason: message,
          threadId,
          resultManifestPath,
        });
      }
    }

    return result;
  } finally {
    db.close();
  }
}

export function getWikiAgentStatus(env: NodeJS.ProcessEnv = process.env) {
  return resolveAgentSettings(env);
}

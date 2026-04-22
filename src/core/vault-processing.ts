import Database from "better-sqlite3";
import path from "node:path";

import {
  CODEX_WORKFLOW_VERSION,
  createDefaultWorkflowRunner,
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
import { addSeconds, toOffsetIso } from "../utils/time.js";

export interface QueueProcessResult {
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
const MAX_QUEUE_ERROR_RETRIES = 3;
const QUEUE_FULL_RETRY_DELAY_SECONDS = 300;
const WORKFLOW_TIMEOUT_RETRY_DELAY_SECONDS = 120;
const NON_RETRYABLE_QUEUE_ERROR_CODES = new Set(["config_error", "invalid_request"]);

function buildFileIdFilterClause(filterFileIds: string[] | undefined): { clause: string; params: string[] } {
  if (!filterFileIds || filterFileIds.length === 0) {
    return { clause: "", params: [] };
  }

  return {
    clause: ` AND vault_processing_queue.file_id IN (${filterFileIds.map(() => "?").join(", ")})`,
    params: filterFileIds,
  };
}

function buildExcludedFileIdClause(excludedFileIds: Iterable<string> | undefined): { clause: string; params: string[] } {
  const params = Array.from(excludedFileIds ?? []).filter((value) => value.trim().length > 0);
  if (params.length === 0) {
    return { clause: "", params: [] };
  }

  return {
    clause: ` AND vault_processing_queue.file_id NOT IN (${params.map(() => "?").join(", ")})`,
    params,
  };
}

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
  const attempts = Number(row.attempts ?? 0);
  const status = row.status as VaultQueueStatus;
  return {
    fileId: String(row.fileId),
    status,
    priority: Number(row.priority ?? 0),
    queuedAt: String(row.queuedAt),
    claimedAt: typeof row.claimedAt === "string" ? row.claimedAt : null,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
    processedAt: typeof row.processedAt === "string" ? row.processedAt : null,
    resultPageId: typeof row.resultPageId === "string" ? row.resultPageId : null,
    errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : null,
    attempts,
    threadId: typeof row.threadId === "string" ? row.threadId : null,
    workflowVersion: typeof row.workflowVersion === "string" ? row.workflowVersion : null,
    decision: typeof row.decision === "string" ? (row.decision as VaultQueueItem["decision"]) : null,
    resultManifestPath: typeof row.resultManifestPath === "string" ? row.resultManifestPath : null,
    lastErrorAt: typeof row.lastErrorAt === "string" ? row.lastErrorAt : null,
    lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
    retryAfter: typeof row.retryAfter === "string" ? row.retryAfter : null,
    autoRetryExhausted: status === "error" && attempts > MAX_QUEUE_ERROR_RETRIES,
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
  options: {
    filterFileIds?: string[];
    excludeFileIds?: Iterable<string>;
  } = {},
): VaultQueueItem[] {
  const filter = buildFileIdFilterClause(options.filterFileIds);
  const exclude = buildExcludedFileIdClause(options.excludeFileIds);
  const manualClaim = Boolean(options.filterFileIds && options.filterFileIds.length > 0);
  const errorEligibility = manualClaim
    ? "vault_processing_queue.status = 'error'"
    : [
        "vault_processing_queue.status = 'error'",
        `vault_processing_queue.attempts <= ${MAX_QUEUE_ERROR_RETRIES}`,
        `COALESCE(vault_processing_queue.last_error_code, '') NOT IN (${Array.from(NON_RETRYABLE_QUEUE_ERROR_CODES)
          .map((code) => `'${code}'`)
          .join(", ")})`,
        "(vault_processing_queue.retry_after IS NULL OR julianday(vault_processing_queue.retry_after) <= julianday(?))",
      ].join("\n          AND ");
  const select = db.prepare(
    `
      SELECT
        file_id AS fileId,
        status,
        priority,
        queued_at AS queuedAt,
        claimed_at AS claimedAt,
        started_at AS startedAt,
        processed_at AS processedAt,
        result_page_id AS resultPageId,
        error_message AS errorMessage,
        attempts,
        thread_id AS threadId,
        workflow_version AS workflowVersion,
        decision,
        result_manifest_path AS resultManifestPath,
        last_error_at AS lastErrorAt,
        last_error_code AS lastErrorCode,
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
      WHERE (
        vault_processing_queue.status = 'pending'
        OR (
          ${errorEligibility}
        )
      )${filter.clause}${exclude.clause}
      ORDER BY priority DESC, queued_at ASC
      LIMIT ?
    `,
  );
  const markProcessing = db.prepare(
    `
      UPDATE vault_processing_queue
      SET
        status = 'processing',
        claimed_at = @claimed_at,
        started_at = @started_at,
        error_message = NULL,
        retry_after = NULL
      WHERE file_id = @file_id AND status IN ('pending', 'error')
    `,
  );

  return db.transaction((claimLimit: number, claimFilterParams: string[]) => {
    const startedAt = toOffsetIso();
    const selectParams = manualClaim
      ? [...claimFilterParams, claimLimit]
      : [startedAt, ...claimFilterParams, claimLimit];
    const items = (select.all(...selectParams) as Array<Record<string, unknown>>).map(mapQueueRow);
    for (const item of items) {
      markProcessing.run(
        {
          file_id: item.fileId,
          claimed_at: startedAt,
          started_at: startedAt,
        },
      );
    }
    return items.map((item) => ({
      ...item,
      claimedAt: startedAt,
      startedAt,
    }));
  })(limit, [...filter.params, ...exclude.params]);
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
        claimed_at AS claimedAt,
        started_at AS startedAt,
        processed_at AS processedAt,
        result_page_id AS resultPageId,
        error_message AS errorMessage,
        attempts,
        thread_id AS threadId,
        workflow_version AS workflowVersion,
        decision,
        result_manifest_path AS resultManifestPath,
        last_error_at AS lastErrorAt,
        last_error_code AS lastErrorCode,
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

function fetchQueueItemByFileId(
  db: Database.Database,
  fileId: string,
): VaultQueueItem | null {
  const row = db.prepare(
    `
      SELECT
        file_id AS fileId,
        status,
        priority,
        queued_at AS queuedAt,
        claimed_at AS claimedAt,
        started_at AS startedAt,
        processed_at AS processedAt,
        result_page_id AS resultPageId,
        error_message AS errorMessage,
        attempts,
        thread_id AS threadId,
        workflow_version AS workflowVersion,
        decision,
        result_manifest_path AS resultManifestPath,
        last_error_at AS lastErrorAt,
        last_error_code AS lastErrorCode,
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
      WHERE vault_processing_queue.file_id = ?
    `,
  ).get(fileId) as Record<string, unknown> | undefined;

  return row ? mapQueueRow(row) : null;
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

function extractErrorDetailsCode(error: unknown): string | null {
  if (!(error instanceof AppError)) {
    return null;
  }
  if (typeof error.details !== "object" || error.details === null || Array.isArray(error.details)) {
    return null;
  }

  const code = (error.details as Record<string, unknown>).code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function inferWorkflowErrorCode(message: string): string | null {
  const normalized = message.toLowerCase();
  if (normalized.includes("queue_full") || normalized.includes("write queue is full")) {
    return "queue_full";
  }
  if (normalized.includes("timed out")) {
    return "workflow_timeout";
  }
  return null;
}

function buildRetryAfter(seconds: number): string {
  return toOffsetIso(addSeconds(new Date(), seconds));
}

function buildQueueFailureState(
  message: string,
  options: {
    explicitCode?: string | null;
    errorType?: AppError["type"] | null;
  } = {},
): {
  errorCode: string | null;
  retryAfter: string | null;
  autoRetryEligible: boolean;
} {
  const inferredCode = inferWorkflowErrorCode(message);
  const errorCode =
    inferredCode ?? options.explicitCode ?? (options.errorType === "config" ? "config_error" : null);

  if (errorCode && NON_RETRYABLE_QUEUE_ERROR_CODES.has(errorCode)) {
    return {
      errorCode,
      retryAfter: null,
      autoRetryEligible: false,
    };
  }

  if (errorCode === "queue_full") {
    return {
      errorCode,
      retryAfter: buildRetryAfter(QUEUE_FULL_RETRY_DELAY_SECONDS),
      autoRetryEligible: true,
    };
  }

  if (errorCode === "workflow_timeout") {
    return {
      errorCode,
      retryAfter: buildRetryAfter(WORKFLOW_TIMEOUT_RETRY_DELAY_SECONDS),
      autoRetryEligible: true,
    };
  }

  return {
    errorCode,
    retryAfter: null,
    autoRetryEligible: true,
  };
}

function formatQueueErrorMessage(
  message: string,
  autoRetryExhausted: boolean,
): string {
  const autoRetrySuffix = autoRetryExhausted
    ? ` Auto retry limit reached after ${MAX_QUEUE_ERROR_RETRIES} retries; use manual retry or requeue after the vault file changes.`
    : "";
  return `${message}${autoRetrySuffix}`.slice(0, 1_000);
}

function applyWorkflowManifest(
  db: Database.Database,
  fileId: string,
  manifest: WorkflowResultManifest,
  resultManifestPath: string,
  currentAttempts: number,
): { status: VaultQueueStatus; pageId: string | null } {
  const resultPageId = manifest.createdPageIds[0] ?? manifest.updatedPageIds[0] ?? null;
  const status = manifest.status;
  const processedAt = toOffsetIso();

  if (status === "error") {
    const failureState = buildQueueFailureState(manifest.reason);
    const nextAttempts = currentAttempts + 1;
    const autoRetryExhausted = failureState.autoRetryEligible && nextAttempts > MAX_QUEUE_ERROR_RETRIES;
    db.prepare(
      `
        UPDATE vault_processing_queue
        SET
          status = 'error',
          processed_at = @processed_at,
          result_page_id = @result_page_id,
          error_message = @error_message,
          attempts = attempts + 1,
          workflow_version = @workflow_version,
          decision = @decision,
          result_manifest_path = @result_manifest_path,
          last_error_at = @last_error_at,
          last_error_code = @last_error_code,
          retry_after = @retry_after,
          created_page_ids = @created_page_ids,
          updated_page_ids = @updated_page_ids,
          applied_type_names = @applied_type_names,
          proposed_type_names = @proposed_type_names,
          skills_used = @skills_used
        WHERE file_id = @file_id
      `,
    ).run({
      file_id: fileId,
      processed_at: processedAt,
      result_page_id: resultPageId,
      error_message: formatQueueErrorMessage(manifest.reason, autoRetryExhausted),
      workflow_version: CODEX_WORKFLOW_VERSION,
      decision: manifest.decision,
      result_manifest_path: resultManifestPath,
      last_error_at: processedAt,
      last_error_code: failureState.errorCode,
      retry_after: autoRetryExhausted ? null : failureState.retryAfter,
      created_page_ids: serializeArray(manifest.createdPageIds),
      updated_page_ids: serializeArray(manifest.updatedPageIds),
      applied_type_names: serializeArray(manifest.appliedTypeNames),
      proposed_type_names: serializeArray(manifest.proposedTypes.map((item) => item.name)),
      skills_used: serializeArray(manifest.skillsUsed),
    });

    return { status, pageId: resultPageId };
  }

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
        last_error_code = NULL,
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

function createWorkflowTimeoutError(
  phase: "startWorkflow" | "resumeWorkflow" | "collectResult",
  timeoutMs: number,
): AppError {
  return new AppError(`Workflow ${phase} timed out after ${Math.ceil(timeoutMs / 1000)}s`, "runtime", {
    phase,
    timeoutMs,
  });
}

async function runWithWorkflowTimeout<T>(
  phase: "startWorkflow" | "resumeWorkflow" | "collectResult",
  timeoutMs: number,
  controller: AbortController,
  run: () => Promise<T>,
): Promise<T> {
  let timedOut = false;
  const timeoutError = createWorkflowTimeoutError(phase, timeoutMs);
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
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
    errorCode?: string | null;
    retryAfter?: string | null;
    threadId?: string | null;
    resultManifestPath?: string | null;
    autoRetryExhausted?: boolean;
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
        started_at = COALESCE(started_at, @processed_at),
        thread_id = COALESCE(@thread_id, thread_id),
        workflow_version = @workflow_version,
        result_manifest_path = COALESCE(@result_manifest_path, result_manifest_path),
        last_error_at = @last_error_at,
        last_error_code = @last_error_code,
        retry_after = @retry_after
      WHERE file_id = @file_id
    `,
  ).run({
    file_id: fileId,
    processed_at: processedAt,
    error_message: formatQueueErrorMessage(payload.errorMessage, payload.autoRetryExhausted === true),
    thread_id: payload.threadId ?? null,
    workflow_version: CODEX_WORKFLOW_VERSION,
    result_manifest_path: payload.resultManifestPath ?? null,
    last_error_at: processedAt,
    last_error_code: payload.errorCode ?? null,
    retry_after: payload.autoRetryExhausted ? null : payload.retryAfter ?? null,
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

type QueueProcessItemResult = QueueProcessResult["items"][number];

async function processClaimedQueueItem(input: {
  db: Database.Database;
  env: NodeJS.ProcessEnv;
  paths: ReturnType<typeof resolveRuntimePaths>;
  item: VaultQueueItem;
  log?: (message: string) => void;
  workflowRunner: CodexWorkflowRunner;
  templateEvolution: ReturnType<typeof resolveTemplateEvolutionSettings>;
  maxWorkflowAttempts: number;
  workflowTimeoutMs: number;
}): Promise<{ status: VaultQueueStatus; item: QueueProcessItemResult }> {
  const { db, env, paths, item, workflowRunner, templateEvolution, maxWorkflowAttempts, workflowTimeoutMs } = input;
  input.log?.(
    `${item.fileId}: start processing attempt=${item.attempts + 1} queuedAt=${item.queuedAt} thread=${item.threadId ?? "-"}`
  );

  const file = fetchVaultFile(db, item.fileId);
  if (!file) {
    updateQueueStatus(db, item.fileId, {
      status: "error",
      processedAt: toOffsetIso(),
      errorMessage: `Vault file missing from index: ${item.fileId}`,
      incrementAttempts: true,
    });
    input.log?.(`${item.fileId}: error thread=- result=- message=Vault file missing from index`);
    return {
      status: "error",
      item: {
        fileId: item.fileId,
        status: "error",
        reason: "Vault file missing from index",
      },
    };
  }

  let threadId = item.threadId ?? null;
  let resultManifestPath: string | null = null;

  try {
    const localFilePath = await ensureLocalVaultFile(file, paths.vaultPath, env);
    const { artifacts, input: workflowInput } = prepareCodexWorkflowInput(
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
        const mode = threadId ? "resume" : "start";
        const workflowController = new AbortController();
        let loggedStartedThreadId: string | null = null;
        const attemptInput: CodexWorkflowInput = {
          ...workflowInput,
          signal: workflowController.signal,
          onThreadStarted: (startedThreadId) => {
            if (loggedStartedThreadId === startedThreadId) {
              return;
            }
            loggedStartedThreadId = startedThreadId;
            threadId = startedThreadId;
            updateQueueWorkflowTracking(db, item.fileId, {
              threadId: startedThreadId,
              resultManifestPath: artifacts.resultPath,
            });
            input.log?.(
              `${item.fileId}: workflow started mode=${mode} attempt=${attempt}/${maxWorkflowAttempts} thread=${startedThreadId} result=${artifacts.resultPath}`,
            );
          },
        };

        input.log?.(
          `${item.fileId}: launching workflow mode=${mode} attempt=${attempt}/${maxWorkflowAttempts} timeout=${Math.ceil(workflowTimeoutMs / 1000)}s result=${artifacts.resultPath}`,
        );
        const handle = threadId
          ? await runWithWorkflowTimeout("resumeWorkflow", workflowTimeoutMs, workflowController, () =>
              workflowRunner.resumeWorkflow(threadId!, attemptInput),
            )
          : await runWithWorkflowTimeout("startWorkflow", workflowTimeoutMs, workflowController, () =>
              workflowRunner.startWorkflow(attemptInput),
            );
        threadId = handle.threadId;
        if (loggedStartedThreadId !== handle.threadId) {
          loggedStartedThreadId = handle.threadId;
          input.log?.(
            `${item.fileId}: workflow started mode=${mode} attempt=${attempt}/${maxWorkflowAttempts} thread=${handle.threadId} result=${artifacts.resultPath}`,
          );
        }
        updateQueueWorkflowTracking(db, item.fileId, {
          threadId: handle.threadId,
          resultManifestPath: artifacts.resultPath,
        });

        input.log?.(
          `${item.fileId}: waiting for workflow result thread=${handle.threadId} attempt=${attempt}/${maxWorkflowAttempts} result=${artifacts.resultPath}`,
        );
        const collectController = new AbortController();
        const manifest = await runWithWorkflowTimeout("collectResult", workflowTimeoutMs, collectController, () =>
          workflowRunner.collectResult(handle, {
            ...workflowInput,
            signal: collectController.signal,
          }),
        );
        assertTemplateEvolutionAllowed(manifest, templateEvolution);
        finalOutcome = {
          outcome: applyWorkflowManifest(db, item.fileId, manifest, artifacts.resultPath, item.attempts),
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
            outcome: applyWorkflowManifest(db, item.fileId, recoveredManifest, artifacts.resultPath, item.attempts),
            manifest: recoveredManifest,
            handleThreadId: recoveredManifest.threadId,
          };
          input.log?.(
            `${item.fileId}: recovered persisted workflow result status=${recoveredManifest.status} thread=${recoveredManifest.threadId} ${formatManifestLogFields(recoveredManifest)} result=${artifacts.resultPath} message=${formatWorkflowError(error)}`,
          );
          break;
        }

        if (!shouldRetryWorkflowAttempt(error, attempt, maxWorkflowAttempts)) {
          throw error;
        }

        input.log?.(
          `${item.fileId}: retrying workflow attempt ${attempt + 1}/${maxWorkflowAttempts} thread=${threadId ?? "-"} result=${artifacts.resultPath} message=${formatWorkflowError(error)}`,
        );
      }
    }

    if (!finalOutcome) {
      throw (lastWorkflowError ?? new AppError("Workflow completed without a result", "runtime"));
    }

    input.log?.(
      `${item.fileId}: ${finalOutcome.outcome.status} thread=${finalOutcome.handleThreadId} ${formatManifestLogFields(finalOutcome.manifest)} result=${artifacts.resultPath}`,
    );
    return {
      status: finalOutcome.outcome.status,
      item: {
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
      },
    };
  } catch (error) {
    const recoveredManifest = shouldAttemptManifestRecovery(error)
      ? readRecoverableWorkflowResult(resultManifestPath, threadId)
      : null;
    if (recoveredManifest && resultManifestPath) {
      assertTemplateEvolutionAllowed(recoveredManifest, templateEvolution);
      const recoveredOutcome = applyWorkflowManifest(
        db,
        item.fileId,
        recoveredManifest,
        resultManifestPath,
        item.attempts,
      );
      input.log?.(
        `${item.fileId}: recovered persisted workflow result after terminal failure status=${recoveredOutcome.status} thread=${recoveredManifest.threadId} ${formatManifestLogFields(recoveredManifest)} result=${resultManifestPath} message=${formatWorkflowError(error)}`,
      );
      return {
        status: recoveredOutcome.status,
        item: {
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
        },
      };
    }

    const message = formatWorkflowError(error);
    const failureState = buildQueueFailureState(message, {
      explicitCode: extractErrorDetailsCode(error),
      errorType: error instanceof AppError ? error.type : null,
    });
    const autoRetryExhausted =
      failureState.autoRetryEligible && item.attempts >= MAX_QUEUE_ERROR_RETRIES;
    updateQueueWorkflowError(db, item.fileId, {
      errorMessage: message,
      errorCode: failureState.errorCode,
      retryAfter: failureState.retryAfter,
      threadId,
      resultManifestPath,
      autoRetryExhausted,
    });
    input.log?.(
      `${item.fileId}: error thread=${threadId ?? "-"} result=${resultManifestPath ?? "-"} message=${message}${autoRetryExhausted ? ` autoRetryLimit=${MAX_QUEUE_ERROR_RETRIES}` : ""}`,
    );
    return {
      status: "error",
      item: {
        fileId: item.fileId,
        status: "error",
        pageId: item.resultPageId ?? null,
        reason: message,
        threadId,
        resultManifestPath,
      },
    };
  }
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
  const { db } = openDb(paths.dbPath, config, Number.parseInt(env.EMBEDDING_DIMENSIONS ?? "384", 10) || 384, paths.packageRoot);

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

export function getVaultQueueItem(
  env: NodeJS.ProcessEnv = process.env,
  fileId: string,
): VaultQueueItem | null {
  const paths = resolveRuntimePaths(env);
  const config = loadConfig(paths.configPath);
  const { db } = openDb(paths.dbPath, config, Number.parseInt(env.EMBEDDING_DIMENSIONS ?? "384", 10) || 384, paths.packageRoot);

  try {
    return fetchQueueItemByFileId(db, fileId);
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
    filterFileIds?: string[];
    shouldStop?: () => boolean;
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
  const { db } = openDb(paths.dbPath, config, Number.parseInt(env.EMBEDDING_DIMENSIONS ?? "384", 10) || 384, paths.packageRoot);

  try {
    const result: QueueProcessResult = {
      enabled: true,
      processed: 0,
      done: 0,
      skipped: 0,
      errored: 0,
      items: [],
    };
    const workflowRunner = options.workflowRunner ?? createDefaultWorkflowRunner(env);
    const templateEvolution = resolveTemplateEvolutionSettings(env);
    const maxWorkflowAttempts = isInlineRetryCapable(workflowRunner) ? INLINE_WORKFLOW_ATTEMPTS : 1;
    const workflowTimeoutMs = agentSettings.workflowTimeoutSeconds * 1000;
    const workerSlots = Math.max(0, options.maxItems ?? agentSettings.batchSize);
    const attemptedFileIds = new Set<string>();
    const orderedItems: Array<{ sequence: number; item: QueueProcessItemResult }> = [];
    let nextSequence = 0;

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

    const claimNextQueueItem = (): { sequence: number; item: VaultQueueItem } | null => {
      if (options.shouldStop?.() === true) {
        return null;
      }

      const remainingFilterFileIds = options.filterFileIds?.filter((fileId) => !attemptedFileIds.has(fileId));
      if (options.filterFileIds && remainingFilterFileIds?.length === 0) {
        return null;
      }

      const item = claimQueueItems(db, 1, {
        filterFileIds: remainingFilterFileIds,
        excludeFileIds: attemptedFileIds,
      })[0];
      if (!item) {
        return null;
      }

      attemptedFileIds.add(item.fileId);
      options.log?.(`claimed 1 items: ${item.fileId}`);
      return {
        sequence: nextSequence++,
        item,
      };
    };

    const workerCount = options.filterFileIds
      ? Math.min(workerSlots, options.filterFileIds.length)
      : workerSlots;
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const claimed = claimNextQueueItem();
        if (!claimed) {
          return;
        }

        const processed = await processClaimedQueueItem({
          db,
          env,
          paths,
          item: claimed.item,
          log: options.log,
          workflowRunner,
          templateEvolution,
          maxWorkflowAttempts,
          workflowTimeoutMs,
        });
        countOutcome(processed.status);
        orderedItems.push({
          sequence: claimed.sequence,
          item: processed.item,
        });
      }
    });

    await Promise.all(workers);
    result.items = orderedItems
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => entry.item);

    if (result.items.length > 0) {
      options.log?.(`processed ${result.items.length} queue items with workerPool=${workerCount}`);
    }

    return result;
  } finally {
    db.close();
  }
}

export function getWikiAgentStatus(env: NodeJS.ProcessEnv = process.env) {
  return resolveAgentSettings(env);
}

import type { CodexWorkflowRunner } from "../core/codex-workflow.js";
import { getTemplate } from "../core/config.js";
import { resolveAgentSettings } from "../core/paths.js";
import { createPageFromTemplate } from "../core/page-files.js";
import { loadRuntimeConfig } from "../core/runtime.js";
import { syncWorkspace, type SyncOptions } from "../core/sync.js";
import { getVaultQueueItem, processVaultQueueBatch, type QueueProcessResult } from "../core/vault-processing.js";
import type { SyncResult, VaultQueueStatus } from "../types/page.js";
import { AppError } from "../utils/errors.js";

export interface CreatePageOptions {
  type: string;
  title: string;
  nodeId?: string;
}

export interface RunSyncCommandOptions extends Omit<SyncOptions, "env"> {
  process?: boolean;
  vaultFileId?: string;
  workflowRunner?: CodexWorkflowRunner;
}

export type QueueProcessNoopReason = "already_done" | "already_skipped" | null;

export interface SyncQueueProcessResult extends Omit<QueueProcessResult, "enabled"> {
  enabled: true;
  requestedFileId: string | null;
  currentStatus: VaultQueueStatus | null;
  noopReason: QueueProcessNoopReason;
}

export interface SyncCommandResult extends SyncResult {
  queueProcess: SyncQueueProcessResult | null;
}

function assertValidSyncCommandOptions(options: RunSyncCommandOptions): void {
  if (options.vaultFileId && !options.process) {
    throw new AppError("--vault-file requires --process.", "config");
  }

  if (options.process && options.targetPaths && options.targetPaths.length > 0) {
    throw new AppError("--process cannot be combined with --path.", "config");
  }
}

function assertQueueProcessingEnabled(env: NodeJS.ProcessEnv): void {
  const agentSettings = resolveAgentSettings(env, { strict: true });
  if (!agentSettings.enabled) {
    throw new AppError("Queue processing requires WIKI_AGENT_ENABLED=true.", "config");
  }
  if (agentSettings.batchSize === 0) {
    throw new AppError("Queue processing requires WIKI_AGENT_BATCH_SIZE > 0.", "config");
  }
}

function buildQueueProcessResult(
  queueResult: QueueProcessResult,
  meta: {
    requestedFileId?: string | null;
    currentStatus?: VaultQueueStatus | null;
    noopReason?: QueueProcessNoopReason;
  } = {},
): SyncQueueProcessResult {
  if (!queueResult.enabled) {
    throw new AppError("Queue processing is disabled.", "config");
  }

  return {
    ...queueResult,
    enabled: true,
    requestedFileId: meta.requestedFileId ?? null,
    currentStatus: meta.currentStatus ?? null,
    noopReason: meta.noopReason ?? null,
  };
}

function buildQueueProcessNoopResult(
  fileId: string,
  status: Extract<VaultQueueStatus, "done" | "skipped">,
): SyncQueueProcessResult {
  return {
    enabled: true,
    requestedFileId: fileId,
    processed: 0,
    done: 0,
    skipped: 0,
    errored: 0,
    items: [],
    currentStatus: status,
    noopReason: status === "done" ? "already_done" : "already_skipped",
  };
}

export async function runSync(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<SyncOptions, "env"> = {},
) {
  return syncWorkspace({
    ...options,
    env,
  });
}

async function processQueueAfterSync(
  env: NodeJS.ProcessEnv,
  options: Pick<RunSyncCommandOptions, "vaultFileId" | "workflowRunner">,
): Promise<SyncQueueProcessResult> {
  assertQueueProcessingEnabled(env);

  if (!options.vaultFileId) {
    return buildQueueProcessResult(
      await processVaultQueueBatch(env, {
        workflowRunner: options.workflowRunner,
      }),
    );
  }

  const requestedFileId = options.vaultFileId;
  const queueItem = getVaultQueueItem(env, requestedFileId);
  if (!queueItem) {
    throw new AppError(`Vault queue item not found: ${requestedFileId}`, "not_found");
  }

  if (queueItem.status === "processing") {
    throw new AppError(`Vault queue item is already processing: ${requestedFileId}`, "runtime", {
      fileId: requestedFileId,
      status: queueItem.status,
    });
  }

  if (queueItem.status === "done" || queueItem.status === "skipped") {
    return buildQueueProcessNoopResult(requestedFileId, queueItem.status);
  }

  const queueResult = await processVaultQueueBatch(env, {
    maxItems: 1,
    filterFileIds: [requestedFileId],
    workflowRunner: options.workflowRunner,
  });
  if (queueResult.processed > 0) {
    return buildQueueProcessResult(queueResult, {
      requestedFileId,
      currentStatus: getVaultQueueItem(env, requestedFileId)?.status ?? null,
    });
  }

  const current = getVaultQueueItem(env, requestedFileId);
  if (!current) {
    throw new AppError(`Vault queue item not found: ${requestedFileId}`, "not_found");
  }
  if (current.status === "done" || current.status === "skipped") {
    return buildQueueProcessNoopResult(requestedFileId, current.status);
  }
  if (current.status === "processing") {
    throw new AppError(`Vault queue item is already processing: ${requestedFileId}`, "runtime", {
      fileId: requestedFileId,
      status: current.status,
    });
  }

  throw new AppError(`Failed to claim vault queue item for processing: ${requestedFileId}`, "runtime", {
    fileId: requestedFileId,
    status: current.status,
  });
}

export async function runSyncCommand(
  env: NodeJS.ProcessEnv = process.env,
  options: RunSyncCommandOptions = {},
): Promise<SyncCommandResult> {
  assertValidSyncCommandOptions(options);

  const syncResult = await runSync(env, {
    targetPaths: options.targetPaths,
    force: options.force,
    skipEmbedding: options.skipEmbedding,
  });

  if (!options.process) {
    return {
      ...syncResult,
      queueProcess: null,
    };
  }

  return {
    ...syncResult,
    queueProcess: await processQueueAfterSync(env, {
      vaultFileId: options.vaultFileId,
      workflowRunner: options.workflowRunner,
    }),
  };
}

export async function createPage(
  env: NodeJS.ProcessEnv = process.env,
  options: CreatePageOptions,
): Promise<{ created: string; filePath: string }> {
  const { paths, config } = loadRuntimeConfig(env);
  getTemplate(config, options.type);
  const created = createPageFromTemplate(paths, config, {
    pageType: options.type,
    title: options.title,
    nodeId: options.nodeId ?? undefined,
  });
  await syncWorkspace({
    env,
    targetPaths: [created.pageId],
  });

  return {
    created: created.pageId,
    filePath: created.filePath,
  };
}

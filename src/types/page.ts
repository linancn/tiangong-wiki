import type { LoadedWikiConfig } from "./config.js";

export type PageStatus = "draft" | "active" | "archived" | string;
export type Visibility = "private" | "shared" | "public" | string;
export type EmbeddingStatus = "pending" | "done" | "error";
export type VaultHashMode = "content" | "mtime";
export type VaultQueueStatus = "pending" | "processing" | "done" | "skipped" | "error";
export type WikiAgentBackend = "codex-workflow";
export type WikiAgentSandboxMode = "danger-full-access" | "workspace-write";
export type VaultWorkflowDecision = "skip" | "apply" | "propose_only";
export type TemplateEvolutionMode = "proposal" | "apply";

export interface Page {
  id: string;
  nodeId: string | null;
  title: string;
  pageType: string;
  status: PageStatus;
  visibility: Visibility;
  tags: string[];
  extra: Record<string, unknown>;
  filePath: string;
  contentHash: string | null;
  summaryText: string;
  embeddingStatus: EmbeddingStatus;
  fileMtime: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  indexedAt: string | null;
}

export interface Edge {
  source: string;
  target: string;
  edgeType: string;
  sourcePage: string;
  metadata: Record<string, unknown>;
}

export interface VaultFile {
  id: string;
  fileName: string;
  fileExt: string | null;
  sourceType: string | null;
  fileSize: number;
  filePath: string;
  contentHash: string | null;
  fileMtime: number | null;
  indexedAt: string;
}

export interface VaultChange {
  fileId: string;
  action: "added" | "modified" | "removed";
  detectedAt: string;
  syncId: string;
}

export interface VaultQueueItem {
  fileId: string;
  status: VaultQueueStatus;
  priority: number;
  queuedAt: string;
  claimedAt?: string | null;
  startedAt?: string | null;
  heartbeatAt?: string | null;
  processingOwnerId?: string | null;
  processedAt: string | null;
  resultPageId: string | null;
  errorMessage: string | null;
  attempts: number;
  threadId?: string | null;
  workflowVersion?: string | null;
  decision?: VaultWorkflowDecision | null;
  resultManifestPath?: string | null;
  lastErrorAt?: string | null;
  lastErrorCode?: string | null;
  retryAfter?: string | null;
  autoRetryExhausted?: boolean;
  createdPageIds?: string[];
  updatedPageIds?: string[];
  appliedTypeNames?: string[];
  proposedTypeNames?: string[];
  skillsUsed?: string[];
  fileName?: string;
  fileExt?: string | null;
  sourceType?: string | null;
  fileSize?: number;
  filePath?: string;
}

export interface VaultQueueStats {
  totalPending: number;
  totalProcessing: number;
  totalDone: number;
  totalSkipped: number;
  totalError: number;
}

export interface AgentProcessingSettings {
  enabled: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  batchSize: number;
  sandboxMode: WikiAgentSandboxMode;
  workflowTimeoutSeconds: number;
  configured: boolean;
  missing: string[];
}

export interface SourceSummarySections {
  sourceInfo: string;
  coreContent: string;
  keyConclusions: string;
  relationToExistingKnowledge: string;
  importantQuotes: string;
}

export type VaultAgentDecision =
  | {
      action: "skip";
      reason: string;
    }
  | {
      action: "create";
      title: string;
      tags?: string[];
      keyFindings: string[];
      sections: SourceSummarySections;
    }
  | {
      action: "update";
      targetPageId: string;
      title?: string;
      tags?: string[];
      keyFindings: string[];
      sections: SourceSummarySections;
    };

export interface VaultAgentContext {
  file: VaultFile;
  localFilePath: string;
  contentPreview: string;
  existingPageId: string | null;
  existingPageContent: string | null;
  instructionText: string;
  templateText: string;
  wikiStats: StatResult;
}

export interface VaultAutoProcessResult {
  attempted: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  results: Array<{
    fileId: string;
    status: VaultQueueStatus;
    resultPageId: string | null;
    errorMessage: string | null;
  }>;
}

export interface ParseIssue {
  filePath: string;
  code:
    | "yaml_parse_error"
    | "missing_page_type"
    | "missing_title"
    | "unknown_page_type"
    | "invalid_frontmatter";
  message: string;
  details?: unknown;
}

export interface ParsedPage {
  page: Page;
  columnValues: Record<string, unknown>;
  edges: Edge[];
  summaryText: string;
  body: string;
  rawData: Record<string, unknown>;
  unregisteredFields: string[];
}

export type ParsePageResult =
  | { ok: true; parsed: ParsedPage }
  | { ok: false; error: ParseIssue };

export interface ScanEntry {
  id: string;
  filePath: string;
  contentHash: string;
  fileMtime: number;
}

export interface ScanResult {
  added: ScanEntry[];
  modified: ScanEntry[];
  deleted: Array<{ id: string; filePath: string }>;
  unchanged: ScanEntry[];
}

export interface ApplyChangesResult {
  inserted: string[];
  updated: string[];
  deleted: string[];
  summaryChangedIds: string[];
  parseErrors: ParseIssue[];
}

export interface SyncResult {
  mode: "full" | "path";
  upgradedToFullSync: boolean;
  configChanged: boolean;
  profileChanged: boolean;
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
  summaryChanged: number;
  embedding: {
    enabled: boolean;
    skipped: boolean;
    attempted: number;
    succeeded: number;
    failed: number;
    embedAll: boolean;
  };
  vault: {
    scanned: boolean;
    files: number;
    changes: number;
    syncId: string | null;
    queue: {
      pendingAdded: number;
      pendingReset: number;
      removed: number;
    };
  };
}

export interface LintItem {
  page: string;
  check: string;
  message: string;
}

export interface LintResult {
  pages: number;
  errors: LintItem[];
  warnings: LintItem[];
  info: LintItem[];
}

export interface StatResult {
  totalPages: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  totalEdges: number;
  orphanPages: number;
  embeddingStatus: Record<string, number>;
  vaultFiles: number;
  lastSyncAt: string | null;
  registeredTemplates: number;
}

export interface RuntimeContext {
  config: LoadedWikiConfig;
  paths: RuntimePaths;
}

export interface RuntimePaths {
  wikiPath: string;
  wikiRoot: string;
  vaultPath: string;
  vaultHashMode: VaultHashMode;
  agentBackend: WikiAgentBackend;
  dbPath: string;
  configPath: string;
  templatesPath: string;
  queueArtifactsPath: string;
  packageRoot: string;
  syncIntervalSeconds: number;
  daemonHost: string;
  daemonPort: number | null;
  daemonPidPath: string;
  daemonLogPath: string;
  daemonStatePath: string;
  auditLogPath: string;
}

export type DaemonLaunchMode = "run" | "start";
export type DaemonTask =
  | "idle"
  | "sync"
  | "rebuild-fts"
  | "sync-trigger"
  | "cycle"
  | "create"
  | "update"
  | "queue-retry"
  | "template-create"
  | "shutdown";

export type DaemonWriteJobStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out";

export interface DaemonWriteJobSnapshot {
  jobId: string;
  taskType: DaemonTask;
  status: DaemonWriteJobStatus;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  timeoutMs: number;
  queueDepthAtEnqueue: number;
  positionInQueue: number | null;
  resultSummary: Record<string, unknown> | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
}

export interface DaemonWriteQueueSummary {
  limits: {
    maxDepth: number;
    jobTimeoutMs: number;
  };
  counts: {
    queued: number;
    running: number;
    recent: number;
  };
  activeJob: DaemonWriteJobSnapshot | null;
  queuedJobs: DaemonWriteJobSnapshot[];
  recentJobs: DaemonWriteJobSnapshot[];
  generatedAt: string;
}

export interface WriteActorMetadata {
  actorId: string;
  actorType: string;
  requestId: string;
}

export interface DaemonWriteMeta {
  requestId: string;
  actorId: string;
  actorType: string;
  auditLogPath: string;
  git: {
    status: "committed" | "no_changes" | "degraded";
    commitHash: string | null;
    pushScheduled: boolean;
  };
}

export interface DaemonState {
  pid: number;
  host: string;
  port: number;
  launchMode: DaemonLaunchMode;
  startedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: "ok" | "error" | null;
  lastError: string | null;
  syncIntervalSeconds: number;
  currentTask: DaemonTask;
}

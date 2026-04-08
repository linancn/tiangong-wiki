export type DashboardTab = "observatory" | "system" | "queue" | "logs" | "vault" | "lint";
export type DashboardLogLevel = "info" | "warning" | "error";
export type DashboardDoctorSeverity = "ok" | "warn" | "error";

export type PageType =
  | "concept"
  | "method"
  | "lesson"
  | "source-summary"
  | "research-note"
  | "misconception"
  | "bridge"
  | "person"
  | "achievement"
  | "faq"
  | "resume"
  | string;

export interface DashboardPageSummary {
  id: string;
  title: string;
  pageType: PageType;
  status: string;
  filePath: string;
  tags: string[];
  updatedAt: string | null;
  nodeId?: string;
}

export interface DashboardGraphNode extends DashboardPageSummary {
  nodeKey: string;
  degree: number;
  orphan: boolean;
  embeddingStatus: unknown | null;
  sourceType: unknown | null;
}

export interface DashboardGraphEdge {
  source: string;
  target: string;
  edgeType: string;
  sourcePage: string | null;
}

export interface DashboardGraphOverview {
  nodes: DashboardGraphNode[];
  edges: DashboardGraphEdge[];
  totalNodes: number;
  visibleNodeCount: number;
  totalEdges: number;
  visibleEdgeCount: number;
  truncated: boolean;
  sampleStrategy?: {
    limit: number;
    priorities: string[];
  };
  generatedAt: string;
}

export interface DashboardSearchResult extends DashboardPageSummary {
  summaryText?: string;
  searchKind?: string;
}

export interface DashboardGraphSearchResponse {
  query: string;
  mode: "empty" | "fts" | "hybrid" | "fallback";
  resultCount?: number;
  results: DashboardSearchResult[];
  generatedAt: string;
}

export interface DashboardStatus {
  daemon: {
    running: boolean;
    pid: number | null;
    host: string | null;
    port: number | null;
    lastSyncAt: string | null;
    nextSyncAt: string | null;
    lastResult: "ok" | "error" | null;
    syncIntervalSeconds: number | null;
    launchMode: string | null;
    currentTask: string | null;
    startedAt: string | null;
    uptimeMs: number | null;
    state?: Record<string, unknown> | null;
  };
  stats?: Record<string, unknown>;
  queue: {
    pending: number;
    processing: number;
    done: number;
    skipped: number;
    error: number;
  };
  runtime?: {
    vaultSource?: string;
    wikiPath?: string;
    vaultPath?: string;
    dbPath?: string;
  };
  doctor?: {
    ok?: boolean;
    status?: string;
    summary?: {
      ok: number;
      warn: number;
      error: number;
    };
    checks?: Array<{
      id?: string;
      name?: string;
      severity?: DashboardDoctorSeverity | string;
      status?: string;
      summary?: string;
      message?: string;
      recommendation?: string;
      [key: string]: unknown;
    }>;
    recommendations?: string[];
    [key: string]: unknown;
  };
  generatedAt: string;
  lastSyncAt: string | null;
}

export interface DashboardQueueTiming {
  queuedAt?: string | null;
  claimedAt?: string | null;
  startedAt?: string | null;
  processedAt?: string | null;
  lastErrorAt?: string | null;
  retryAfter?: string | null;
  queueAgeMs?: number | null;
  waitDurationMs?: number | null;
  processingDurationMs?: number | null;
  totalDurationMs?: number | null;
}

export interface DashboardQueueItem {
  fileId: string;
  fileName?: string | null;
  fileExt?: string | null;
  filePath?: string | null;
  sourceType?: string | null;
  fileSize?: number | null;
  status: string;
  priority?: number | null;
  attempts?: number | null;
  decision?: string | null;
  threadId?: string | null;
  workflowVersion?: string | null;
  errorMessage?: string | null;
  resultPageId?: string | null;
  resultManifestPath?: string | null;
  createdPageIds?: string[];
  updatedPageIds?: string[];
  appliedTypeNames?: string[];
  proposedTypeNames?: string[];
  skillsUsed?: string[];
  timing?: DashboardQueueTiming;
}

export interface DashboardQueueSummary {
  counts: {
    pending: number;
    processing: number;
    done: number;
    skipped: number;
    error: number;
    total: number;
  };
  processing: DashboardQueueItem[];
  errors: DashboardQueueItem[];
  recentDone: DashboardQueueItem[];
  generatedAt: string;
}

export interface DashboardQueueListResponse {
  total: number;
  items: DashboardQueueItem[];
  generatedAt: string;
}

export interface DashboardQueueItemDetail {
  item: DashboardQueueItem;
  artifacts?: {
    artifactId?: string;
    rootDir?: string;
    queueItemPath?: string;
    promptPath?: string;
    resultPath?: string;
    skillArtifactsPath?: string;
    queueItem?: {
      exists: boolean;
      rawText: string | null;
      parsed: unknown;
      parseError: string | null;
    };
    prompt?: {
      exists: boolean;
      rawText: string | null;
      preview: string;
    };
    result?: {
      exists: boolean;
      rawText: string | null;
      parsed: unknown;
      parseError: string | null;
    };
  };
  linkedPages?: DashboardPageSummary[];
  generatedAt: string;
}

export interface DashboardPageRelation {
  direction: "incoming" | "outgoing";
  edgeType: string;
  source?: DashboardPageSummary | null;
  target?: DashboardPageSummary | null;
  rawSource?: string;
  rawTarget?: string;
}

export interface DashboardPageDetailResponse {
  page: DashboardPageSummary & {
    nodeKey: string;
    summaryText: string;
    embeddingStatus: unknown | null;
    markdownPreview: string;
    frontmatter: Record<string, unknown>;
    unregisteredFields: string[];
    pagePath: string;
  };
  relations: DashboardPageRelation[];
  relationCounts: {
    outgoing: number;
    incoming: number;
  };
  generatedAt: string;
}

export interface DashboardPageSourceResponse {
  pageSource: {
    pageId: string;
    pagePath: string;
    rawMarkdown: string | null;
    frontmatter: Record<string, unknown>;
  };
  vaultSource?: {
    fileId?: string;
    fileName?: string | null;
    fileExt?: string | null;
    sourceType?: string | null;
    fileSize?: number | null;
    remotePath?: string | null;
    indexedAt?: string | null;
    cacheStatus?: string;
    localPath?: string | null;
    metadataPath?: string | null;
    previewAvailable?: boolean;
    preview?: string;
    previewError?: string | null;
    missing?: boolean;
  } | null;
  generatedAt: string;
}

export interface DashboardOpenSourceResult {
  opened: boolean;
  target: "vault" | "page";
  path: string;
  fileId?: string;
}

export interface DashboardVaultSummary {
  totalFiles: number;
  totalBytes: number;
  coverage: {
    pending: number;
    processing: number;
    done: number;
    skipped: number;
    error: number;
    notQueued: number;
  };
  bySourceType: Record<string, { count: number; totalBytes: number }>;
  cacheStatus: Record<string, number>;
  mappedPages: number;
  generatedAt: string;
}

export interface DashboardVaultFile {
  fileId: string;
  fileName: string;
  fileExt: string | null;
  sourceType: string | null;
  fileSize: number;
  filePath: string;
  indexedAt: string | null;
  queueStatus: string;
  queueItem: DashboardQueueItem | null;
  generatedPageCount: number;
  cacheStatus: string;
  localPath?: string | null;
}

export interface DashboardVaultFilesResponse {
  total: number;
  items: DashboardVaultFile[];
  generatedAt: string;
}

export interface DashboardVaultFileDetail {
  file: DashboardVaultFile & {
    id?: string;
    contentHash?: string | null;
    fileMtime?: number | null;
    metadataPath?: string | null;
    previewAvailable?: boolean;
    preview?: string;
    previewError?: string | null;
  };
  queueItem: DashboardQueueItem | null;
  relatedPages: DashboardPageSummary[];
  generatedAt: string;
}

export interface DashboardLintSummary {
  counts: {
    error: number;
    warning: number;
    info: number;
    total: number;
  };
  topRules: Array<{ rule: string; count: number }>;
  topPages: Array<{ pageId: string; count: number }>;
  generatedAt: string;
}

export interface DashboardLintIssue {
  level: DashboardLogLevel;
  pageId: string;
  check: string;
  message: string;
  pageTitle?: string | null;
  pageType?: string | null;
  nodeId?: string | null;
  filePath?: string | null;
}

export interface DashboardLintIssueGroup {
  key: string;
  count: number;
  levelCounts: Record<string, number>;
  pageTitle?: string | null;
  pageType?: string | null;
  items: DashboardLintIssue[];
}

export interface DashboardLintIssuesResponse {
  total: number;
  items?: DashboardLintIssue[];
  groups?: DashboardLintIssueGroup[];
  groupBy?: "flat" | "page" | "rule";
  generatedAt: string;
}

export interface DashboardLogEntry {
  id: number;
  timestamp: string;
  level: "info" | "error";
  message: string;
  line: string;
  fileId: string | null;
}

export interface DashboardUrlState {
  tab: DashboardTab;
  selectedPageId: string | null;
  query: string;
}

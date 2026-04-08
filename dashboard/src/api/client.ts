import type {
  DashboardGraphOverview,
  DashboardGraphSearchResponse,
  DashboardLintIssuesResponse,
  DashboardLintSummary,
  DashboardLogEntry,
  DashboardOpenSourceResult,
  DashboardPageDetailResponse,
  DashboardPageSourceResponse,
  DashboardQueueItemDetail,
  DashboardQueueListResponse,
  DashboardQueueSummary,
  DashboardStatus,
  DashboardVaultFileDetail,
  DashboardVaultFilesResponse,
  DashboardVaultSummary,
} from "../types/dashboard";

export class DashboardApiError extends Error {
  readonly status: number;

  readonly bodyText: string | null;

  constructor(message: string, status: number, bodyText: string | null = null) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export interface LogStreamOptions {
  history?: number;
  level?: "info" | "error";
  fileId?: string;
  query?: string;
  onHistory: (entries: DashboardLogEntry[]) => void;
  onLog: (entry: DashboardLogEntry) => void;
  onError?: (event: Event) => void;
  onOpen?: () => void;
}

export interface LogStreamHandle {
  close: () => void;
}

function defaultDashboardApiBasePath(): string {
  const configuredBasePath =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DASHBOARD_API_BASE_PATH === "string"
      ? import.meta.env.VITE_DASHBOARD_API_BASE_PATH.trim()
      : "";
  if (configuredBasePath) {
    return configuredBasePath.replace(/\/+$/g, "");
  }
  return "/api/dashboard";
}

function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    query.set(key, String(value));
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function normalizeLogEntry(raw: unknown): DashboardLogEntry | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.message !== "string" || typeof value.timestamp !== "string") {
    return null;
  }

  return {
    id: typeof value.id === "number" ? value.id : Number.parseInt(String(value.id ?? "0"), 10) || 0,
    timestamp: value.timestamp,
    level: value.level === "error" ? "error" : "info",
    message: value.message,
    line: typeof value.line === "string" ? value.line : value.message,
    fileId: typeof value.fileId === "string" ? value.fileId : null,
  };
}

export class DashboardApiClient {
  private readonly basePath: string;

  constructor(basePath = defaultDashboardApiBasePath()) {
    this.basePath = basePath;
  }

  async getStatus(): Promise<DashboardStatus> {
    return this.request<DashboardStatus>("/status");
  }

  async refreshStatus(): Promise<DashboardStatus> {
    return this.request<DashboardStatus>("/status/refresh", {
      method: "POST",
    });
  }

  async getGraphOverview(limit = 120): Promise<DashboardGraphOverview> {
    return this.request<DashboardGraphOverview>(`/graph/overview${buildQuery({ limit })}`);
  }

  async searchGraph(query: string, limit = 20): Promise<DashboardGraphSearchResponse> {
    return this.request<DashboardGraphSearchResponse>(`/graph/search${buildQuery({ query, limit })}`);
  }

  async getQueueSummary(): Promise<DashboardQueueSummary> {
    return this.request<DashboardQueueSummary>("/queue/summary");
  }

  async listQueueItems(options: {
    status?: string;
    query?: string;
    sourceType?: string;
    limit?: number;
  } = {}): Promise<DashboardQueueListResponse> {
    return this.request<DashboardQueueListResponse>(`/queue/items${buildQuery(options)}`);
  }

  async getQueueItemDetail(fileId: string): Promise<DashboardQueueItemDetail> {
    return this.request<DashboardQueueItemDetail>(`/queue/items/${encodeURIComponent(fileId)}`);
  }

  async retryQueueItem(fileId: string): Promise<{ status: string; item: unknown }> {
    return this.request<{ status: string; item: unknown }>(`/queue/items/${encodeURIComponent(fileId)}/retry`, {
      method: "POST",
    });
  }

  async getPageDetail(pageId: string): Promise<DashboardPageDetailResponse> {
    return this.request<DashboardPageDetailResponse>(`/pages/${encodeURIComponent(pageId)}`);
  }

  async getPageSource(pageId: string): Promise<DashboardPageSourceResponse> {
    return this.request<DashboardPageSourceResponse>(`/pages/${encodeURIComponent(pageId)}/source`);
  }

  async openPageSource(pageId: string, target: "vault" | "page"): Promise<DashboardOpenSourceResult> {
    return this.request<DashboardOpenSourceResult>(`/pages/${encodeURIComponent(pageId)}/open-source`, {
      method: "POST",
      body: JSON.stringify({ target }),
      headers: {
        "content-type": "application/json",
      },
    });
  }

  async getVaultSummary(): Promise<DashboardVaultSummary> {
    return this.request<DashboardVaultSummary>("/vault/summary");
  }

  async listVaultFiles(options: {
    query?: string;
    sourceType?: string;
    queueStatus?: string;
    limit?: number;
  } = {}): Promise<DashboardVaultFilesResponse> {
    return this.request<DashboardVaultFilesResponse>(`/vault/files${buildQuery(options)}`);
  }

  async getVaultFileDetail(fileId: string): Promise<DashboardVaultFileDetail> {
    return this.request<DashboardVaultFileDetail>(`/vault/files/${encodeURIComponent(fileId)}`);
  }

  async openVaultFile(fileId: string): Promise<{ opened: boolean; fileId: string; path: string }> {
    return this.request<{ opened: boolean; fileId: string; path: string }>(`/vault/files/${encodeURIComponent(fileId)}/open`, {
      method: "POST",
    });
  }

  async getLintSummary(): Promise<DashboardLintSummary> {
    return this.request<DashboardLintSummary>("/lint/summary");
  }

  async listLintIssues(options: {
    level?: string;
    groupBy?: string;
    rule?: string;
    pageId?: string;
  } = {}): Promise<DashboardLintIssuesResponse> {
    return this.request<DashboardLintIssuesResponse>(`/lint/issues${buildQuery(options)}`);
  }

  streamLogs(options: LogStreamOptions): LogStreamHandle {
    const stream = new EventSource(
      `${this.basePath}/logs/stream${buildQuery({
        history: options.history,
        level: options.level,
        fileId: options.fileId,
        query: options.query,
      })}`,
    );

    const onHistory = (event: Event) => {
      const messageEvent = event as MessageEvent;
      try {
        const payload = JSON.parse(messageEvent.data) as unknown[];
        options.onHistory(
          payload
            .map((entry) => normalizeLogEntry(entry))
            .filter((entry): entry is DashboardLogEntry => entry !== null),
        );
      } catch {
        options.onHistory([]);
      }
    };

    const onLog = (event: Event) => {
      const messageEvent = event as MessageEvent;
      try {
        const payload = JSON.parse(messageEvent.data);
        const entry = normalizeLogEntry(payload);
        if (entry) {
          options.onLog(entry);
        }
      } catch {
        // Ignore malformed events from a broken stream.
      }
    };

    stream.addEventListener("history", onHistory);
    stream.addEventListener("log", onLog);
    stream.onerror = (event) => options.onError?.(event);
    stream.onopen = () => options.onOpen?.();

    return {
      close: () => {
        stream.removeEventListener("history", onHistory);
        stream.removeEventListener("log", onLog);
        stream.close();
      },
    };
  }

  private async request<T>(routePath: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.basePath}${routePath}`, {
      method: "GET",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => null);
      throw new DashboardApiError(
        `Dashboard API request failed (${response.status}) for ${routePath}`,
        response.status,
        bodyText,
      );
    }

    return (await response.json()) as T;
  }
}

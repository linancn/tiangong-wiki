import type {
  DashboardDoctorSeverity,
  DashboardLintIssuesResponse,
  DashboardLintSummary,
  DashboardLogEntry,
  DashboardQueueItemDetail,
  DashboardQueueListResponse,
  DashboardQueueSummary,
  DashboardStatus,
  DashboardTab,
  DashboardVaultFileDetail,
  DashboardVaultFilesResponse,
  DashboardVaultSummary,
} from "../types/dashboard";
import { formatBytes, formatDateTime, formatDuration, formatNumber, formatRelativeTime } from "../utils/format";

interface BottomDockProps {
  activeTab: DashboardTab;
  expanded: boolean;
  heightPercent: 40 | 55 | 70;
  status: DashboardStatus | null;
  queueSummary: DashboardQueueSummary | null;
  queueItems: DashboardQueueListResponse | null;
  queueDetail: DashboardQueueItemDetail | null;
  queueDetailLoading: boolean;
  queueStatusFilter: string;
  queueSourceTypeFilter: string;
  queueQueryFilter: string;
  vaultSummary: DashboardVaultSummary | null;
  vaultFiles: DashboardVaultFilesResponse | null;
  vaultDetail: DashboardVaultFileDetail | null;
  vaultSourceTypeFilter: string;
  vaultQueueStatusFilter: string;
  vaultQueryFilter: string;
  lintSummary: DashboardLintSummary | null;
  lintIssues: DashboardLintIssuesResponse | null;
  lintLevelFilter: string;
  lintGroupByFilter: "flat" | "page" | "rule";
  lintRuleFilter: string;
  logs: DashboardLogEntry[];
  logStreamStatus: string;
  logLevelFilter: string;
  logFileIdFilter: string;
  logQueryFilter: string;
  onTabChange: (tab: DashboardTab) => void;
  onToggleExpanded: () => void;
  onHeightPercentChange: (value: 40 | 55 | 70) => void;
  onSelectQueueItem: (fileId: string) => void;
  onRetryQueueItem: (fileId: string) => void;
  onQueueStatusFilterChange: (value: string) => void;
  onQueueSourceTypeFilterChange: (value: string) => void;
  onQueueQueryFilterChange: (value: string) => void;
  onInspectQueueLogs: (fileId: string) => void;
  onSelectVaultFile: (fileId: string) => void;
  onOpenVaultFile: (fileId: string) => void;
  onVaultSourceTypeFilterChange: (value: string) => void;
  onVaultQueueStatusFilterChange: (value: string) => void;
  onVaultQueryFilterChange: (value: string) => void;
  onOpenPage: (pageId: string) => void;
  onLintLevelFilterChange: (value: string) => void;
  onLintGroupByFilterChange: (value: "flat" | "page" | "rule") => void;
  onLintRuleFilterChange: (value: string) => void;
  onLogLevelFilterChange: (value: string) => void;
  onLogFileIdFilterChange: (value: string) => void;
  onLogQueryFilterChange: (value: string) => void;
}

const TAB_ORDER: DashboardTab[] = ["system", "queue", "logs", "vault", "lint"];

interface NormalizedDoctorCheck {
  id: string;
  severity: DashboardDoctorSeverity | string;
  summary: string;
  recommendation?: string;
}

function normalizeDoctorChecks(checks: DashboardStatus["doctor"] extends { checks?: infer T } ? T : unknown): NormalizedDoctorCheck[] {
  if (!Array.isArray(checks)) {
    return [];
  }

  const normalized: NormalizedDoctorCheck[] = [];
  for (const [index, check] of (checks as unknown[]).entries()) {
    if (!check || typeof check !== "object") {
      continue;
    }

    const value = check as Record<string, unknown>;
    const id = String(value.id ?? value.name ?? `check-${index}`).trim();
    const severity = String(value.severity ?? value.status ?? "ok").trim().toLowerCase();
    const summary = String(value.summary ?? value.message ?? "").trim();
    const recommendation =
      typeof value.recommendation === "string" && value.recommendation.trim()
        ? value.recommendation.trim()
        : undefined;

    normalized.push({
      id: id || `check-${index}`,
      severity: severity || "ok",
      summary: summary || "No detail provided.",
      recommendation,
    });
  }

  return normalized;
}

function doctorSeverityLabel(severity: string): string {
  if (severity === "warn") {
    return "warn";
  }
  if (severity === "error") {
    return "error";
  }
  return "ok";
}

function canRetryQueueItem(status: string | null | undefined): boolean {
  return status === "error" || status === "pending" || status === "skipped";
}

function queueArtifactPreview(detail: DashboardQueueItemDetail | null): string {
  if (!detail) {
    return "No artifact preview.";
  }
  if (detail.artifacts?.result?.rawText) {
    return detail.artifacts.result.rawText;
  }
  if (detail.artifacts?.prompt?.preview) {
    return detail.artifacts.prompt.preview;
  }
  if (detail.artifacts?.queueItem?.rawText) {
    return detail.artifacts.queueItem.rawText;
  }
  return "No artifact preview.";
}

function isActionablePageId(pageId: string | null | undefined): boolean {
  return Boolean(pageId && pageId !== "*" && pageId.includes("/"));
}

export function BottomDock(props: BottomDockProps) {
  if (!props.expanded) {
    return (
      <section className="bottom-dock bottom-dock--collapsed">
        <div className="bottom-dock__launcher">
          <div className="bottom-dock__collapsed-tabs">
            {TAB_ORDER.map((tab) => (
              <button
                key={tab}
                type="button"
                className={props.activeTab === tab ? "is-active" : ""}
                onClick={() => props.onTabChange(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          <button type="button" className="bottom-dock__collapsed-query" onClick={props.onToggleExpanded}>
            <span>search the live universe…</span>
            <code>
              queue {formatNumber(props.queueSummary?.counts.pending ?? props.status?.queue.pending ?? 0)} · logs {props.logStreamStatus}
            </code>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="bottom-dock" style={{ ["--dock-height" as "--dock-height"]: `${props.heightPercent}%` }}>
      <header className="bottom-dock__header">
        <div className="bottom-dock__header-copy">
          <span className="shell-eyebrow">Operations workbench</span>
          <p>queue flow, runtime logs, vault inspection and lint checks without stealing the graph stage.</p>
        </div>
        <nav className="bottom-dock__tabs">
          {TAB_ORDER.map((tab) => (
            <button
              key={tab}
              type="button"
              className={props.activeTab === tab ? "is-active" : ""}
              onClick={() => props.onTabChange(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>
        <div className="bottom-dock__controls">
          <div className="dock-height">
            {[40, 55, 70].map((value) => (
              <button
                key={value}
                type="button"
                className={props.heightPercent === value ? "is-active" : ""}
                onClick={() => props.onHeightPercentChange(value as 40 | 55 | 70)}
              >
                {value}%
              </button>
            ))}
          </div>
          <button type="button" className="bottom-dock__collapse" onClick={props.onToggleExpanded}>
            collapse
          </button>
        </div>
      </header>

      <div className="bottom-dock__content">
        {props.activeTab === "system" ? <SystemPanel status={props.status} /> : null}
        {props.activeTab === "queue" ? (
          <QueuePanel
            summary={props.queueSummary}
            list={props.queueItems}
            detail={props.queueDetail}
            detailLoading={props.queueDetailLoading}
            statusFilter={props.queueStatusFilter}
            sourceTypeFilter={props.queueSourceTypeFilter}
            queryFilter={props.queueQueryFilter}
            onStatusFilterChange={props.onQueueStatusFilterChange}
            onSourceTypeFilterChange={props.onQueueSourceTypeFilterChange}
            onQueryFilterChange={props.onQueueQueryFilterChange}
            onSelectItem={props.onSelectQueueItem}
            onRetryItem={props.onRetryQueueItem}
            onInspectLogs={props.onInspectQueueLogs}
            onOpenPage={props.onOpenPage}
          />
        ) : null}
        {props.activeTab === "logs" ? (
          <LogsPanel
            entries={props.logs}
            streamStatus={props.logStreamStatus}
            level={props.logLevelFilter}
            fileId={props.logFileIdFilter}
            query={props.logQueryFilter}
            onLevelChange={props.onLogLevelFilterChange}
            onFileIdChange={props.onLogFileIdFilterChange}
            onQueryChange={props.onLogQueryFilterChange}
          />
        ) : null}
        {props.activeTab === "vault" ? (
          <VaultPanel
            summary={props.vaultSummary}
            files={props.vaultFiles}
            detail={props.vaultDetail}
            sourceTypeFilter={props.vaultSourceTypeFilter}
            queueStatusFilter={props.vaultQueueStatusFilter}
            queryFilter={props.vaultQueryFilter}
            onSourceTypeFilterChange={props.onVaultSourceTypeFilterChange}
            onQueueStatusFilterChange={props.onVaultQueueStatusFilterChange}
            onQueryFilterChange={props.onVaultQueryFilterChange}
            onSelectFile={props.onSelectVaultFile}
            onOpenFile={props.onOpenVaultFile}
            onOpenPage={props.onOpenPage}
          />
        ) : null}
        {props.activeTab === "lint" ? (
          <LintPanel
            summary={props.lintSummary}
            issues={props.lintIssues}
            levelFilter={props.lintLevelFilter}
            groupByFilter={props.lintGroupByFilter}
            ruleFilter={props.lintRuleFilter}
            onLevelFilterChange={props.onLintLevelFilterChange}
            onGroupByFilterChange={props.onLintGroupByFilterChange}
            onRuleFilterChange={props.onLintRuleFilterChange}
            onOpenPage={props.onOpenPage}
          />
        ) : null}
      </div>
    </section>
  );
}

function SystemPanel({ status }: { status: DashboardStatus | null }) {
  if (!status) {
    return <p className="dock-empty">No system payload yet.</p>;
  }

  const doctorChecks = normalizeDoctorChecks(status.doctor?.checks);

  return (
    <div className="dock-grid dock-grid--system">
      <section className="dock-card">
        <h3>Daemon</h3>
        <dl>
          <div>
            <dt>Host</dt>
            <dd>{status.daemon.host ?? "n/a"}</dd>
          </div>
          <div>
            <dt>Port</dt>
            <dd>{status.daemon.port ?? "n/a"}</dd>
          </div>
          <div>
            <dt>Task</dt>
            <dd>{status.daemon.currentTask ?? "idle"}</dd>
          </div>
          <div>
            <dt>Last Result</dt>
            <dd>{status.daemon.lastResult ?? "n/a"}</dd>
          </div>
          <div>
            <dt>Last Sync</dt>
            <dd>{formatDateTime(status.lastSyncAt)}</dd>
          </div>
        </dl>
      </section>
      <section className="dock-card">
        <h3>Runtime</h3>
        <dl>
          <div>
            <dt>Vault Source</dt>
            <dd>{status.runtime?.vaultSource ?? "n/a"}</dd>
          </div>
          <div>
            <dt>Wiki Path</dt>
            <dd>
              <code>{status.runtime?.wikiPath ?? "n/a"}</code>
            </dd>
          </div>
          <div>
            <dt>Vault Path</dt>
            <dd>
              <code>{status.runtime?.vaultPath ?? "n/a"}</code>
            </dd>
          </div>
          <div>
            <dt>DB Path</dt>
            <dd>
              <code>{status.runtime?.dbPath ?? "n/a"}</code>
            </dd>
          </div>
        </dl>
      </section>
      <section className="dock-card">
        <h3>Doctor</h3>
        {status.doctor?.summary ? (
          <div className="queue-counts doctor-summary">
            <div>
              <small>ok</small>
              <strong>{formatNumber(status.doctor.summary.ok)}</strong>
            </div>
            <div>
              <small>warn</small>
              <strong>{formatNumber(status.doctor.summary.warn)}</strong>
            </div>
            <div>
              <small>error</small>
              <strong>{formatNumber(status.doctor.summary.error)}</strong>
            </div>
          </div>
        ) : null}
        {doctorChecks.length ? (
          <ul className="doctor-list">
            {doctorChecks.map((check, index) => (
              <li key={`${check.id}-${index}`}>
                <strong>{check.id}</strong>
                <span className={`doctor-severity doctor-severity--${doctorSeverityLabel(check.severity)}`}>
                  {doctorSeverityLabel(check.severity)}
                </span>
                <p>{check.summary}</p>
                {check.recommendation ? <small>{check.recommendation}</small> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="dock-empty">No doctor checks reported.</p>
        )}
        {status.doctor?.recommendations?.length ? (
          <div className="dock-subsection">
            <h4>Recommended Actions</h4>
            <ul className="compact-list">
              {status.doctor.recommendations.slice(0, 4).map((recommendation) => (
                <li key={recommendation}>{recommendation}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function QueuePanel(props: {
  summary: DashboardQueueSummary | null;
  list: DashboardQueueListResponse | null;
  detail: DashboardQueueItemDetail | null;
  detailLoading: boolean;
  statusFilter: string;
  sourceTypeFilter: string;
  queryFilter: string;
  onStatusFilterChange: (value: string) => void;
  onSourceTypeFilterChange: (value: string) => void;
  onQueryFilterChange: (value: string) => void;
  onSelectItem: (fileId: string) => void;
  onRetryItem: (fileId: string) => void;
  onInspectLogs: (fileId: string) => void;
  onOpenPage: (pageId: string) => void;
}) {
  return (
    <div className="dock-grid dock-grid--queue">
      <section className="dock-card">
        <h3>Queue Summary</h3>
        {!props.summary ? <p className="dock-empty">Queue summary unavailable.</p> : null}
        {props.summary ? (
          <div className="dock-detail-stack">
            <div className="queue-counts">
              {Object.entries(props.summary.counts).map(([key, value]) => (
                <div key={key}>
                  <small>{key}</small>
                  <strong>{formatNumber(value)}</strong>
                </div>
              ))}
            </div>
            <div className="dock-subsection">
              <h4>Filters</h4>
              <div className="filters">
                <select
                  value={props.statusFilter}
                  onInput={(event) => props.onStatusFilterChange((event.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="">all status</option>
                  <option value="pending">pending</option>
                  <option value="processing">processing</option>
                  <option value="done">done</option>
                  <option value="skipped">skipped</option>
                  <option value="error">error</option>
                </select>
                <input
                  value={props.sourceTypeFilter}
                  placeholder="source type"
                  onInput={(event) => props.onSourceTypeFilterChange((event.currentTarget as HTMLInputElement).value)}
                />
                <input
                  value={props.queryFilter}
                  placeholder="file id / decision / result"
                  onInput={(event) => props.onQueryFilterChange((event.currentTarget as HTMLInputElement).value)}
                />
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="dock-card dock-card--grow">
        <h3>Queue Items</h3>
        {!props.list ? <p className="dock-empty">Queue list unavailable.</p> : null}
        {props.list ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>file</th>
                  <th>status</th>
                  <th>decision</th>
                  <th>age</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {props.list.items.map((item) => (
                  <tr key={item.fileId}>
                    <td>{item.fileName ?? item.fileId}</td>
                    <td>{item.status}</td>
                    <td>{item.decision ?? "n/a"}</td>
                    <td>{formatRelativeTime(item.timing?.queuedAt ?? null)}</td>
                    <td className="row-actions">
                      <button type="button" onClick={() => props.onSelectItem(item.fileId)}>
                        detail
                      </button>
                      <button
                        type="button"
                        onClick={() => props.onRetryItem(item.fileId)}
                        disabled={!canRetryQueueItem(item.status)}
                      >
                        retry
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="dock-card">
        <h3>Queue Item Detail</h3>
        {props.detailLoading ? <p className="dock-empty">Loading detail…</p> : null}
        {!props.detailLoading && !props.detail ? <p className="dock-empty">Select an item to inspect artifacts.</p> : null}
        {!props.detailLoading && props.detail ? (
          <div className="dock-detail-stack">
            <p>
              <strong>{props.detail.item.fileName ?? props.detail.item.fileId}</strong>
            </p>
            <p className="muted">{props.detail.item.errorMessage ?? "No error message."}</p>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{props.detail.item.status}</dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>{formatNumber(props.detail.item.attempts ?? 0)}</dd>
              </div>
              <div>
                <dt>Wait</dt>
                <dd>{formatDuration(props.detail.item.timing?.waitDurationMs ?? null)}</dd>
              </div>
              <div>
                <dt>Process</dt>
                <dd>{formatDuration(props.detail.item.timing?.processingDurationMs ?? null)}</dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd>{props.detail.item.resultPageId ?? "n/a"}</dd>
              </div>
            </dl>
            <div className="detail-card__actions">
              <button
                type="button"
                onClick={() => props.onRetryItem(props.detail!.item.fileId)}
                disabled={!canRetryQueueItem(props.detail.item.status)}
              >
                retry item
              </button>
              <button type="button" onClick={() => props.onInspectLogs(props.detail!.item.fileId)}>
                trace logs
              </button>
            </div>
            {props.detail.linkedPages?.length ? (
              <div className="dock-subsection">
                <h4>Linked Pages</h4>
                <div className="inline-actions">
                  {props.detail.linkedPages.map((page) => (
                    <button key={page.id} type="button" className="row-link" onClick={() => props.onOpenPage(page.id)}>
                      {page.title}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="dock-subsection">
              <h4>Artifact Preview</h4>
              <pre>{queueArtifactPreview(props.detail)}</pre>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function LogsPanel(props: {
  entries: DashboardLogEntry[];
  streamStatus: string;
  level: string;
  fileId: string;
  query: string;
  onLevelChange: (value: string) => void;
  onFileIdChange: (value: string) => void;
  onQueryChange: (value: string) => void;
}) {
  return (
    <div className="dock-grid dock-grid--logs">
      <section className="dock-card">
        <h3>Live Stream</h3>
        <p className="muted">
          status: <strong>{props.streamStatus}</strong>
        </p>
        <div className="filters">
          <select value={props.level} onInput={(event) => props.onLevelChange((event.currentTarget as HTMLSelectElement).value)}>
            <option value="">all levels</option>
            <option value="info">info</option>
            <option value="error">error</option>
          </select>
          <input
            value={props.fileId}
            placeholder="file id"
            onInput={(event) => props.onFileIdChange((event.currentTarget as HTMLInputElement).value)}
          />
          <input
            value={props.query}
            placeholder="keyword"
            onInput={(event) => props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
          />
        </div>
      </section>
      <section className="dock-card dock-card--grow">
        <div className="log-lines">
          {props.entries.length === 0 ? <p className="dock-empty">No logs yet.</p> : null}
          {props.entries.map((entry) => (
            <div key={`${entry.id}-${entry.timestamp}`} className="log-line">
              <time>{formatDateTime(entry.timestamp)}</time>
              <strong>{entry.level}</strong>
              <span>{entry.fileId ?? "-"}</span>
              <p>{entry.message}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function VaultPanel(props: {
  summary: DashboardVaultSummary | null;
  files: DashboardVaultFilesResponse | null;
  detail: DashboardVaultFileDetail | null;
  sourceTypeFilter: string;
  queueStatusFilter: string;
  queryFilter: string;
  onSourceTypeFilterChange: (value: string) => void;
  onQueueStatusFilterChange: (value: string) => void;
  onQueryFilterChange: (value: string) => void;
  onSelectFile: (fileId: string) => void;
  onOpenFile: (fileId: string) => void;
  onOpenPage: (pageId: string) => void;
}) {
  return (
    <div className="dock-grid dock-grid--vault">
      <section className="dock-card">
        <h3>Vault Coverage</h3>
        {!props.summary ? <p className="dock-empty">Vault summary unavailable.</p> : null}
        {props.summary ? (
          <div className="dock-detail-stack">
            <dl>
              <div>
                <dt>Files</dt>
                <dd>{formatNumber(props.summary.totalFiles)}</dd>
              </div>
              <div>
                <dt>Total Bytes</dt>
                <dd>{formatBytes(props.summary.totalBytes)}</dd>
              </div>
              <div>
                <dt>Mapped Pages</dt>
                <dd>{formatNumber(props.summary.mappedPages)}</dd>
              </div>
              <div>
                <dt>Not Queued</dt>
                <dd>{formatNumber(props.summary.coverage.notQueued)}</dd>
              </div>
            </dl>
            <div className="dock-subsection">
              <h4>Filters</h4>
              <div className="filters">
                <input
                  value={props.sourceTypeFilter}
                  placeholder="source type"
                  onInput={(event) => props.onSourceTypeFilterChange((event.currentTarget as HTMLInputElement).value)}
                />
                <select
                  value={props.queueStatusFilter}
                  onInput={(event) => props.onQueueStatusFilterChange((event.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="">all queue states</option>
                  <option value="not-queued">not-queued</option>
                  <option value="pending">pending</option>
                  <option value="processing">processing</option>
                  <option value="done">done</option>
                  <option value="skipped">skipped</option>
                  <option value="error">error</option>
                </select>
                <input
                  value={props.queryFilter}
                  placeholder="file id / name / cache"
                  onInput={(event) => props.onQueryFilterChange((event.currentTarget as HTMLInputElement).value)}
                />
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="dock-card dock-card--grow">
        <h3>Files</h3>
        {!props.files ? <p className="dock-empty">No vault files loaded.</p> : null}
        {props.files ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>source</th>
                  <th>size</th>
                  <th>queue</th>
                  <th>pages</th>
                  <th>cache</th>
                </tr>
              </thead>
              <tbody>
                {props.files.items.map((item) => (
                  <tr key={item.fileId}>
                    <td>
                      <button type="button" className="row-link" onClick={() => props.onSelectFile(item.fileId)}>
                        {item.fileName}
                      </button>
                    </td>
                    <td>{item.sourceType ?? item.fileExt ?? "n/a"}</td>
                    <td>{formatBytes(item.fileSize)}</td>
                    <td>{item.queueStatus}</td>
                    <td>{item.generatedPageCount}</td>
                    <td>{item.cacheStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="dock-card">
        <h3>Selected File</h3>
        {!props.detail ? <p className="dock-empty">Select a file to inspect preview and local cache paths.</p> : null}
        {props.detail ? (
          <div className="dock-detail-stack">
            <p>
              <strong>{props.detail.file.fileName}</strong>
            </p>
            <p className="muted">{props.detail.file.localPath ?? props.detail.file.filePath}</p>
            <dl>
              <div>
                <dt>Cache</dt>
                <dd>{props.detail.file.cacheStatus}</dd>
              </div>
              <div>
                <dt>Queue</dt>
                <dd>{props.detail.queueItem?.status ?? "not-queued"}</dd>
              </div>
              <div>
                <dt>Pages</dt>
                <dd>{formatNumber(props.detail.relatedPages.length)}</dd>
              </div>
              <div>
                <dt>Indexed</dt>
                <dd>{formatDateTime(props.detail.file.indexedAt)}</dd>
              </div>
            </dl>
            {props.detail.relatedPages.length ? (
              <div className="dock-subsection">
                <h4>Generated Pages</h4>
                <div className="inline-actions">
                  {props.detail.relatedPages.map((page) => (
                    <button key={page.id} type="button" className="row-link" onClick={() => props.onOpenPage(page.id)}>
                      {page.title}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <pre>{props.detail.file.preview ?? "No preview available."}</pre>
            <div className="detail-card__actions">
              <button type="button" onClick={() => props.onOpenFile(props.detail!.file.fileId)}>
                open local file
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function LintPanel(props: {
  summary: DashboardLintSummary | null;
  issues: DashboardLintIssuesResponse | null;
  levelFilter: string;
  groupByFilter: "flat" | "page" | "rule";
  ruleFilter: string;
  onLevelFilterChange: (value: string) => void;
  onGroupByFilterChange: (value: "flat" | "page" | "rule") => void;
  onRuleFilterChange: (value: string) => void;
  onOpenPage: (pageId: string) => void;
}) {
  return (
    <div className="dock-grid dock-grid--lint">
      <section className="dock-card">
        <h3>Lint Summary</h3>
        {!props.summary ? <p className="dock-empty">Lint summary unavailable.</p> : null}
        {props.summary ? (
          <div className="dock-detail-stack">
            <div className="queue-counts">
              <div>
                <small>errors</small>
                <strong>{props.summary.counts.error}</strong>
              </div>
              <div>
                <small>warnings</small>
                <strong>{props.summary.counts.warning}</strong>
              </div>
              <div>
                <small>info</small>
                <strong>{props.summary.counts.info}</strong>
              </div>
              <div>
                <small>total</small>
                <strong>{props.summary.counts.total}</strong>
              </div>
            </div>
            <div className="dock-subsection">
              <h4>Filters</h4>
              <div className="filters">
                <select
                  value={props.levelFilter}
                  onInput={(event) => props.onLevelFilterChange((event.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="">all levels</option>
                  <option value="error">error</option>
                  <option value="warning">warning</option>
                  <option value="info">info</option>
                </select>
                <select
                  value={props.groupByFilter}
                  onInput={(event) =>
                    props.onGroupByFilterChange((event.currentTarget as HTMLSelectElement).value as "flat" | "page" | "rule")
                  }
                >
                  <option value="flat">flat</option>
                  <option value="page">group by page</option>
                  <option value="rule">group by rule</option>
                </select>
                <input
                  value={props.ruleFilter}
                  placeholder="rule contains"
                  onInput={(event) => props.onRuleFilterChange((event.currentTarget as HTMLInputElement).value)}
                />
              </div>
            </div>
            {props.summary.topRules.length ? (
              <div className="dock-subsection">
                <h4>Top Rules</h4>
                <ul className="compact-list">
                  {props.summary.topRules.slice(0, 5).map((rule) => (
                    <li key={rule.rule}>
                      <code>{rule.rule}</code>
                      <span>{formatNumber(rule.count)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {props.summary.topPages.length ? (
              <div className="dock-subsection">
                <h4>Top Pages</h4>
                <ul className="compact-list">
                  {props.summary.topPages.slice(0, 5).map((page) => (
                    <li key={page.pageId}>
                      {isActionablePageId(page.pageId) ? (
                        <button type="button" className="row-link" onClick={() => props.onOpenPage(page.pageId)}>
                          {page.pageId}
                        </button>
                      ) : (
                        <span>{page.pageId}</span>
                      )}
                      <span>{formatNumber(page.count)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="dock-card dock-card--grow">
        <h3>Issues</h3>
        {props.issues?.items?.length ? (
          <ul className="lint-list">
            {props.issues.items.map((issue, index) => (
              <li key={`${issue.pageId}-${issue.check}-${index}`}>
                <div>
                  <strong>{issue.level.toUpperCase()}</strong>
                  <code>{issue.check}</code>
                </div>
                <p>{issue.message}</p>
                <small>{issue.pageTitle ?? issue.pageId}</small>
                {isActionablePageId(issue.pageId) ? (
                  <div className="row-actions">
                    <button type="button" onClick={() => props.onOpenPage(issue.pageId)}>
                      open page
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : props.issues?.groups?.length ? (
          <ul className="lint-list">
            {props.issues.groups.map((group) => (
              <li key={group.key}>
                <div>
                  <strong>{group.key}</strong>
                  <code>{group.count} findings</code>
                </div>
                <p>{group.items[0]?.message ?? "Grouped lint findings."}</p>
                <small>{group.pageTitle ?? group.pageType ?? "grouped"}</small>
                {isActionablePageId(group.items[0]?.pageId) ? (
                  <div className="row-actions">
                    <button type="button" onClick={() => props.onOpenPage(group.items[0]!.pageId)}>
                      open page
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="dock-empty">No lint issues returned.</p>
        )}
      </section>
    </div>
  );
}

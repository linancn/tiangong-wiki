import type { RefObject } from "preact";

import type { DashboardGraphOverview, DashboardQueueSummary, DashboardSearchResult, DashboardStatus, DashboardTab } from "../types/dashboard";
import { formatNumber, formatRelativeTime } from "../utils/format";

interface TopBarProps {
  status: DashboardStatus | null;
  graph: DashboardGraphOverview | null;
  queue: DashboardQueueSummary | null;
  activeTab: DashboardTab;
  searchQuery: string;
  searchResults: DashboardSearchResult[];
  searchLoading: boolean;
  refreshing: boolean;
  usingFallback: boolean;
  searchInputRef: RefObject<HTMLInputElement>;
  onTabChange: (tab: DashboardTab) => void;
  onSearchQueryChange: (value: string) => void;
  onSelectSearchResult: (result: DashboardSearchResult) => void;
  onRefresh: () => void;
  onReplayIntro: () => void;
}

const NAV_TABS: Array<{ id: DashboardTab; label: string }> = [
  { id: "observatory", label: "Observatory" },
  { id: "system", label: "System" },
  { id: "queue", label: "Queue" },
  { id: "logs", label: "Logs" },
  { id: "vault", label: "Vault" },
  { id: "lint", label: "Lint" },
];

function daemonClass(status: DashboardStatus | null): string {
  if (!status) {
    return "is-unknown";
  }
  if (!status.daemon.running) {
    return "is-error";
  }
  if (status.daemon.lastResult === "error") {
    return "is-warning";
  }
  return "is-live";
}

export function TopBar({
  status,
  graph,
  queue,
  activeTab,
  searchQuery,
  searchResults,
  searchLoading,
  refreshing,
  usingFallback,
  searchInputRef,
  onTabChange,
  onSearchQueryChange,
  onSelectSearchResult,
  onRefresh,
  onReplayIntro,
}: TopBarProps) {
  const hasSearchQuery = searchQuery.trim().length > 0;

  return (
    <header className="topbar">
      <div className="topbar__brand shell-brand">
        <button
          type="button"
          className="topbar__brand-link"
          onClick={() => onTabChange("observatory")}
        >
          <span className="shell-eyebrow">Wiki</span>
          <h1>Intelligence</h1>
        </button>
      </div>

      <nav className="topbar__nav">
        {NAV_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`topbar__nav-tab ${activeTab === tab.id ? "is-active" : ""}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="topbar__actions">
        <div className="topbar__status-row">
          <div className={`shell-status-chip daemon-chip ${daemonClass(status)}`}>
            <span className="shell-status-dot daemon-chip__dot" />
            <span>{status?.daemon.running ? "online" : "offline"}</span>
            <code>{status?.daemon.currentTask ?? "idle"}</code>
          </div>
          <span className="topbar__counts-inline">
            <span title="total nodes">
              graph <strong>{formatNumber(graph?.totalNodes ?? 0)}</strong>
            </span>
            <span title="queue pending">
              queue <strong>{formatNumber(queue?.counts.pending ?? 0)}</strong>
            </span>
          </span>
          <span className="topbar__freshness-inline shell-meta">
            {formatRelativeTime(status?.generatedAt ?? null)}
            {usingFallback && <em>fallback</em>}
          </span>
        </div>

        <div className="global-search">
          {hasSearchQuery && (
            <span className="global-search__meta">
              {searchLoading ? "scanning…" : `${searchResults.length} hits`}
            </span>
          )}
          <input
            aria-label="Search across all pages"
            autoComplete="off"
            placeholder="Search whole library…"
            ref={searchInputRef}
            value={searchQuery}
            onInput={(event) =>
              onSearchQueryChange((event.currentTarget as HTMLInputElement).value)
            }
          />
          {hasSearchQuery && searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.slice(0, 12).map((result) => (
                <button
                  key={`${result.id}-${result.searchKind ?? "x"}`}
                  className="search-results__item"
                  onClick={() => onSelectSearchResult(result)}
                  type="button"
                >
                  <strong>{result.title}</strong>
                  <small>
                    <code>{result.pageType}</code>
                    <code>{result.status}</code>
                    {result.nodeId ? <code>{result.nodeId}</code> : null}
                    {result.updatedAt ? <span>{formatRelativeTime(result.updatedAt)}</span> : null}
                  </small>
                  <p>{result.summaryText || result.filePath}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="btn btn-ghost" onClick={onReplayIntro} type="button">
          replay
        </button>
        <button className="btn btn-primary" onClick={onRefresh} type="button" disabled={refreshing}>
          {refreshing ? "refreshing…" : "refresh"}
        </button>
      </div>
    </header>
  );
}

import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { DashboardApiClient, DashboardApiError } from "./api/client";
import { ConstellationIgnition, type IgnitionMode } from "./components/ConstellationIgnition";
import { EnvironmentGate } from "./components/EnvironmentGate";
import { TopBar } from "./components/TopBar";
import {
  mockGraphOverview,
  mockQueueSummary,
  mockSearch,
  mockStatus,
} from "./constants/mockData";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { useReducedMotion } from "./hooks/useReducedMotion";
import { LintPage } from "./pages/LintPage";
import { LogsPage } from "./pages/LogsPage";
import { ObservatoryPage } from "./pages/ObservatoryPage";
import { QueuePage } from "./pages/QueuePage";
import { SystemPage } from "./pages/SystemPage";
import { VaultPage } from "./pages/VaultPage";
import type {
  DashboardGraphOverview,
  DashboardGraphSearchResponse,
  DashboardQueueSummary,
  DashboardStatus,
  DashboardTab,
  DashboardUrlState,
} from "./types/dashboard";
import { readUrlState, writeUrlState } from "./utils/urlState";

const INTRO_STORAGE_KEY = "wiki-dashboard-intro-complete";

function toErrorMessage(error: unknown): string {
  if (error instanceof DashboardApiError && error.bodyText) {
    try {
      const payload = JSON.parse(error.bodyText) as { error?: string };
      if (payload.error) {
        return payload.error;
      }
    } catch {
      return error.bodyText;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function pickPrimaryNode(graph: DashboardGraphOverview | null): string | null {
  if (!graph?.nodes.length) {
    return null;
  }

  const pageTypePriority = (pageType: string): number => {
    if (pageType === "source-summary") {
      return 3;
    }
    if (pageType === "resume") {
      return 2;
    }
    if (pageType === "faq") {
      return 1;
    }
    return 0;
  };

  const [primaryNode] = [...graph.nodes].sort((left, right) => {
    const priorityDelta = pageTypePriority(left.pageType) - pageTypePriority(right.pageType);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    if (right.degree !== left.degree) {
      return right.degree - left.degree;
    }
    if (left.orphan !== right.orphan) {
      return left.orphan ? 1 : -1;
    }
    return left.title.localeCompare(right.title);
  });

  return primaryNode?.id ?? null;
}

export function App() {
  const apiRef = useRef<DashboardApiClient | null>(null);
  const introReplayTimerRef = useRef<number | null>(null);
  const autoSelectionDoneRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  if (!apiRef.current) {
    apiRef.current = new DashboardApiClient();
  }
  const api = apiRef.current;
  const reducedMotion = useReducedMotion();

  const [urlState, setUrlState] = useState<DashboardUrlState>(() => readUrlState());
  const [usingFallback, setUsingFallback] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [introReplayCount, setIntroReplayCount] = useState(0);
  const [bootLoading, setBootLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [graph, setGraph] = useState<DashboardGraphOverview | null>(null);
  const [queueSummary, setQueueSummary] = useState<DashboardQueueSummary | null>(null);
  const [searchPayload, setSearchPayload] = useState<DashboardGraphSearchResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const debouncedSearchQuery = useDebouncedValue(urlState.query, 220);
  const searchResults = searchPayload?.results ?? [];
  const activeTab = urlState.tab;
  const detailVisible = activeTab === "observatory" && Boolean(urlState.selectedPageId);

  useEffect(() => {
    const onPopState = () => {
      setUrlState(readUrlState());
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (introReplayTimerRef.current !== null) {
        window.clearTimeout(introReplayTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    writeUrlState(urlState);
  }, [urlState]);

  const introMode = useMemo<IgnitionMode>(() => {
    if (reducedMotion) {
      return "reduced";
    }
    const visited = window.sessionStorage.getItem(INTRO_STORAGE_KEY) === "true";
    return visited && introReplayCount === 0 ? "short" : "full";
  }, [introReplayCount, reducedMotion]);

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      setBootLoading(true);
      setActionError(null);

      const [statusResult, graphResult, queueSummaryResult] = await Promise.allSettled([
        api.getStatus(),
        api.getGraphOverview(),
        api.getQueueSummary(),
      ]);

      if (cancelled) {
        return;
      }

      const hasFallback =
        statusResult.status === "rejected" ||
        graphResult.status === "rejected" ||
        queueSummaryResult.status === "rejected";
      setUsingFallback(hasFallback);

      setStatus(statusResult.status === "fulfilled" ? statusResult.value : mockStatus());
      setGraph(graphResult.status === "fulfilled" ? graphResult.value : mockGraphOverview());
      setQueueSummary(queueSummaryResult.status === "fulfilled" ? queueSummaryResult.value : mockQueueSummary());

      if (hasFallback) {
        const errorResult = [statusResult, graphResult, queueSummaryResult].find(
          (result) => result.status === "rejected",
        );
        if (errorResult?.status === "rejected") {
          setActionError(`Dashboard API unavailable, showing mock fallback. ${toErrorMessage(errorResult.reason)}`);
        }
      }

      setBootLoading(false);
    }

    void loadDashboard();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (autoSelectionDoneRef.current || activeTab !== "observatory") {
      return;
    }

    if (urlState.selectedPageId) {
      autoSelectionDoneRef.current = true;
      return;
    }

    const pageId = pickPrimaryNode(graph);
    if (!pageId) {
      return;
    }

    autoSelectionDoneRef.current = true;
    setUrlState((current) => ({
      ...current,
      selectedPageId: pageId,
    }));
  }, [activeTab, graph, urlState.selectedPageId]);

  useEffect(() => {
    let cancelled = false;
    if (!debouncedSearchQuery.trim()) {
      setSearchPayload(null);
      return;
    }

    setSearchLoading(true);
    void api.searchGraph(debouncedSearchQuery, 18).then((payload) => {
      if (!cancelled) {
        setSearchPayload(payload);
        setSearchLoading(false);
      }
    }).catch(() => {
      if (cancelled) {
        return;
      }
      setUsingFallback(true);
      setSearchPayload(mockSearch(debouncedSearchQuery));
      setSearchLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [api, debouncedSearchQuery]);

  function updateUrlState(patch: Partial<DashboardUrlState>) {
    setUrlState((current) => ({ ...current, ...patch }));
  }

  function navigateToPage(pageId: string) {
    updateUrlState({ tab: "observatory", selectedPageId: pageId });
  }

  function handleTabChange(tab: DashboardTab) {
    if (tab !== "observatory") {
      updateUrlState({ tab, selectedPageId: null });
    } else {
      updateUrlState({ tab });
    }
  }

  async function refreshDashboard() {
    setRefreshing(true);
    try {
      const [nextStatus, nextGraph, nextQueueSummary] = await Promise.all([
        api.refreshStatus(),
        api.getGraphOverview(),
        api.getQueueSummary(),
      ]);

      setStatus(nextStatus);
      setGraph(nextGraph);
      setQueueSummary(nextQueueSummary);
      setUsingFallback(false);
      setActionError(null);
    } catch (error) {
      setUsingFallback(true);
      setActionError(`Refresh failed, retaining current snapshot. ${toErrorMessage(error)}`);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <EnvironmentGate>
      <div className={`dashboard-root ${detailVisible ? "has-detail" : ""} ${showIntro ? "is-intro-active" : ""}`}>
        {showIntro ? (
          <ConstellationIgnition
            key={`${introMode}-${introReplayCount}`}
            graph={graph}
            status={status}
            mode={introMode}
            onComplete={() => {
              window.sessionStorage.setItem(INTRO_STORAGE_KEY, "true");
              setShowIntro(false);
            }}
          />
        ) : null}

        <TopBar
          status={status}
          graph={graph}
          queue={queueSummary}
          activeTab={activeTab}
          searchQuery={urlState.query}
          searchResults={searchResults}
          searchLoading={searchLoading}
          refreshing={refreshing}
          usingFallback={usingFallback}
          searchInputRef={searchInputRef}
          onTabChange={handleTabChange}
          onSearchQueryChange={(value) => updateUrlState({ query: value })}
          onSelectSearchResult={(result) => navigateToPage(result.id)}
          onRefresh={() => void refreshDashboard()}
          onReplayIntro={() => {
            if (introReplayTimerRef.current !== null) {
              window.clearTimeout(introReplayTimerRef.current);
            }
            setShowIntro(false);
            introReplayTimerRef.current = window.setTimeout(() => {
              setIntroReplayCount((count) => count + 1);
              setShowIntro(true);
              introReplayTimerRef.current = null;
            }, 0);
          }}
        />

        {actionError ? <div className="api-warning">{actionError}</div> : null}

        {activeTab === "observatory" ? (
          <ObservatoryPage
            api={api}
            graph={graph}
            status={status}
            selectedPageId={urlState.selectedPageId}
            searchQuery={urlState.query}
            searchResults={searchResults}
            searchLoading={searchLoading}
            refreshing={refreshing}
            bootLoading={bootLoading}
            onSelectPage={(pageId) => updateUrlState({ selectedPageId: pageId })}
            onDeselectPage={() => updateUrlState({ selectedPageId: null })}
            onRefresh={() => void refreshDashboard()}
          />
        ) : null}
        {activeTab === "system" ? <SystemPage api={api} status={status} /> : null}
        {activeTab === "queue" ? <QueuePage api={api} onOpenPage={navigateToPage} /> : null}
        {activeTab === "logs" ? <LogsPage api={api} usingFallback={usingFallback} /> : null}
        {activeTab === "vault" ? <VaultPage api={api} onOpenPage={navigateToPage} /> : null}
        {activeTab === "lint" ? <LintPage api={api} onOpenPage={navigateToPage} /> : null}
      </div>
    </EnvironmentGate>
  );
}

import { useEffect, useState } from "preact/hooks";

import { DashboardApiError, type DashboardApiClient } from "../api/client";
import { DetailPanel } from "../components/DetailPanel";
import { GraphCanvas } from "../components/GraphCanvas";
import { mockPageDetail, mockPageSource } from "../constants/mockData";
import type {
  DashboardGraphOverview,
  DashboardPageDetailResponse,
  DashboardPageSourceResponse,
  DashboardSearchResult,
  DashboardStatus,
} from "../types/dashboard";

export interface ObservatoryPageProps {
  api: DashboardApiClient;
  graph: DashboardGraphOverview | null;
  status: DashboardStatus | null;
  selectedPageId: string | null;
  searchQuery: string;
  searchResults: DashboardSearchResult[];
  searchLoading: boolean;
  refreshing: boolean;
  bootLoading: boolean;
  onSelectPage: (pageId: string) => void;
  onDeselectPage: () => void;
  onRefresh: () => void;
}

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

export function ObservatoryPage({
  api,
  graph,
  selectedPageId,
  searchQuery,
  searchResults,
  refreshing,
  bootLoading,
  onSelectPage,
  onDeselectPage,
  onRefresh,
}: ObservatoryPageProps) {

  const [pageDetail, setPageDetail] = useState<DashboardPageDetailResponse | null>(null);
  const [pageSource, setPageSource] = useState<DashboardPageSourceResponse | null>(null);
  const [pageDetailLoading, setPageDetailLoading] = useState(false);
  const [selectionFocusKey, setSelectionFocusKey] = useState(0);
  const [graphResetToken, setGraphResetToken] = useState(0);
  const [sourceActionPending, setSourceActionPending] = useState(false);
  const [sourceActionMessage, setSourceActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!selectedPageId) {
      setPageDetail(null);
      setPageSource(null);
      return;
    }

    setPageDetailLoading(true);
    void Promise.allSettled([api.getPageDetail(selectedPageId), api.getPageSource(selectedPageId)]).then((results) => {
      if (cancelled) {
        return;
      }

      const [detailResult, sourceResult] = results;
      setPageDetail(detailResult.status === "fulfilled" ? detailResult.value : mockPageDetail(selectedPageId));
      setPageSource(sourceResult.status === "fulfilled" ? sourceResult.value : mockPageSource(selectedPageId));
      setPageDetailLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [api, selectedPageId]);

  const detailVisible = Boolean(selectedPageId);
  const focusedPage =
    pageDetail?.page ??
    graph?.nodes.find((node) => node.id === selectedPageId) ??
    searchResults.find((result) => result.id === selectedPageId) ??
    null;

  async function openSource(target: "vault" | "page") {
    if (!selectedPageId) {
      return;
    }

    setSourceActionPending(true);
    try {
      const result = await api.openPageSource(selectedPageId, target);
      setSourceActionMessage(`${result.target === "vault" ? "Vault source" : "Page source"} opened: ${result.path}`);
    } catch (error) {
      setSourceActionMessage(`Open source failed. ${toErrorMessage(error)}`);
    } finally {
      setSourceActionPending(false);
    }
  }

  return (
    <>
      <main className="workspace" data-has-detail={detailVisible ? "" : undefined}>
        <GraphCanvas
          graph={graph}
          selectedPageId={selectedPageId}
          selectionFocusKey={selectionFocusKey}
          focusedPage={focusedPage}
          loading={refreshing || bootLoading}
          searchQuery={searchQuery}
          searchResultCount={searchResults.length}
          resetViewToken={graphResetToken}
          onSelectPage={(pageId) => {
            setSelectionFocusKey((v) => v + 1);
            onSelectPage(pageId);
          }}
          onDeselectPage={onDeselectPage}
        />
      </main>

      <DetailPanel
        pageDetail={pageDetail}
        pageSource={pageSource}
        loading={pageDetailLoading}
        onClose={onDeselectPage}
        onNavigateToPage={(pageId) => {
          setSelectionFocusKey((v) => v + 1);
          onSelectPage(pageId);
        }}
        onOpenSource={(target) => void openSource(target)}
        sourceActionPending={sourceActionPending}
        sourceActionMessage={sourceActionMessage}
      />
    </>
  );
}

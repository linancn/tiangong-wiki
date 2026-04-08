import { useCallback, useEffect, useState } from "preact/hooks";

import type { DashboardApiClient } from "../api/client";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import type { DashboardQueueItemDetail, DashboardQueueListResponse, DashboardQueueSummary } from "../types/dashboard";
import { formatDuration, formatNumber, formatRelativeTime } from "../utils/format";

export interface QueuePageProps {
  api: DashboardApiClient;
  onOpenPage: (pageId: string) => void;
}

const INSPECT_QUEUE_LOGS_EVENT = "wiki-dashboard:inspect-queue-logs";

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

export function QueuePage({ api, onOpenPage }: QueuePageProps) {
  const [queueSummary, setQueueSummary] = useState<DashboardQueueSummary | null>(null);
  const [queueItems, setQueueItems] = useState<DashboardQueueListResponse | null>(null);
  const [queueDetail, setQueueDetail] = useState<DashboardQueueItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceTypeFilter, setSourceTypeFilter] = useState("");
  const [queryFilter, setQueryFilter] = useState("");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  const debouncedQuery = useDebouncedValue(queryFilter, 220);

  useEffect(() => {
    let cancelled = false;
    void api
      .getQueueSummary()
      .then((payload) => {
        if (!cancelled) {
          setQueueSummary(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQueueSummary(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;

    void api
      .listQueueItems({
        status: statusFilter || undefined,
        sourceType: sourceTypeFilter || undefined,
        query: debouncedQuery.trim() || undefined,
        limit: 180,
      })
      .then((payload) => {
        if (!cancelled) {
          setQueueItems(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQueueItems(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, debouncedQuery, sourceTypeFilter, statusFilter]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedFileId) {
      setQueueDetail(null);
      setDetailLoading(false);
      return;
    }

    setDetailLoading(true);
    void api
      .getQueueItemDetail(selectedFileId)
      .then((payload) => {
        if (!cancelled) {
          setQueueDetail(payload);
          setDetailLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQueueDetail(null);
          setDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedFileId]);

  const handleRetry = useCallback(
    async (fileId: string) => {
      try {
        await api.retryQueueItem(fileId);
        const [nextSummary, nextList, nextDetail] = await Promise.all([
          api.getQueueSummary(),
          api.listQueueItems({
            status: statusFilter || undefined,
            sourceType: sourceTypeFilter || undefined,
            query: debouncedQuery.trim() || undefined,
            limit: 180,
          }),
          api.getQueueItemDetail(fileId),
        ]);
        setQueueSummary(nextSummary);
        setQueueItems(nextList);
        setQueueDetail(nextDetail);
      } catch {
        // Keep current UI; embedder may show a toast.
      }
    },
    [api, debouncedQuery, sourceTypeFilter, statusFilter],
  );

  return (
    <div className="page-content">
      <div className="page-grid page-grid--queue">
        <section className="page-card">
          <h3>Queue Summary</h3>
          {!queueSummary ? <p className="page-empty">Queue summary unavailable.</p> : null}
          {queueSummary ? (
            <div className="page-stack">
              <div className="page-counts">
                {Object.entries(queueSummary.counts).map(([key, value]) => (
                  <div key={key}>
                    <small>{key}</small>
                    <strong>{formatNumber(value)}</strong>
                  </div>
                ))}
              </div>
              <div className="page-section">
                <h4>Filters</h4>
                <div className="filters">
                  <select
                    value={statusFilter}
                    onInput={(event) => setStatusFilter((event.currentTarget as HTMLSelectElement).value)}
                  >
                    <option value="">all status</option>
                    <option value="pending">pending</option>
                    <option value="processing">processing</option>
                    <option value="done">done</option>
                    <option value="skipped">skipped</option>
                    <option value="error">error</option>
                  </select>
                  <input
                    value={sourceTypeFilter}
                    placeholder="source type"
                    onInput={(event) => setSourceTypeFilter((event.currentTarget as HTMLInputElement).value)}
                  />
                  <input
                    value={queryFilter}
                    placeholder="file id / decision / result"
                    onInput={(event) => setQueryFilter((event.currentTarget as HTMLInputElement).value)}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </section>

        <section className="page-card">
          <h3>Queue Items</h3>
          {!queueItems ? <p className="page-empty">Queue list unavailable.</p> : null}
          {queueItems ? (
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
                  {queueItems.items.map((item) => (
                    <tr key={item.fileId}>
                      <td>{item.fileName ?? item.fileId}</td>
                      <td>{item.status}</td>
                      <td>{item.decision ?? "n/a"}</td>
                      <td>{formatRelativeTime(item.timing?.queuedAt ?? null)}</td>
                      <td className="row-actions">
                        <button type="button" onClick={() => setSelectedFileId(item.fileId)}>
                          detail
                        </button>
                        <button type="button" onClick={() => void handleRetry(item.fileId)} disabled={!canRetryQueueItem(item.status)}>
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

        <section className="page-card">
          <h3>Queue Item Detail</h3>
          {detailLoading ? <p className="page-empty">Loading detail…</p> : null}
          {!detailLoading && !queueDetail ? <p className="page-empty">Select an item to inspect artifacts.</p> : null}
          {!detailLoading && queueDetail ? (
            <div className="page-stack">
              <p>
                <strong>{queueDetail.item.fileName ?? queueDetail.item.fileId}</strong>
              </p>
              <p className="muted">{queueDetail.item.errorMessage ?? "No error message."}</p>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{queueDetail.item.status}</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>{formatNumber(queueDetail.item.attempts ?? 0)}</dd>
                </div>
                <div>
                  <dt>Wait</dt>
                  <dd>{formatDuration(queueDetail.item.timing?.waitDurationMs ?? null)}</dd>
                </div>
                <div>
                  <dt>Process</dt>
                  <dd>{formatDuration(queueDetail.item.timing?.processingDurationMs ?? null)}</dd>
                </div>
                <div>
                  <dt>Result</dt>
                  <dd>{queueDetail.item.resultPageId ?? "n/a"}</dd>
                </div>
              </dl>
              <div className="detail-card__actions">
                <button
                  type="button"
                  onClick={() => void handleRetry(queueDetail.item.fileId)}
                  disabled={!canRetryQueueItem(queueDetail.item.status)}
                >
                  retry item
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent(INSPECT_QUEUE_LOGS_EVENT, {
                        detail: { fileId: queueDetail.item.fileId },
                      }),
                    );
                  }}
                >
                  trace logs
                </button>
              </div>
              {queueDetail.linkedPages?.length ? (
                <div className="page-section">
                  <h4>Linked Pages</h4>
                  <div className="inline-actions">
                    {queueDetail.linkedPages.map((page) => (
                      <button key={page.id} type="button" className="row-link" onClick={() => onOpenPage(page.id)}>
                        {page.title}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="page-section">
                <h4>Artifact Preview</h4>
                <pre>{queueArtifactPreview(queueDetail)}</pre>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

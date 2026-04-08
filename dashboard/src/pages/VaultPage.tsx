import { useCallback, useEffect, useState } from "preact/hooks";

import type { DashboardApiClient } from "../api/client";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import type { DashboardVaultFileDetail, DashboardVaultFilesResponse, DashboardVaultSummary } from "../types/dashboard";
import { formatBytes, formatDateTime, formatNumber } from "../utils/format";

export interface VaultPageProps {
  api: DashboardApiClient;
  onOpenPage: (pageId: string) => void;
}

export function VaultPage({ api, onOpenPage }: VaultPageProps) {
  const [vaultSummary, setVaultSummary] = useState<DashboardVaultSummary | null>(null);
  const [vaultFiles, setVaultFiles] = useState<DashboardVaultFilesResponse | null>(null);
  const [vaultDetail, setVaultDetail] = useState<DashboardVaultFileDetail | null>(null);
  const [sourceTypeFilter, setSourceTypeFilter] = useState("");
  const [queueStatusFilter, setQueueStatusFilter] = useState("");
  const [queryFilter, setQueryFilter] = useState("");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  const debouncedQuery = useDebouncedValue(queryFilter, 220);

  useEffect(() => {
    let cancelled = false;
    void api
      .getVaultSummary()
      .then((payload) => {
        if (!cancelled) {
          setVaultSummary(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVaultSummary(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;

    void api
      .listVaultFiles({
        query: debouncedQuery.trim() || undefined,
        sourceType: sourceTypeFilter || undefined,
        queueStatus: queueStatusFilter || undefined,
        limit: 180,
      })
      .then((payload) => {
        if (!cancelled) {
          setVaultFiles(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVaultFiles(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, debouncedQuery, queueStatusFilter, sourceTypeFilter]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedFileId) {
      setVaultDetail(null);
      return;
    }

    void api
      .getVaultFileDetail(selectedFileId)
      .then((payload) => {
        if (!cancelled) {
          setVaultDetail(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVaultDetail(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedFileId]);

  const handleOpenVaultFile = useCallback(
    async (fileId: string) => {
      try {
        await api.openVaultFile(fileId);
      } catch {
        // Embedder may surface errors.
      }
    },
    [api],
  );

  return (
    <div className="page-content">
      <div className="page-grid page-grid--vault">
        <section className="page-card">
          <h3>Vault Coverage</h3>
          {!vaultSummary ? <p className="page-empty">Vault summary unavailable.</p> : null}
          {vaultSummary ? (
            <div className="page-stack">
              <dl>
                <div>
                  <dt>Files</dt>
                  <dd>{formatNumber(vaultSummary.totalFiles)}</dd>
                </div>
                <div>
                  <dt>Total Bytes</dt>
                  <dd>{formatBytes(vaultSummary.totalBytes)}</dd>
                </div>
                <div>
                  <dt>Mapped Pages</dt>
                  <dd>{formatNumber(vaultSummary.mappedPages)}</dd>
                </div>
                <div>
                  <dt>Not Queued</dt>
                  <dd>{formatNumber(vaultSummary.coverage.notQueued)}</dd>
                </div>
              </dl>
              <div className="page-section">
                <h4>Filters</h4>
                <div className="filters">
                  <input
                    value={sourceTypeFilter}
                    placeholder="source type"
                    onInput={(event) => setSourceTypeFilter((event.currentTarget as HTMLInputElement).value)}
                  />
                  <select
                    value={queueStatusFilter}
                    onInput={(event) => setQueueStatusFilter((event.currentTarget as HTMLSelectElement).value)}
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
                    value={queryFilter}
                    placeholder="file id / name / cache"
                    onInput={(event) => setQueryFilter((event.currentTarget as HTMLInputElement).value)}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </section>

        <section className="page-card">
          <h3>Files</h3>
          {!vaultFiles ? <p className="page-empty">No vault files loaded.</p> : null}
          {vaultFiles ? (
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
                  {vaultFiles.items.map((item) => (
                    <tr key={item.fileId}>
                      <td>
                        <button type="button" className="row-link" onClick={() => setSelectedFileId(item.fileId)}>
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

        <section className="page-card">
          <h3>Selected File</h3>
          {!vaultDetail ? <p className="page-empty">Select a file to inspect preview and local cache paths.</p> : null}
          {vaultDetail ? (
            <div className="page-stack">
              <p>
                <strong>{vaultDetail.file.fileName}</strong>
              </p>
              <p className="muted">{vaultDetail.file.localPath ?? vaultDetail.file.filePath}</p>
              <dl>
                <div>
                  <dt>Cache</dt>
                  <dd>{vaultDetail.file.cacheStatus}</dd>
                </div>
                <div>
                  <dt>Queue</dt>
                  <dd>{vaultDetail.queueItem?.status ?? "not-queued"}</dd>
                </div>
                <div>
                  <dt>Pages</dt>
                  <dd>{formatNumber(vaultDetail.relatedPages.length)}</dd>
                </div>
                <div>
                  <dt>Indexed</dt>
                  <dd>{formatDateTime(vaultDetail.file.indexedAt)}</dd>
                </div>
              </dl>
              {vaultDetail.relatedPages.length ? (
                <div className="page-section">
                  <h4>Generated Pages</h4>
                  <div className="inline-actions">
                    {vaultDetail.relatedPages.map((page) => (
                      <button key={page.id} type="button" className="row-link" onClick={() => onOpenPage(page.id)}>
                        {page.title}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <pre>{vaultDetail.file.preview ?? "No preview available."}</pre>
              <div className="detail-card__actions">
                <button type="button" onClick={() => void handleOpenVaultFile(vaultDetail.file.fileId)}>
                  open local file
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

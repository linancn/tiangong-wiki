import { useState } from "preact/hooks";

import type { DashboardApiClient } from "../api/client";
import { mockLogs } from "../constants/mockData";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useLogStream } from "../hooks/useLogStream";
import { formatDateTime } from "../utils/format";

export interface LogsPageProps {
  api: DashboardApiClient;
  usingFallback: boolean;
}

export function LogsPage({ api, usingFallback }: LogsPageProps) {
  const [level, setLevel] = useState("");
  const [fileId, setFileId] = useState("");
  const [query, setQuery] = useState("");

  const debouncedQuery = useDebouncedValue(query, 220);
  const debouncedFileId = useDebouncedValue(fileId, 220);

  const { logs, status: streamStatus } = useLogStream({
    api,
    history: 180,
    level: level === "info" || level === "error" ? level : undefined,
    fileId: debouncedFileId.trim() || undefined,
    query: debouncedQuery.trim() || undefined,
    paused: usingFallback,
  });

  const entries = usingFallback && logs.length === 0 ? mockLogs() : logs;

  return (
    <div className="page-content">
      <div className="page-grid page-grid--logs">
        <section className="page-card">
          <h3>Live Stream</h3>
          <p className="muted">
            status: <strong>{streamStatus}</strong>
          </p>
          <div className="filters">
            <select value={level} onInput={(event) => setLevel((event.currentTarget as HTMLSelectElement).value)}>
              <option value="">all levels</option>
              <option value="info">info</option>
              <option value="error">error</option>
            </select>
            <input
              value={fileId}
              placeholder="file id"
              onInput={(event) => setFileId((event.currentTarget as HTMLInputElement).value)}
            />
            <input
              value={query}
              placeholder="keyword"
              onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
            />
          </div>
        </section>
        <section className="page-card">
          <div className="log-lines">
            {entries.length === 0 ? <p className="page-empty">No logs yet.</p> : null}
            {entries.map((entry) => (
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
    </div>
  );
}

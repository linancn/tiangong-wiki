import type { DashboardApiClient } from "../api/client";
import type { DashboardDoctorSeverity, DashboardStatus } from "../types/dashboard";
import { formatDateTime, formatNumber } from "../utils/format";

export interface SystemPageProps {
  api: DashboardApiClient;
  status: DashboardStatus | null;
}

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

export function SystemPage({ api, status }: SystemPageProps) {
  void api;

  if (!status) {
    return (
      <div className="page-content">
        <p className="page-empty">No system payload yet.</p>
      </div>
    );
  }

  const doctorChecks = normalizeDoctorChecks(status.doctor?.checks);

  return (
    <div className="page-content">
      <div className="page-grid page-grid--system">
        <section className="page-card">
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
        <section className="page-card">
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
        <section className="page-card">
          <h3>Doctor</h3>
          {status.doctor?.summary ? (
            <div className="page-counts">
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
            <p className="page-empty">No doctor checks reported.</p>
          )}
          {status.doctor?.recommendations?.length ? (
            <div className="page-section">
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
    </div>
  );
}

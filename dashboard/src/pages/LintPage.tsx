import { useEffect, useState } from "preact/hooks";

import type { DashboardApiClient } from "../api/client";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import type { DashboardLintIssuesResponse, DashboardLintSummary } from "../types/dashboard";
import { formatNumber } from "../utils/format";

export interface LintPageProps {
  api: DashboardApiClient;
  onOpenPage: (pageId: string) => void;
}

function isActionablePageId(pageId: string | null | undefined): boolean {
  return Boolean(pageId && pageId !== "*" && pageId.includes("/"));
}

export function LintPage({ api, onOpenPage }: LintPageProps) {
  const [lintSummary, setLintSummary] = useState<DashboardLintSummary | null>(null);
  const [lintIssues, setLintIssues] = useState<DashboardLintIssuesResponse | null>(null);
  const [levelFilter, setLevelFilter] = useState("");
  const [groupByFilter, setGroupByFilter] = useState<"flat" | "page" | "rule">("flat");
  const [ruleFilter, setRuleFilter] = useState("");

  const debouncedRule = useDebouncedValue(ruleFilter, 220);

  useEffect(() => {
    let cancelled = false;
    void api
      .getLintSummary()
      .then((payload) => {
        if (!cancelled) {
          setLintSummary(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLintSummary(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;

    void api
      .listLintIssues({
        level: levelFilter || undefined,
        groupBy: groupByFilter,
        rule: debouncedRule.trim() || undefined,
      })
      .then((payload) => {
        if (!cancelled) {
          setLintIssues(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLintIssues(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, debouncedRule, groupByFilter, levelFilter]);

  return (
    <div className="page-content">
      <div className="page-grid page-grid--lint">
        <section className="page-card">
          <h3>Lint Summary</h3>
          {!lintSummary ? <p className="page-empty">Lint summary unavailable.</p> : null}
          {lintSummary ? (
            <div className="page-stack">
              <div className="page-counts">
                <div>
                  <small>errors</small>
                  <strong>{lintSummary.counts.error}</strong>
                </div>
                <div>
                  <small>warnings</small>
                  <strong>{lintSummary.counts.warning}</strong>
                </div>
                <div>
                  <small>info</small>
                  <strong>{lintSummary.counts.info}</strong>
                </div>
                <div>
                  <small>total</small>
                  <strong>{lintSummary.counts.total}</strong>
                </div>
              </div>
              <div className="page-section">
                <h4>Filters</h4>
                <div className="filters">
                  <select value={levelFilter} onInput={(event) => setLevelFilter((event.currentTarget as HTMLSelectElement).value)}>
                    <option value="">all levels</option>
                    <option value="error">error</option>
                    <option value="warning">warning</option>
                    <option value="info">info</option>
                  </select>
                  <select
                    value={groupByFilter}
                    onInput={(event) =>
                      setGroupByFilter((event.currentTarget as HTMLSelectElement).value as "flat" | "page" | "rule")
                    }
                  >
                    <option value="flat">flat</option>
                    <option value="page">group by page</option>
                    <option value="rule">group by rule</option>
                  </select>
                  <input
                    value={ruleFilter}
                    placeholder="rule contains"
                    onInput={(event) => setRuleFilter((event.currentTarget as HTMLInputElement).value)}
                  />
                </div>
              </div>
              {lintSummary.topRules.length ? (
                <div className="page-section">
                  <h4>Top Rules</h4>
                  <ul className="compact-list">
                    {lintSummary.topRules.slice(0, 5).map((rule) => (
                      <li key={rule.rule}>
                        <code>{rule.rule}</code>
                        <span>{formatNumber(rule.count)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {lintSummary.topPages.length ? (
                <div className="page-section">
                  <h4>Top Pages</h4>
                  <ul className="compact-list">
                    {lintSummary.topPages.slice(0, 5).map((page) => (
                      <li key={page.pageId}>
                        {isActionablePageId(page.pageId) ? (
                          <button type="button" className="row-link" onClick={() => onOpenPage(page.pageId)}>
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
        <section className="page-card">
          <h3>Issues</h3>
          {lintIssues?.items?.length ? (
            <ul className="lint-list">
              {lintIssues.items.map((issue, index) => (
                <li key={`${issue.pageId}-${issue.check}-${index}`}>
                  <div>
                    <strong>{issue.level.toUpperCase()}</strong>
                    <code>{issue.check}</code>
                  </div>
                  <p>{issue.message}</p>
                  <small>{issue.pageTitle ?? issue.pageId}</small>
                  {isActionablePageId(issue.pageId) ? (
                    <div className="row-actions">
                      <button type="button" onClick={() => onOpenPage(issue.pageId)}>
                        open page
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : lintIssues?.groups?.length ? (
            <ul className="lint-list">
              {lintIssues.groups.map((group) => (
                <li key={group.key}>
                  <div>
                    <strong>{group.key}</strong>
                    <code>{group.count} findings</code>
                  </div>
                  <p>{group.items[0]?.message ?? "Grouped lint findings."}</p>
                  <small>{group.pageTitle ?? group.pageType ?? "grouped"}</small>
                  {isActionablePageId(group.items[0]?.pageId) ? (
                    <div className="row-actions">
                      <button type="button" onClick={() => onOpenPage(group.items[0]!.pageId)}>
                        open page
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="page-empty">No lint issues returned.</p>
          )}
        </section>
      </div>
    </div>
  );
}

import { useState } from "preact/hooks";

import { colorForPageType } from "../constants/pageTypeColors";
import type { DashboardPageDetailResponse, DashboardPageSourceResponse, DashboardPageSummary } from "../types/dashboard";
import { formatRelativeTime } from "../utils/format";

interface DetailPanelProps {
  pageDetail: DashboardPageDetailResponse | null;
  pageSource: DashboardPageSourceResponse | null;
  loading: boolean;
  onClose: () => void;
  onNavigateToPage: (pageId: string) => void;
  onOpenSource: (target: "vault" | "page") => void;
  sourceActionPending: boolean;
  sourceActionMessage: string | null;
}

function resolveRelationPage(
  relation: DashboardPageDetailResponse["relations"][number],
): DashboardPageSummary | null {
  return relation.direction === "incoming" ? relation.source ?? null : relation.target ?? null;
}

function shortPath(fullPath: string): string {
  const marker = "/pages/";
  const idx = fullPath.lastIndexOf(marker);
  return idx >= 0 ? fullPath.slice(idx + marker.length) : fullPath;
}

function cleanSummary(raw: string, pageType: string): string {
  let text = raw;
  const bracketPrefix = `[${pageType}]`;
  if (text.startsWith(bracketPrefix)) {
    text = text.slice(bracketPrefix.length).trimStart();
  }
  const fmSep = text.indexOf("---");
  if (fmSep > 0) {
    const afterSep = text.slice(fmSep + 3).trimStart();
    if (afterSep.length > 10) {
      return afterSep;
    }
  }
  const titleEnd = text.indexOf("\n");
  if (titleEnd > 0) {
    text = text.slice(titleEnd + 1).trimStart();
  }
  text = text
    .replace(/^标签[:：]\s*.+$/m, "")
    .replace(/^tags[:：]\s*.+$/im, "")
    .trimStart();
  return text;
}

interface MergedRelation {
  page: DashboardPageSummary | null;
  rawLabel: string;
  edgeTypes: string[];
  direction: "incoming" | "outgoing";
}

function mergeRelations(relations: DashboardPageDetailResponse["relations"]): {
  outgoing: MergedRelation[];
  incoming: MergedRelation[];
} {
  const outMap = new Map<string, MergedRelation>();
  const inMap = new Map<string, MergedRelation>();

  for (const rel of relations) {
    const page = resolveRelationPage(rel);
    const key = page?.id ?? `raw:${rel.rawSource ?? rel.rawTarget ?? "?"}`;
    const map = rel.direction === "outgoing" ? outMap : inMap;
    const existing = map.get(key);
    if (existing) {
      if (!existing.edgeTypes.includes(rel.edgeType)) {
        existing.edgeTypes.push(rel.edgeType);
      }
    } else {
      map.set(key, {
        page,
        rawLabel: rel.rawSource ?? rel.rawTarget ?? "unresolved",
        edgeTypes: [rel.edgeType],
        direction: rel.direction,
      });
    }
  }

  return {
    outgoing: [...outMap.values()],
    incoming: [...inMap.values()],
  };
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw;
  return raw.slice(end + 4).trimStart();
}

function previewText(source: DashboardPageSourceResponse | null): string {
  if (!source) return "Select a node to inspect page source.";
  if (source.vaultSource?.preview) return stripFrontmatter(source.vaultSource.preview);
  if (source.pageSource.rawMarkdown) return stripFrontmatter(source.pageSource.rawMarkdown.slice(0, 1200));
  if (source.vaultSource?.previewError) return source.vaultSource.previewError;
  return "No preview available.";
}

const COLLAPSE_THRESHOLD = 6;
const DEFAULT_VISIBLE = 3;

function RelationGroup({
  label,
  items,
  total,
  forceExpand,
  onNavigateToPage,
}: {
  label: string;
  items: MergedRelation[];
  total: number;
  forceExpand: boolean;
  onNavigateToPage: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(!forceExpand);
  const [showAll, setShowAll] = useState(forceExpand);
  const visible = collapsed ? [] : showAll ? items : items.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = items.length - visible.length;

  return (
    <div className="relation-group">
      <button
        type="button"
        className="relation-group__head"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="relation-group__arrow">{collapsed ? "\u25B6" : "\u25BC"}</span>
        <span>
          {label} <small>({total})</small>
        </span>
      </button>

      {!collapsed && (
        <div className="detail-panel__relations">
          {visible.map((merged) => {
            if (!merged.page) {
              return (
                <div key={`${merged.direction}-${merged.rawLabel}`} className="relation-item">
                  <span>
                    <strong>{merged.rawLabel}</strong>
                    <small>{merged.edgeTypes.join(" · ")}</small>
                  </span>
                  <code>raw</code>
                </div>
              );
            }
            return (
              <button
                key={`${merged.direction}-${merged.page.id}`}
                className="relation-item"
                type="button"
                onClick={() => onNavigateToPage(merged.page!.id)}
              >
                <span>
                  <strong>{merged.page.title}</strong>
                  <small>{merged.edgeTypes.join(" · ")}</small>
                </span>
                <code>{merged.page.pageType}</code>
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="relation-group__more"
              onClick={() => setShowAll(true)}
            >
              show {hiddenCount} more…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DetailPanel({
  pageDetail,
  pageSource,
  loading,
  onClose,
  onNavigateToPage,
  onOpenSource,
  sourceActionPending,
  sourceActionMessage,
}: DetailPanelProps) {
  const accentColor = pageDetail ? colorForPageType(pageDetail.page.pageType) : "var(--accent)";
  const isOpen = loading || Boolean(pageDetail);
  const [sourceExpanded, setSourceExpanded] = useState(false);

  const merged = pageDetail ? mergeRelations(pageDetail.relations) : null;
  const totalMerged = merged ? merged.outgoing.length + merged.incoming.length : 0;
  const forceExpand = totalMerged <= COLLAPSE_THRESHOLD;

  const summary = pageDetail?.page.summaryText
    ? cleanSummary(pageDetail.page.summaryText, pageDetail.page.pageType)
    : "";

  const vaultFileId = pageSource?.vaultSource?.fileId;

  return (
    <aside className={`detail-panel ${isOpen ? "is-open" : ""}`}>
      <div
        className="detail-panel__surface"
        style={{ ["--detail-accent" as "--detail-accent"]: accentColor }}
      >
        <header className="detail-panel__header">
          <div>
            <span className="shell-eyebrow">Node dossier</span>
            <strong>Focused page</strong>
          </div>
          <button type="button" onClick={onClose}>
            close
          </button>
        </header>

        {!pageDetail && !loading ? (
          <div className="detail-panel__empty">
            <p>Choose a node from the graph or search results to inspect metadata, source traces, and relation threads.</p>
          </div>
        ) : null}

        {loading ? (
          <div className="detail-panel__empty">
            <p>Locking node dossier…</p>
          </div>
        ) : null}

        {pageDetail ? (
          <div className="detail-panel__content">
            {/* ── Hero ── */}
            <section className="detail-panel__hero">
              <div className="detail-panel__badges detail-tags">
                <code>{pageDetail.page.pageType}</code>
                <code>{pageDetail.page.status}</code>
              </div>
              <h2>{pageDetail.page.title}</h2>
              <p className="detail-panel__path" title={pageDetail.page.pagePath}>
                <code>{shortPath(pageDetail.page.pagePath)}</code>
              </p>
              {summary ? (
                <p className="detail-panel__summary">{summary}</p>
              ) : (
                <p className="detail-panel__summary muted">No summary generated yet.</p>
              )}
              <div className="detail-panel__meta-bar">
                <span>{pageDetail.relationCounts.outgoing} out</span>
                <span className="detail-panel__meta-dot" />
                <span>{pageDetail.relationCounts.incoming} in</span>
                <span className="detail-panel__meta-dot" />
                <span>{formatRelativeTime(pageDetail.page.updatedAt)}</span>
                {pageDetail.page.tags.length > 0 && (
                  <>
                    <span className="detail-panel__meta-dot" />
                    <span className="detail-panel__meta-tags">
                      {pageDetail.page.tags.slice(0, 3).join(", ")}
                      {pageDetail.page.tags.length > 3 ? ` +${pageDetail.page.tags.length - 3}` : ""}
                    </span>
                  </>
                )}
              </div>
            </section>

            <div className="detail-panel__divider" />

            {/* ── Relations ── */}
            <section className="detail-panel__block">
              <div className="detail-panel__block-head">
                <span className="shell-eyebrow">Connected threads</span>
                <strong>Relations</strong>
              </div>
              {merged && merged.outgoing.length === 0 && merged.incoming.length === 0 ? (
                <p className="muted">No relations for current node.</p>
              ) : null}
              {merged && merged.outgoing.length > 0 && (
                <RelationGroup
                  label="Outgoing"
                  items={merged.outgoing}
                  total={pageDetail.relationCounts.outgoing}
                  forceExpand={forceExpand}
                  onNavigateToPage={onNavigateToPage}
                />
              )}
              {merged && merged.incoming.length > 0 && (
                <RelationGroup
                  label="Incoming"
                  items={merged.incoming}
                  total={pageDetail.relationCounts.incoming}
                  forceExpand={forceExpand}
                  onNavigateToPage={onNavigateToPage}
                />
              )}
            </section>

            <div className="detail-panel__divider" />

            {/* ── Source ── */}
            <section className="detail-panel__block">
              <div className="detail-panel__source-head">
                <div className="detail-panel__block-head">
                  <span className="shell-eyebrow">Local source trace</span>
                  <strong>Source</strong>
                </div>
                <div className="detail-panel__source-actions">
                  <button type="button" onClick={() => onOpenSource("page")} disabled={sourceActionPending} title="Open page source">
                    page
                  </button>
                  <button type="button" onClick={() => onOpenSource("vault")} disabled={sourceActionPending} title="Open vault source">
                    vault
                  </button>
                </div>
              </div>
              {vaultFileId ? (
                <p className="muted detail-panel__vault-path">{vaultFileId}</p>
              ) : null}
              {sourceActionMessage ? <p className="detail-card__message">{sourceActionMessage}</p> : null}
              <button
                type="button"
                className="relation-group__more"
                onClick={() => setSourceExpanded((v) => !v)}
              >
                {sourceExpanded ? "hide preview" : "show preview"}
              </button>
              {sourceExpanded && <pre>{previewText(pageSource)}</pre>}
            </section>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

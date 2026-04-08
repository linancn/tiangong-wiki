import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { DashboardGraphOverview, DashboardStatus } from "../types/dashboard";
import { formatNumber } from "../utils/format";

export type IgnitionMode = "full" | "short" | "reduced";

interface ConstellationIgnitionProps {
  graph: DashboardGraphOverview | null;
  status: DashboardStatus | null;
  mode: IgnitionMode;
  onComplete: () => void;
}

const FRAGMENTS = [
  "/vault/physics/quantum/entanglement.md",
  "/vault/ops/queue/incident-72.md",
  "node:qk-9012",
  "node:br-042",
  "edge:references",
  "embedding:ready",
  "graph:overview(limit=120)",
  "source:synology-cache",
];

const FULL_PHASES: Array<{ phase: number; atMs: number }> = [
  { phase: 1, atMs: 800 },
  { phase: 2, atMs: 2800 },
  { phase: 3, atMs: 3600 },
  { phase: 4, atMs: 4400 },
  { phase: 5, atMs: 5800 },
];

const FULL_DURATION_MS = 7500;
const SHORT_DURATION_MS = 1000;
const REDUCED_DURATION_MS = 850;
const FULL_READY_TIMEOUT_MS = 1400;
function ignitionDuration(mode: IgnitionMode): number {
  if (mode === "full") {
    return FULL_DURATION_MS;
  }
  if (mode === "short") {
    return SHORT_DURATION_MS;
  }
  return REDUCED_DURATION_MS;
}

function buildFragments(graph: DashboardGraphOverview | null): string[] {
  if (!graph?.nodes.length) {
    return FRAGMENTS;
  }

  return graph.nodes
    .flatMap((node) => [
      node.filePath,
      `node:${node.nodeKey}`,
      `type:${node.pageType}`,
      `status:${node.status}`,
      node.orphan ? "graph:orphan-sample" : `degree:${node.degree}`,
    ])
    .filter(Boolean)
    .slice(0, 14);
}

export function ConstellationIgnition({ graph, status, mode, onComplete }: ConstellationIgnitionProps) {
  const [resolvedMode, setResolvedMode] = useState<IgnitionMode | null>(() => (mode === "full" ? null : mode));
  const [phase, setPhase] = useState(mode === "full" ? 0 : 5);
  const skipReadyRef = useRef(mode !== "full");

  const fragments = useMemo(() => buildFragments(graph), [graph]);
  const nodeCount = graph?.totalNodes ?? 0;
  const edgeCount = graph?.totalEdges ?? 0;
  const visibleNodeCount = graph?.visibleNodeCount ?? 0;
  const queuePending = status?.queue.pending ?? 0;
  const overviewLabel = graph?.truncated
    ? `live overview slice ready · ${visibleNodeCount}/${nodeCount} nodes visible`
    : `live overview ready · ${visibleNodeCount} nodes visible`;
  const activeMode = resolvedMode ?? mode;

  useEffect(() => {
    if (mode !== "full") {
      setResolvedMode(mode);
      return;
    }

    if (resolvedMode !== null) {
      return;
    }

    if (graph?.nodes.length) {
      setResolvedMode("full");
      return;
    }

    const fallbackTimer = window.setTimeout(() => {
      setResolvedMode("short");
    }, FULL_READY_TIMEOUT_MS);

    return () => {
      window.clearTimeout(fallbackTimer);
    };
  }, [graph?.nodes.length, mode, resolvedMode]);

  useEffect(() => {
    if (resolvedMode === null) {
      setPhase(0);
      return;
    }

    const duration = ignitionDuration(resolvedMode);
    const timers: number[] = [];
    setPhase(resolvedMode === "full" ? 0 : 5);
    skipReadyRef.current = resolvedMode !== "full";

    if (resolvedMode === "full") {
      timers.push(
        window.setTimeout(() => {
          skipReadyRef.current = true;
        }, 180),
      );
      for (const mark of FULL_PHASES) {
        timers.push(window.setTimeout(() => setPhase(mark.phase), mark.atMs));
      }
    }

    timers.push(window.setTimeout(() => onComplete(), duration));

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "Escape" || event.key === "Enter") && skipReadyRef.current) {
        onComplete();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onComplete, resolvedMode]);

  return (
    <div
      className={`ignition-overlay ignition-overlay--phase-${phase} ignition-overlay--${activeMode}`}
      onClick={() => {
        if (skipReadyRef.current) {
          onComplete();
        }
      }}
      role="presentation"
    >
      <div className="ignition-overlay__aurora ignition-overlay__aurora--primary" />
      <div className="ignition-overlay__aurora ignition-overlay__aurora--secondary" />
      <div className="ignition-overlay__grid" />
      <div className="ignition-overlay__noise" />
      <div className="ignition-overlay__vignette" />
      <button
        className="ignition-skip"
        onClick={(event) => {
          event.stopPropagation();
          if (skipReadyRef.current) {
            onComplete();
          }
        }}
        type="button"
      >
        Enter / Skip
      </button>

      {phase < 3 && <div className="ignition-heartbeat" />}

      {resolvedMode === null ? (
        <div className="ignition-statusline">
          <strong>assembling live overview</strong>
          <span>waiting for the first graph slice</span>
        </div>
      ) : null}

      {phase === 1 && (
        <div className="ignition-fragments">
          {fragments.map((fragment, index) => (
            <span
              key={`${fragment}-${index}`}
              className="ignition-fragment"
              style={{
                ["--fragment-delay" as "--fragment-delay"]: `${(index % 6) * 120}ms`,
                ["--fragment-angle" as "--fragment-angle"]: `${(index * 29) % 360}deg`,
              }}
            >
              {fragment}
            </span>
          ))}
        </div>
      )}

      {phase === 2 && <div className="ignition-implosion" />}
      {phase === 3 && <div className="ignition-flash" />}

      {phase >= 4 && (
        <div className="ignition-emergence">
          <div className="ignition-emergence__metrics">
            <div className="ignition-emergence__card">
              <strong>{formatNumber(nodeCount)}</strong>
              <span>library nodes</span>
            </div>
            <div className="ignition-emergence__card">
              <strong>{formatNumber(edgeCount)}</strong>
              <span>indexed relations</span>
            </div>
            <div className="ignition-emergence__card">
              <strong>{formatNumber(queuePending)}</strong>
              <span>queue pending</span>
            </div>
          </div>
          <div className="ignition-emergence__scan">
            <div />
            <p>
              semantic lock acquired
              {graph?.sampleStrategy?.limit ? ` · overview cap ${graph.sampleStrategy.limit}` : ""}
            </p>
          </div>
        </div>
      )}

      {phase >= 5 && (
        <div className="ignition-reveal">
          <p>whole-library overview ready</p>
          <h1>Wiki Intelligence</h1>
          <span>{overviewLabel}</span>
        </div>
      )}
    </div>
  );
}

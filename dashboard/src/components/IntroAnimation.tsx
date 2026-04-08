import { useEffect, useMemo, useState } from "preact/hooks";

import type { DashboardGraphOverview, DashboardStatus } from "../types/dashboard";
import { useReducedMotion } from "../hooks/useReducedMotion";

interface IntroAnimationProps {
  graph: DashboardGraphOverview | null;
  status: DashboardStatus | null;
  onComplete: () => void;
}

interface FragmentToken {
  id: string;
  label: string;
  x: number;
  y: number;
  delayMs: number;
}

const VISITED_KEY = "wiki-dashboard-intro-complete";

const PHASES = {
  heartbeat: 800,
  fragments: 2800,
  implosion: 3600,
  flash: 4400,
  emergence: 5800,
  reveal: 7500,
};

function buildTokens(graph: DashboardGraphOverview | null, status: DashboardStatus | null): FragmentToken[] {
  const graphTokens = graph?.nodes.slice(0, 12).map((node, index) => ({
    id: `${node.nodeKey}-${index}`,
    label: `${node.pageType}:${node.nodeKey}`,
    x: 10 + ((index * 17) % 80),
    y: 8 + ((index * 13) % 72),
    delayMs: index * 90,
  })) ?? [];

  const queueTokens = [
    `queue/pending=${status?.queue.pending ?? 0}`,
    `queue/processing=${status?.queue.processing ?? 0}`,
    `daemon:${status?.daemon.currentTask ?? "idle"}`,
    `vault:${status?.runtime?.vaultSource ?? "local"}`,
    "index/shockwave",
    "graph/overview",
  ].map((label, index) => ({
    id: `meta-${index}`,
    label,
    x: 18 + ((index * 23) % 66),
    y: 12 + ((index * 19) % 70),
    delayMs: 150 + index * 110,
  }));

  return [...graphTokens, ...queueTokens].slice(0, 18);
}

export function IntroAnimation(props: IntroAnimationProps) {
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<"heartbeat" | "fragments" | "implosion" | "flash" | "emergence" | "reveal">(
    "heartbeat",
  );
  const [closing, setClosing] = useState(false);
  const visited = useMemo(() => window.sessionStorage.getItem(VISITED_KEY) === "true", []);
  const tokens = useMemo(() => buildTokens(props.graph, props.status), [props.graph, props.status]);

  useEffect(() => {
    const shortMode = reducedMotion || visited;
    if (shortMode) {
      const finishTimer = window.setTimeout(() => {
        window.sessionStorage.setItem(VISITED_KEY, "true");
        props.onComplete();
      }, reducedMotion ? 420 : 980);
      return () => window.clearTimeout(finishTimer);
    }

    const timers = [
      window.setTimeout(() => setPhase("fragments"), PHASES.heartbeat),
      window.setTimeout(() => setPhase("implosion"), PHASES.fragments),
      window.setTimeout(() => setPhase("flash"), PHASES.implosion),
      window.setTimeout(() => setPhase("emergence"), PHASES.flash),
      window.setTimeout(() => setPhase("reveal"), PHASES.emergence),
      window.setTimeout(() => {
        window.sessionStorage.setItem(VISITED_KEY, "true");
        props.onComplete();
      }, PHASES.reveal),
    ];

    const onSkip = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") {
        setClosing(true);
        window.sessionStorage.setItem(VISITED_KEY, "true");
        window.setTimeout(props.onComplete, 180);
      }
    };

    window.addEventListener("keydown", onSkip);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("keydown", onSkip);
    };
  }, [props, reducedMotion, visited]);

  const shortMode = reducedMotion || visited;

  if (shortMode) {
    return (
      <div className={`intro intro--short ${closing ? "intro--closing" : ""}`} onClick={props.onComplete}>
        <div className="intro__grain" />
        <div className="intro__short-mark">
          <p className="eyebrow">Wiki Intelligence</p>
          <h1>Wiki Dashboard</h1>
          <span>Local knowledge observatory</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`intro intro--full intro--${phase} ${closing ? "intro--closing" : ""}`} onClick={() => {
      setClosing(true);
      window.sessionStorage.setItem(VISITED_KEY, "true");
      window.setTimeout(props.onComplete, 180);
    }}>
      <div className="intro__grain" />
      <div className="intro__stars" />
      <button className="intro__skip" type="button">
        Skip
      </button>

      <div className="intro__pulse" />
      <div className="intro__shockwave" />
      <div className="intro__flash" />

      <div className="intro__token-cloud" aria-hidden="true">
        {tokens.map((token) => (
          <span
            key={token.id}
            className="intro__token"
            style={{
              left: `${token.x}%`,
              top: `${token.y}%`,
              "--token-delay": `${token.delayMs}ms`,
            }}
          >
            {token.label}
          </span>
        ))}
      </div>

      <div className="intro__core">
        <div className="intro__phase intro__phase--heartbeat">
          <p className="eyebrow">Vault fragments detected</p>
          <h1>Constellation Ignition</h1>
          <span>Heartbeat / Warp trails / Graph seed</span>
        </div>

        <div className="intro__phase intro__phase--emergence">
          <div className="intro__metric-grid">
            <div>
              <strong>{props.graph?.totalNodes ?? 0}</strong>
              <span>Total Pages</span>
            </div>
            <div>
              <strong>{props.graph?.visibleNodeCount ?? 0}</strong>
              <span>Visible Nodes</span>
            </div>
            <div>
              <strong>{props.status?.queue.processing ?? 0}</strong>
              <span>Active Queue</span>
            </div>
          </div>
          <div className="intro__scanner">
            <div className="intro__scanner-line" />
            <span>semantic emergence</span>
          </div>
        </div>

        <div className="intro__phase intro__phase--reveal">
          <div className="intro__wireframe">
            <div className="intro__wireframe-top" />
            <div className="intro__wireframe-rail" />
            <div className="intro__wireframe-detail" />
            <div className="intro__wireframe-dock" />
            <div className="intro__wireframe-core" />
          </div>
          <p className="eyebrow">Vault fragments → page clusters → live graph</p>
          <h1>Wiki Dashboard</h1>
        </div>
      </div>
    </div>
  );
}

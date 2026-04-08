import { Graph, GraphEvent, NodeEvent, type GraphData } from "@antv/g6";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";

import { colorForPageType } from "../constants/pageTypeColors";
import type { DashboardGraphEdge, DashboardGraphNode, DashboardGraphOverview, DashboardPageSummary } from "../types/dashboard";
import { clamp } from "../utils/format";

interface GraphCanvasProps {
  graph: DashboardGraphOverview | null;
  selectedPageId: string | null;
  selectionFocusKey: number;
  focusedPage: DashboardPageSummary | null;
  loading: boolean;
  searchQuery: string;
  searchResultCount: number;
  resetViewToken: number;
  onSelectPage: (pageId: string) => void;
  onDeselectPage: () => void;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface DetachedStageNode extends DashboardPageSummary {
  nodeKey: string;
  degree: number;
  orphan: boolean;
  detached: true;
}

interface FocusCardAnchor {
  left: string;
  top: string;
}

const DEFAULT_SIZE: ViewportSize = {
  width: 1200,
  height: 720,
};

const GRAPH_PADDING = [116, 180, 132, 132];
const FOCUS_GHOST_PREFIX = "__focus__:";

function useViewportSize<T extends HTMLElement>(): [RefObject<T>, ViewportSize] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ViewportSize>(DEFAULT_SIZE);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setSize({
        width: entry.contentRect.width || DEFAULT_SIZE.width,
        height: entry.contentRect.height || DEFAULT_SIZE.height,
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

function edgeId(edge: DashboardGraphEdge): string {
  return `${edge.source}->${edge.target}:${edge.edgeType}`;
}

function nodeRadius(node: Pick<DashboardGraphNode, "degree">): number {
  return Math.max(8, Math.min(18, 8 + node.degree * 1.35));
}

function shouldShowLabel(node: Pick<DashboardGraphNode, "degree" | "orphan">, nodeCount: number): boolean {
  if (nodeCount <= 14) {
    return true;
  }
  if (node.orphan) {
    return nodeCount <= 20;
  }
  const threshold = nodeCount > 40 ? 8 : nodeCount > 25 ? 6 : 4;
  return node.degree >= threshold;
}

function edgeStroke(edgeType: string): string {
  const normalized = edgeType.toLowerCase();
  if (normalized.includes("source")) {
    return "rgba(104, 168, 255, 0.28)";
  }
  if (normalized.includes("valid") || normalized.includes("support")) {
    return "rgba(88, 214, 167, 0.24)";
  }
  if (normalized.includes("counter") || normalized.includes("prereq")) {
    return "rgba(255, 122, 122, 0.24)";
  }
  return "rgba(214, 226, 255, 0.16)";
}

function edgeDash(edgeType: string): number[] | undefined {
  const normalized = edgeType.toLowerCase();
  if (normalized.includes("source")) {
    return [4, 8];
  }
  if (normalized.includes("counter")) {
    return [8, 8];
  }
  return undefined;
}

function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

function buildDetachedNode(focusedPage: DashboardPageSummary | null, graph: DashboardGraphOverview | null): DetachedStageNode | null {
  if (!focusedPage || !graph) {
    return null;
  }
  if (graph.nodes.some((node) => node.id === focusedPage.id)) {
    return null;
  }
  return {
    ...focusedPage,
    nodeKey: `${FOCUS_GHOST_PREFIX}${focusedPage.id}`,
    degree: 0,
    orphan: false,
    detached: true,
  };
}

function buildGraphData(options: {
  graph: DashboardGraphOverview;
  detachedNode: DetachedStageNode | null;
}): GraphData {
  const { graph, detachedNode } = options;

  const nodes = graph.nodes.map((node) => {
    const color = colorForPageType(node.pageType);
    const labelVisible = shouldShowLabel(node, graph.nodes.length);

    return {
      id: node.nodeKey,
      data: {
        pageId: node.id,
        pageType: node.pageType,
        title: node.title,
        status: node.status,
        nodeKey: node.nodeKey,
        degree: node.degree,
        detached: false,
      },
      style: {
        size: nodeRadius(node),
        fill: color,
        stroke: "#eff4ff",
        lineWidth: 1.1,
        fillOpacity: 0.9,
        shadowColor: color,
        shadowBlur: 18,
        shadowOpacity: 0.32,
        halo: true,
        haloStroke: color,
        haloLineWidth: Math.max(12, nodeRadius(node) * 1.85),
        haloStrokeOpacity: 0.18,
        label: labelVisible,
        labelText: labelVisible ? node.title : "",
        labelFill: "rgba(238, 243, 255, 0.76)",
        labelFontFamily: "JetBrains Mono",
        labelFontSize: labelVisible ? 11 : 10,
        labelPlacement: "right" as const,
        labelOffsetX: 12,
        labelOffsetY: 1,
      },
    };
  });

  if (detachedNode) {
    const detachedColor = colorForPageType(detachedNode.pageType);
    nodes.push({
      id: detachedNode.nodeKey,
      data: {
        pageId: detachedNode.id,
        pageType: detachedNode.pageType,
        title: detachedNode.title,
        status: detachedNode.status,
        nodeKey: detachedNode.nodeKey,
        degree: 0,
        detached: true,
      },
      style: {
        size: 18,
        fill: detachedColor,
        stroke: "#f8fbff",
        lineWidth: 1.6,
        fillOpacity: 0.96,
        shadowColor: detachedColor,
        shadowBlur: 24,
        shadowOpacity: 0.48,
        halo: true,
        haloStroke: detachedColor,
        haloLineWidth: 32,
        haloStrokeOpacity: 0.38,
        label: true,
        labelText: detachedNode.title,
        labelFill: "rgba(246, 250, 255, 0.92)",
        labelFontFamily: "JetBrains Mono",
        labelFontSize: 11,
        labelPlacement: "right" as const,
        labelOffsetX: 14,
        labelOffsetY: 2,
      },
    });
  }

  const edges = graph.edges.map((edge) => ({
    id: edgeId(edge),
    source: edge.source,
    target: edge.target,
    data: {
      edgeType: edge.edgeType,
    },
    style: {
      stroke: edgeStroke(edge.edgeType),
      strokeOpacity: 0.14,
      lineWidth: 0.8,
      lineDash: edgeDash(edge.edgeType),
      halo: false,
      haloStroke: edgeStroke(edge.edgeType),
      haloLineWidth: 8,
      haloStrokeOpacity: 0.06,
      endArrow: false,
    },
  }));

  return { nodes, edges };
}

function buildStateMap(options: {
  graph: DashboardGraphOverview;
  selectedNodeKey: string | null;
  hoveredNodeKey: string | null;
  detachedNodeKey: string | null;
}): Record<string, string[]> {
  const { graph, selectedNodeKey, hoveredNodeKey, detachedNodeKey } = options;
  const stateMap: Record<string, string[]> = {};

  if (selectedNodeKey) {
    const relatedNodes = new Set<string>([selectedNodeKey]);
    const relatedEdges = new Set<string>();
    for (const edge of graph.edges) {
      const id = edgeId(edge);
      if (edge.source === selectedNodeKey || edge.target === selectedNodeKey) {
        relatedNodes.add(edge.source);
        relatedNodes.add(edge.target);
        relatedEdges.add(id);
      }
      stateMap[id] = relatedEdges.has(id) ? ["highlight"] : ["inactive"];
    }

    for (const node of graph.nodes) {
      if (node.nodeKey === selectedNodeKey) {
        stateMap[node.nodeKey] = ["selected"];
      } else if (relatedNodes.has(node.nodeKey)) {
        stateMap[node.nodeKey] = ["highlight"];
      } else {
        stateMap[node.nodeKey] = ["inactive"];
      }
    }

    if (detachedNodeKey) {
      stateMap[detachedNodeKey] = detachedNodeKey === selectedNodeKey ? ["selected"] : ["inactive"];
    }

    return stateMap;
  }

  for (const edge of graph.edges) {
    stateMap[edgeId(edge)] = [];
  }

  for (const node of graph.nodes) {
    stateMap[node.nodeKey] = hoveredNodeKey && node.nodeKey === hoveredNodeKey ? ["hover"] : [];
  }

  if (detachedNodeKey) {
    stateMap[detachedNodeKey] = hoveredNodeKey && detachedNodeKey === hoveredNodeKey ? ["hover"] : [];
  }

  return stateMap;
}

async function focusSelectedNode(instance: Graph, nodeKey: string): Promise<void> {
  const currentZoom = instance.getZoom();
  if (currentZoom < 1.08) {
    await instance.zoomTo(1.12, { duration: 420, easing: "ease-in-out" }, instance.getCanvasCenter());
  }
  await instance.focusElement(nodeKey, { duration: 760, easing: "ease-in-out" });
}

export function GraphCanvas(props: GraphCanvasProps) {
  const [hostRef, size] = useViewportSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const onSelectPageRef = useRef(props.onSelectPage);
  const focusedNodeKeyRef = useRef<string | null>(null);
  const appliedSelectionFocusKeyRef = useRef(0);
  const selectedNodeKeyRef = useRef<string | null>(null);
  const hoveredNodeKeyRef = useRef<string | null>(null);
  const lastGraphSignatureRef = useRef<string | null>(null);
  const lastResetTokenRef = useRef<number>(props.resetViewToken);
  const [hoveredNodeKey, setHoveredNodeKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [focusAnchor, setFocusAnchor] = useState<FocusCardAnchor | null>(null);

  onSelectPageRef.current = props.onSelectPage;

  const detachedNode = useMemo(() => buildDetachedNode(props.focusedPage, props.graph), [props.focusedPage, props.graph]);
  const selectedNodeKey = useMemo(() => {
    if (!props.selectedPageId) {
      return null;
    }
    const graphNode = props.graph?.nodes.find((node) => node.id === props.selectedPageId);
    if (graphNode) {
      return graphNode.nodeKey;
    }
    if (detachedNode?.id === props.selectedPageId) {
      return detachedNode.nodeKey;
    }
    return null;
  }, [detachedNode, props.graph, props.selectedPageId]);

  selectedNodeKeyRef.current = selectedNodeKey;
  hoveredNodeKeyRef.current = hoveredNodeKey;

  const activeStageNode = useMemo(() => {
    const activeNodeKey = selectedNodeKey ?? hoveredNodeKey;
    if (!activeNodeKey) {
      return null;
    }
    if (detachedNode?.nodeKey === activeNodeKey) {
      return detachedNode;
    }
    return props.graph?.nodes.find((node) => node.nodeKey === activeNodeKey) ?? null;
  }, [detachedNode, hoveredNodeKey, props.graph, selectedNodeKey]);

  const legendTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of props.graph?.nodes ?? []) {
      counts.set(node.pageType, (counts.get(node.pageType) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
  }, [props.graph]);

  const focusedDetached = Boolean(detachedNode && props.selectedPageId === detachedNode.id);

  function syncViewportDetails() {
    const instance = graphRef.current;
    const activeNodeKey = selectedNodeKey ?? hoveredNodeKey;
    if (!instance) {
      return;
    }

    try {
      setZoom(instance.getZoom());
    } catch {
      return;
    }

    if (!activeNodeKey) {
      setFocusAnchor(null);
      return;
    }

    try {
      const data = instance.getNodeData(activeNodeKey) as {
        style?: {
          x?: number;
          y?: number;
        };
      };
      if (typeof data?.style?.x !== "number" || typeof data.style.y !== "number") {
        setFocusAnchor(null);
        return;
      }
      const [viewportX, viewportY] = instance.getViewportByCanvas([data.style.x, data.style.y]);
      setFocusAnchor({
        left: `${clamp((viewportX / size.width) * 100 - 4, 18, 72)}%`,
        top: `${clamp((viewportY / size.height) * 100 + 6, 20, 78)}%`,
      });
    } catch {
      setFocusAnchor(null);
    }
  }

  function fitOverview(animation: boolean) {
    const instance = graphRef.current;
    if (!instance) {
      return;
    }
    void instance.fitView({ when: "always" }, animation ? { duration: 660, easing: "ease-in-out" } : false).then(() => {
      syncViewportDetails();
    });
  }

  useEffect(() => {
    return () => {
      graphRef.current?.destroy();
      graphRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!props.graph || !canvasRef.current || !minimapRef.current || size.width < 40 || size.height < 40) {
      return;
    }

    const graphSignature = `${props.graph.nodes.map((node) => node.nodeKey).join("|")}::${props.graph.edges.length}::${Boolean(detachedNode)}`;
    const data = buildGraphData({
      graph: props.graph,
      detachedNode,
    });

    let cancelled = false;

    async function renderGraph() {
      let instance = graphRef.current;

      if (!instance) {
        instance = new Graph({
          container: canvasRef.current!,
          width: size.width,
          height: size.height,
          zoomRange: [0.48, 2.6],
          padding: GRAPH_PADDING,
          animation: true,
          data,
          layout: {
            type: "d3-force",
            link: {
              distance: 100,
              strength: 0.3,
            },
            manyBody: {
              strength: -120,
            },
            collide: {
              radius: 24,
              strength: 0.8,
            },
            center: {
              x: size.width / 2,
              y: size.height / 2,
              strength: 0.05,
            },
          },
          node: {
            type: "circle",
            state: {
              selected: {
                stroke: "#f8fbff",
                lineWidth: 2.2,
                fillOpacity: 1,
                shadowBlur: 28,
                halo: true,
                haloLineWidth: 38,
                haloStrokeOpacity: 0.62,
              },
              highlight: {
                stroke: "#dce8ff",
                lineWidth: 1.4,
                halo: true,
                haloLineWidth: 22,
                haloStrokeOpacity: 0.28,
              },
              hover: {
                stroke: "#ffffff",
                lineWidth: 1.6,
                halo: true,
                haloLineWidth: 24,
                haloStrokeOpacity: 0.36,
              },
              inactive: {
                fillOpacity: 0.08,
                strokeOpacity: 0.06,
                shadowBlur: 0,
                haloStrokeOpacity: 0,
                labelFill: "rgba(238, 243, 255, 0.12)",
              },
            },
          },
          edge: {
            type: "quadratic",
            state: {
              highlight: {
                strokeOpacity: 0.72,
                lineWidth: 1.4,
                halo: true,
                haloLineWidth: 12,
                haloStrokeOpacity: 0.14,
              },
              inactive: {
                strokeOpacity: 0.02,
                lineWidth: 0.4,
              },
            },
          },
          behaviors: [
            { type: "drag-canvas", key: "drag-canvas" },
            { type: "zoom-canvas", key: "zoom-canvas", sensitivity: 1.08 },
            { type: "drag-element-force", key: "drag-element-force" },
            { type: "focus-element", key: "focus-element", animation: { duration: 760, easing: "ease-in-out" } },
          ],
          plugins: [
            {
              key: "stage-minimap",
              type: "minimap",
              container: minimapRef.current!,
              size: [164, 96],
              padding: 10,
              maskStyle: {
                border: "1px solid rgba(124, 182, 255, 0.46)",
                background: "rgba(104, 168, 255, 0.08)",
              },
            },
          ],
        });

        instance.on(NodeEvent.CLICK, (event) => {
          const targetId = String((event as { target?: { id?: string } }).target?.id ?? "");
          if (!targetId) {
            return;
          }
          const data = instance?.getNodeData(targetId) as {
            data?: {
              pageId?: string;
            };
          };
          const pageId = data?.data?.pageId;
          if (pageId) {
            onSelectPageRef.current(pageId);
          }
        });

        instance.on(NodeEvent.POINTER_OVER, (event) => {
          const nextKey = String((event as { target?: { id?: string } }).target?.id ?? "");
          hoveredNodeKeyRef.current = nextKey;
          setHoveredNodeKey(nextKey);
        });
        instance.on(NodeEvent.POINTER_OUT, () => {
          hoveredNodeKeyRef.current = null;
          setHoveredNodeKey(null);
        });
        instance.on(GraphEvent.AFTER_TRANSFORM, () => {
          syncViewportDetails();
        });
        instance.on(GraphEvent.AFTER_RENDER, () => {
          syncViewportDetails();
        });

        graphRef.current = instance;
        await instance.render();
      } else {
        instance.resize(size.width, size.height);
        instance.setData(data);
        await instance.render();
      }

      if (cancelled) {
        return;
      }

      const nextStateMap = buildStateMap({
        graph: props.graph!,
        selectedNodeKey: selectedNodeKeyRef.current,
        hoveredNodeKey: hoveredNodeKeyRef.current,
        detachedNodeKey: detachedNode?.nodeKey ?? null,
      });
      await instance.setElementState(nextStateMap, false);

      if (selectedNodeKeyRef.current && focusedNodeKeyRef.current !== selectedNodeKeyRef.current) {
        focusedNodeKeyRef.current = selectedNodeKeyRef.current;
        await focusSelectedNode(instance, selectedNodeKeyRef.current);
      } else if (lastGraphSignatureRef.current !== graphSignature) {
        lastGraphSignatureRef.current = graphSignature;
        fitOverview(false);
      } else {
        syncViewportDetails();
      }
    }

    void renderGraph();

    return () => {
      cancelled = true;
    };
  }, [detachedNode, props.graph, size]);

  useEffect(() => {
    if (!props.graph || !graphRef.current?.rendered) {
      return;
    }
    const nextStateMap = buildStateMap({
      graph: props.graph!,
      selectedNodeKey,
      hoveredNodeKey,
      detachedNodeKey: detachedNode?.nodeKey ?? null,
    });
    void graphRef.current.setElementState(nextStateMap, false).then(() => {
      syncViewportDetails();
    });
  }, [detachedNode, hoveredNodeKey, props.graph, selectedNodeKey]);

  useEffect(() => {
    if (!selectedNodeKey || !graphRef.current?.rendered) {
      focusedNodeKeyRef.current = null;
      syncViewportDetails();
      return;
    }
    if (props.selectionFocusKey === 0 || appliedSelectionFocusKeyRef.current === props.selectionFocusKey) {
      syncViewportDetails();
      return;
    }
    appliedSelectionFocusKeyRef.current = props.selectionFocusKey;
    focusedNodeKeyRef.current = selectedNodeKey;
    void focusSelectedNode(graphRef.current, selectedNodeKey).then(() => {
      syncViewportDetails();
    });
  }, [props.selectionFocusKey, selectedNodeKey]);

  useEffect(() => {
    if (lastResetTokenRef.current === props.resetViewToken) {
      return;
    }
    lastResetTokenRef.current = props.resetViewToken;
    fitOverview(true);
  }, [props.resetViewToken]);

  if (!props.graph) {
    return (
      <section className="graph-canvas graph-stage" ref={hostRef}>
        <div className="graph-canvas__placeholder graph-stage__placeholder">
          <strong>Loading graph overview…</strong>
          <p>The daemon is assembling the current full-library overview.</p>
        </div>
      </section>
    );
  }

  const focusColor = activeStageNode ? colorForPageType(activeStageNode.pageType) : "var(--accent)";

  return (
    <section className="graph-canvas graph-stage" ref={hostRef}>
      <div className="graph-stage__canvas" ref={canvasRef} />

      <div className="graph-stage__toolbar">
        <div className="graph-stage__toolbar-row">
          <div className="graph-stage__tool-group">
            <button type="button" title="全景" onClick={() => fitOverview(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
            <button
              type="button"
              title="定位选中节点"
              disabled={!selectedNodeKey}
              onClick={() => {
                if (!selectedNodeKey || !graphRef.current) {
                  return;
                }
                void focusSelectedNode(graphRef.current, selectedNodeKey);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="6" />
                <line x1="12" y1="18" x2="12" y2="22" /><line x1="2" y1="12" x2="6" y2="12" />
                <line x1="18" y1="12" x2="22" y2="12" />
              </svg>
            </button>
            <button
              type="button"
              title="重置视图"
              onClick={() => {
                props.onDeselectPage();
                fitOverview(true);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          </div>
          <div className="graph-stage__tool-separator" />
          <div className="graph-stage__tool-group">
            <button
              type="button"
              title="缩小"
              onClick={() => {
                const instance = graphRef.current;
                if (!instance) return;
                void instance.zoomTo(instance.getZoom() * 0.8, { duration: 240, easing: "ease-in-out" });
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              type="button"
              className="graph-stage__zoom-label"
              title="重置为 100%"
              onClick={() => {
                const instance = graphRef.current;
                if (!instance) return;
                void instance.zoomTo(1, { duration: 320, easing: "ease-in-out" });
              }}
            >
              {zoomLabel(zoom)}
            </button>
            <button
              type="button"
              title="放大"
              onClick={() => {
                const instance = graphRef.current;
                if (!instance) return;
                void instance.zoomTo(instance.getZoom() * 1.25, { duration: 240, easing: "ease-in-out" });
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <span className="graph-stage__toolbar-stats shell-meta">
            {props.graph.truncated
              ? `${props.graph.visibleNodeCount}/${props.graph.totalNodes}`
              : `${props.graph.visibleNodeCount}`}
            {" nodes · "}
            {props.graph.visibleEdgeCount} edges
          </span>
        </div>
        {props.searchQuery.trim() ? (
          <div className="graph-stage__tool-search">
            <span>{props.searchQuery.trim()}</span>
            <code>{props.searchResultCount} hits</code>
          </div>
        ) : null}
        {focusedDetached && props.focusedPage ? (
          <p className="graph-stage__detached-hint shell-meta">
            {props.focusedPage.title} — detached focus node (outside visible slice)
          </p>
        ) : null}
      </div>

      <div className="graph-stage__legend">
        <span className="shell-eyebrow">Classification</span>
        <div>
          {legendTypes.map(([pageType, count]) => (
            <span key={pageType}>
              <i style={{ background: colorForPageType(pageType) }} />
              {pageType}
              <strong>{count}</strong>
            </span>
          ))}
        </div>
      </div>

      <div className="graph-stage__minimap">
        <span>live map</span>
        <div className="graph-stage__minimap-host" ref={minimapRef} />
      </div>

      {activeStageNode && focusAnchor ? (
        <div
          className="graph-stage__focus-card"
          style={{
            ...focusAnchor,
            ["--focus-accent" as "--focus-accent"]: focusColor,
          }}
        >
          <strong>{activeStageNode.title}</strong>
          <span>{activeStageNode.nodeKey}</span>
        </div>
      ) : null}

      {props.loading ? (
        <span className="graph-stage__loading-badge shell-meta">refreshing…</span>
      ) : null}
    </section>
  );
}

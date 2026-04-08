import type { DashboardGraphNode } from "../types/dashboard";

export interface NodePosition {
  x: number;
  y: number;
}

function hashToFloat(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return (Math.abs(hash) % 1000) / 1000;
}

export function computeConstellationLayout(nodes: DashboardGraphNode[]): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();
  if (nodes.length === 0) {
    return positions;
  }

  const grouped = new Map<string, DashboardGraphNode[]>();
  for (const node of nodes) {
    const key = String(node.pageType || "unknown");
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)?.push(node);
  }

  const groups = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  const clusterRadius = nodes.length > 30 ? 0.38 : 0.34;
  const angleOffset = hashToFloat(nodes[0]?.nodeKey ?? "seed") * Math.PI;

  groups.forEach(([groupKey, groupNodes], groupIndex) => {
    const angle = angleOffset + (Math.PI * 2 * groupIndex) / groups.length;
    const anchorX = 0.5 + Math.cos(angle) * clusterRadius;
    const anchorY = 0.5 + Math.sin(angle) * clusterRadius;

    groupNodes
      .slice()
      .sort((left, right) => right.degree - left.degree || left.title.localeCompare(right.title))
      .forEach((node, nodeIndex) => {
        const ring = Math.floor(Math.sqrt(nodeIndex));
        const inRingIndex = nodeIndex - ring * ring;
        const ringCount = Math.max(1, ring * 2 + 1);
        const ringAngle = (Math.PI * 2 * inRingIndex) / ringCount + hashToFloat(node.nodeKey) * 0.65;
        const ringBase = nodes.length > 30 ? 0.04 : 0.03;
        const ringStep = nodes.length > 30 ? 0.052 : 0.04;
        const ringDistance = ringBase + ring * ringStep + hashToFloat(groupKey + node.nodeKey) * 0.02;

        positions.set(node.nodeKey, {
          x: Math.max(0.06, Math.min(0.94, anchorX + Math.cos(ringAngle) * ringDistance)),
          y: Math.max(0.06, Math.min(0.94, anchorY + Math.sin(ringAngle) * ringDistance)),
        });
      });
  });

  return positions;
}

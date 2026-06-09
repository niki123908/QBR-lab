function buildGraphAdjacency(graph) {
  const nodes = graph?.nodes ?? [];
  const adjacency = new Map(nodes.map((n) => [n.node_id, new Set()]));
  const txRange = Number(graph.tx_range) || 0;
  const txRangeSq = txRange * txRange;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy <= txRangeSq) {
        adjacency.get(a.node_id)?.add(b.node_id);
        adjacency.get(b.node_id)?.add(a.node_id);
      }
    }
  }
  return { nodes, adjacency };
}

/** BFS hop distance from sink node 0 (matches topology lower-bound metric). */
export function computeHopDistanceFromSink(graph) {
  const { nodes, adjacency } = buildGraphAdjacency(graph);
  if (!nodes.length) return {};
  if (!adjacency.has(0)) return {};

  const dist = {};
  nodes.forEach((n) => {
    dist[n.node_id] = -1;
  });
  dist[0] = 0;
  const queue = [0];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    for (const nxt of adjacency.get(cur) ?? []) {
      if (dist[nxt] < 0) {
        dist[nxt] = dist[cur] + 1;
        queue.push(nxt);
      }
    }
  }
  return dist;
}

/**
 * Shortest-path edges from sink 0 to a farthest node (BFS tree, ties → smallest node id).
 * Matches backend lower_bound = max hop distance from 0.
 */
export function computeLowerBoundPathEdges(graph) {
  const { nodes, adjacency } = buildGraphAdjacency(graph);
  if (!nodes.length || !adjacency.has(0)) return [];

  const dist = {};
  const parent = { 0: null };
  nodes.forEach((n) => {
    dist[n.node_id] = -1;
  });
  dist[0] = 0;
  const queue = [0];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    for (const nxt of adjacency.get(cur) ?? []) {
      if (dist[nxt] < 0) {
        dist[nxt] = dist[cur] + 1;
        parent[nxt] = cur;
        queue.push(nxt);
      }
    }
  }

  if (Object.values(dist).some((d) => d < 0)) return [];

  const lb = Math.max(...Object.values(dist));
  if (!Number.isFinite(lb) || lb <= 0) return [];

  let target = null;
  nodes.forEach((n) => {
    if (dist[n.node_id] !== lb) return;
    if (target === null || n.node_id < target) target = n.node_id;
  });
  if (target === null) return [];

  const edges = [];
  let cur = target;
  while (cur != null && parent[cur] != null) {
    edges.push({ from: parent[cur], to: cur });
    cur = parent[cur];
  }
  return edges;
}

/** Node ids on the lower-bound BFS path (including sink and farthest). */
export function lowerBoundPathNodeIds(pathEdges) {
  const ids = new Set([0]);
  (pathEdges ?? []).forEach((edge) => {
    ids.add(edge.from);
    ids.add(edge.to);
  });
  return ids;
}

/**
 * Remaining hop slack vs receive time (playground timeline).
 * Covered nodes use their first receive timeslot; uncovered use the viewed slot.
 */
export function computeLatencyAheadByNode(hopDist, receiveTimeslotByNode, viewSlot) {
  const slot = Math.max(0, Number(viewSlot) || 0);
  const out = {};
  Object.entries(hopDist ?? {}).forEach(([key, hops]) => {
    const nodeId = Number(key);
    const h = Number(hops);
    if (!Number.isFinite(h) || h < 0) return;
    const rcv = receiveTimeslotByNode?.[nodeId];
    const t = Number.isFinite(rcv) ? rcv : slot;
    out[nodeId] = Math.max(0, h - t);
  });
  return out;
}

/** Same palette as playground timeslot coloring (one distinct color per hop 1…n). */
export const HOP_DISTANCE_COLORS = [
  "#4E79A7",
  "#F28E2B",
  "#E15759",
  "#76B7B2",
  "#59A14F",
  "#EDC948",
  "#B07AA1",
  "#FF9DA7",
  "#9C755F",
  "#BAB0AC",
  "#1F77B4",
  "#FF7F0E",
  "#2CA02C",
  "#D62728",
  "#9467BD",
  "#8C564B",
  "#E377C2",
  "#7F7F7F",
  "#BCBD22",
  "#17BECF",
  "#393B79",
  "#637939",
  "#8C6D31",
  "#843C39",
  "#7B4173"
];

/** Node fill by hop distance from sink (hop 1 → first palette color, …). */
export function colorForPlaygroundHopDistance(hop) {
  const h = Number(hop);
  if (!Number.isFinite(h) || h <= 0) return null;
  return HOP_DISTANCE_COLORS[(h - 1) % HOP_DISTANCE_COLORS.length];
}

export function resolvePlaygroundLowerBound(hopDist, topologyLowerBound) {
  const fromTopo = Number(topologyLowerBound);
  if (Number.isFinite(fromTopo) && fromTopo >= 0) return fromTopo;
  const hops = Object.values(hopDist ?? {}).filter((v) => Number.isFinite(v) && v >= 0);
  return hops.length ? Math.max(...hops) : 0;
}

/** Zoom so node layout fills the playground canvas (viewBox units). */
export function computeTopologyFitScale(graph) {
  const nodes = graph?.nodes ?? [];
  const spaceW = Number(graph?.space_width) || 100;
  const spaceH = Number(graph?.space_height) || 100;
  if (!nodes.length) return 1.8;

  const pad = 3;
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const spanX = Math.max(12, Math.max(...xs) - Math.min(...xs) + pad * 2);
  const spanY = Math.max(12, Math.max(...ys) - Math.min(...ys) + pad * 2);
  const fit = Math.min(spaceW / spanX, spaceH / spanY) * 0.92;
  return Math.min(5.5, Math.max(1.85, fit * 1.12));
}

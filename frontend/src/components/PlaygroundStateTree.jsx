import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { downloadDecisionTreeJpg } from "../export/decisionTreeExport";
import { buildCsv, downloadCsv, safeFilename } from "../export/csvUtils.js";

/** Shown when API is unavailable; matches backend empty_tree_payload(). */
export const EMPTY_PLAYGROUND_TREE = {
  root_state_hash: "0",
  next_state_index: 1,
  nodes: [
    {
      state_hash: "0",
      state_index: 0,
      depth: 0,
      covered_node_ids: [0]
    }
  ],
  edges: []
};

export const DEFAULT_DECISION_TREE_COL_SPREAD = 1;
export const DEFAULT_DECISION_TREE_ROW_SPREAD = 1;
export const DEFAULT_DECISION_TREE_NODE_SCALE = 1;
export const DEFAULT_DECISION_TREE_FONT_SCALE = 1;
export const DEFAULT_DECISION_TREE_EDGE_SCALE = 1;
export const DEFAULT_DECISION_TREE_EDGE_OPACITY = 1;

const EDGE_COLOR = "#5b7aa8";
const EDGE_HIGHLIGHT_COLOR = "#F5A962";
const MERGED_TRANSITION_COLOR = "#c0392b";

const BASE_NODE_RADIUS = 14;
const BASE_ROW_HEIGHT = 52;
const BASE_FONT_SIZE = 11;
const FALLBACK_CONTAINER_WIDTH = 920;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stateId(node) {
  const idx = Number(node?.state_index);
  return Number.isFinite(idx) ? String(idx) : "?";
}

function maxNodesPerRow(nodes) {
  const byDepth = new Map();
  (nodes ?? []).forEach((node) => {
    const depth = Number(node.depth) || 0;
    byDepth.set(depth, (byDepth.get(depth) ?? 0) + 1);
  });
  return Math.max(1, ...byDepth.values(), 1);
}

/** Per-timeslot (depth row) counts: unique states and outgoing action labels. */
export function buildDecisionTreeTimeslotStats(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const edges = Array.isArray(tree?.edges) ? tree.edges : [];
  const nodesByHash = Object.fromEntries(nodes.map((node) => [String(node.state_hash), node]));

  const stateCountByDepth = new Map();
  nodes.forEach((node) => {
    const depth = Number(node.depth) || 0;
    stateCountByDepth.set(depth, (stateCountByDepth.get(depth) ?? 0) + 1);
  });

  const actionCountByDepth = new Map();
  edges.forEach((edge) => {
    const fromNode = nodesByHash[String(edge.from_state_hash)];
    if (!fromNode) return;
    const depth = Number(fromNode.depth) || 0;
    const actionCount = Array.isArray(edge.actions) ? edge.actions.length : 0;
    if (actionCount <= 0) return;
    actionCountByDepth.set(depth, (actionCountByDepth.get(depth) ?? 0) + actionCount);
  });

  const depths = [...new Set([...stateCountByDepth.keys(), ...actionCountByDepth.keys()])].sort(
    (a, b) => a - b
  );

  return depths.map((depth) => ({
    depth,
    timeslotLabel: `t${depth}`,
    stateCount: stateCountByDepth.get(depth) ?? 0,
    outgoingActionCount: actionCountByDepth.get(depth) ?? 0
  }));
}

function buildTimeslotSummaryCsv(stats, totals) {
  const rows = stats.map((row) => ({
    timeslot: row.timeslotLabel,
    states: row.stateCount,
    outgoing_actions: row.outgoingActionCount
  }));
  rows.push({
    timeslot: "Total",
    states: totals.stateCount,
    outgoing_actions: totals.outgoingActionCount
  });
  return buildCsv(
    [
      { key: "timeslot", label: "Timeslot" },
      { key: "states", label: "States" },
      { key: "outgoing_actions", label: "Outgoing actions" }
    ],
    rows
  );
}

/** Layout in container pixel width; horizontal spread always fills containerWidth. */
export function buildTreeLayoutMetrics({
  containerWidth = FALLBACK_CONTAINER_WIDTH,
  rowSpread = 1,
  nodeScale = 1,
  fontScale = 1,
  edgeScale = 1,
  maxRow = 1
}) {
  const nodeMul = clamp(Number(nodeScale) || 1, 0.4, 3);
  const fontMul = clamp(Number(fontScale) || 1, 0.5, 3);
  const edgeMul = clamp(Number(edgeScale) || 1, 0.4, 3);
  const rowMul = clamp(Number(rowSpread) || 1, 0.4, 2.5);
  const nodeRadius = BASE_NODE_RADIUS * nodeMul;
  const rowHeight = BASE_ROW_HEIGHT * rowMul * nodeMul;
  const fontSize = BASE_FONT_SIZE * fontMul;
  const edgeStroke = Math.max(0.5, 1.1 * edgeMul);
  const nodeStroke = Math.max(1, 1.4 * nodeMul);
  const padLeft = 40;
  const padX = 12;
  const padY = 16;
  const width = Math.max(280, Number(containerWidth) || FALLBACK_CONTAINER_WIDTH);
  const innerWidth = Math.max(0, width - padLeft - padX * 2 - nodeRadius * 2);
  const colSpacing = maxRow > 1 ? Math.max(8, innerWidth / (maxRow - 1)) : innerWidth;

  return {
    nodeRadius,
    rowHeight,
    colSpacing,
    padLeft,
    padX,
    padY,
    fontSize,
    edgeStroke,
    nodeStroke,
    width
  };
}

function curvedEdgePath(x1, y1, x2, y2) {
  const dy = y2 - y1;
  const bendX = (x2 - x1) * 0.58;
  return `M ${x1} ${y1} C ${x1 + bendX} ${y1 + dy * 0.22}, ${x2 - bendX} ${y2 - dy * 0.22}, ${x2} ${y2}`;
}

function edgeLabelPosition(x1, y1, x2, y2, fontSize) {
  const midY = (y1 + y2) / 2;
  return { x: (x1 + x2) / 2, y: midY - fontSize * 0.35 };
}

function rowCenterY(depth, metrics) {
  return metrics.padY + depth * metrics.rowHeight + metrics.rowHeight / 2;
}

function layoutTree(tree, metrics) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const edges = Array.isArray(tree?.edges) ? tree.edges : [];
  const { nodeRadius, rowHeight, colSpacing, padLeft, padX, padY, width } = metrics;

  if (!nodes.length) {
    return {
      width,
      height: padY * 2 + rowHeight,
      nodes: [],
      edges: [],
      depthLabels: []
    };
  }

  const byDepth = new Map();
  nodes.forEach((node) => {
    const depth = Number(node.depth) || 0;
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth).push(node);
  });

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const height = padY * 2 + depths.length * rowHeight;

  const positioned = [];
  depths.forEach((depth) => {
    const row = [...byDepth.get(depth)].sort((a, b) => Number(a.state_index) - Number(b.state_index));
    const count = row.length;
    const y = rowCenterY(depth, metrics);
    const innerLeft = padLeft + padX + nodeRadius;
    const innerRight = width - padX - nodeRadius;
    row.forEach((node, idx) => {
      const x = count === 1 ? (padLeft + width) / 2 : innerLeft + ((innerRight - innerLeft) * idx) / Math.max(1, count - 1);
      positioned.push({ ...node, x, y });
    });
  });

  const posByHash = Object.fromEntries(positioned.map((node) => [node.state_hash, node]));
  const edgeLayouts = edges
    .map((edge) => {
      const from = posByHash[edge.from_state_hash];
      const to = posByHash[edge.to_state_hash];
      if (!from || !to) return null;
      const x1 = from.x;
      const y1 = from.y + nodeRadius;
      const x2 = to.x;
      const y2 = to.y - nodeRadius;
      const actionsList = Array.isArray(edge.actions) ? edge.actions : [];
      const actions = actionsList.map(String).join(", ");
      const isMergedTransition = actionsList.length > 1;
      const labelPos = edgeLabelPosition(x1, y1, x2, y2, metrics.fontSize);
      const mode = edge.mode ?? "broadcaster";
      return {
        key: `${edge.from_state_hash}->${edge.to_state_hash}:${mode}`,
        fromHash: edge.from_state_hash,
        toHash: edge.to_state_hash,
        path: curvedEdgePath(x1, y1, x2, y2),
        label: actions,
        labelX: labelPos.x,
        labelY: labelPos.y,
        isMergedTransition
      };
    })
    .filter(Boolean);

  const depthLabels = depths.map((depth) => ({
    depth,
    label: `t${depth}`,
    y: rowCenterY(depth, metrics)
  }));

  return { width, height, nodes: positioned, edges: edgeLayouts, depthLabels };
}

export default forwardRef(function PlaygroundStateTree(
  {
    tree,
    isLoading,
    loadError,
    rowSpread = DEFAULT_DECISION_TREE_ROW_SPREAD,
    nodeScale = DEFAULT_DECISION_TREE_NODE_SCALE,
    fontScale = DEFAULT_DECISION_TREE_FONT_SCALE,
    edgeScale = DEFAULT_DECISION_TREE_EDGE_SCALE,
    edgeOpacity = DEFAULT_DECISION_TREE_EDGE_OPACITY,
    highlightMergedTransitions = false,
    timeslotExportBasename = "timeslot_summary"
  },
  ref
) {
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState(null);
  const [hoveredNodeHash, setHoveredNodeHash] = useState(null);
  const [containerWidth, setContainerWidth] = useState(FALLBACK_CONTAINER_WIDTH);
  const containerRef = useRef(null);
  const svgRef = useRef(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect?.width;
      if (nextWidth && nextWidth > 0) {
        setContainerWidth(nextWidth);
      }
    });
    observer.observe(element);
    setContainerWidth(element.clientWidth || FALLBACK_CONTAINER_WIDTH);
    return () => observer.disconnect();
  }, []);

  const displayTree = tree ?? EMPTY_PLAYGROUND_TREE;
  const maxRow = useMemo(() => maxNodesPerRow(displayTree.nodes), [displayTree.nodes]);
  const opacity = clamp(Number(edgeOpacity) || 1, 0.15, 1);

  const metrics = useMemo(
    () =>
      buildTreeLayoutMetrics({
        containerWidth,
        rowSpread,
        nodeScale,
        fontScale,
        edgeScale,
        maxRow
      }),
    [containerWidth, rowSpread, nodeScale, fontScale, edgeScale, maxRow]
  );

  const layout = useMemo(() => layoutTree(displayTree, metrics), [displayTree, metrics]);

  useImperativeHandle(
    ref,
    () => ({
      exportJpg(filename = "decision-tree.jpg") {
        const svgElement = svgRef.current;
        const containerEl = containerRef.current;
        if (!svgElement || !containerEl) return Promise.resolve(false);
        const widthPx = Math.max(1, Math.floor(containerEl.clientWidth || layout.width));
        const heightPx = Math.max(1, Math.floor(layout.height));
        return downloadDecisionTreeJpg({
          svgElement,
          widthPx,
          heightPx,
          metrics,
          filename
        });
      }
    }),
    [layout.width, layout.height, metrics]
  );

  const incomingEdgeKeys = useMemo(() => {
    if (!hoveredNodeHash) return new Set();
    return new Set(layout.edges.filter((edge) => edge.toHash === hoveredNodeHash).map((edge) => edge.key));
  }, [hoveredNodeHash, layout.edges]);

  const mergedEdgeCount = useMemo(
    () => layout.edges.filter((edge) => edge.isMergedTransition).length,
    [layout.edges]
  );

  const timeslotStats = useMemo(() => buildDecisionTreeTimeslotStats(displayTree), [displayTree]);

  const timeslotTotals = useMemo(
    () =>
      timeslotStats.reduce(
        (acc, row) => ({
          stateCount: acc.stateCount + row.stateCount,
          outgoingActionCount: acc.outgoingActionCount + row.outgoingActionCount
        }),
        { stateCount: 0, outgoingActionCount: 0 }
      ),
    [timeslotStats]
  );

  const handleExportTimeslotCsv = useCallback(() => {
    if (!timeslotStats.length) return;
    const csv = buildTimeslotSummaryCsv(timeslotStats, timeslotTotals);
    downloadCsv(csv, `${safeFilename(timeslotExportBasename, "timeslot_summary")}.csv`);
  }, [timeslotStats, timeslotTotals, timeslotExportBasename]);

  if (isLoading) {
    return <p className="muted playground-tree-hint">Loading decision tree…</p>;
  }

  const markerSize = Math.max(4, metrics.nodeRadius * 0.4);
  const hitStroke = Math.max(metrics.nodeRadius * 2.2, 10);
  const visibleNodes = layout.nodes;
  const hasEdges = layout.edges.length > 0;
  const labelStrokeWidth = Math.max(1.5, metrics.fontSize * 0.2);

  return (
    <div className="playground-state-tree">
      {loadError ? <p className="playground-tree-error">{loadError}</p> : null}

      <div
        ref={containerRef}
        className="dt-viewport"
        onMouseLeave={() => {
          setHoveredEdgeKey(null);
          setHoveredNodeHash(null);
        }}
      >
        <svg
          ref={svgRef}
          className="dt-svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height: layout.height }}
          role="img"
          aria-label="Decision tree"
        >
          <rect x="0" y="0" width={layout.width} height={layout.height} fill="#fbfbff" />
          <defs>
            <marker
              id="playground-tree-arrow"
              markerWidth={markerSize}
              markerHeight={markerSize}
              refX={markerSize * 0.85}
              refY={markerSize / 2}
              orient="auto"
            >
              <path d={`M0,0 L${markerSize},${markerSize / 2} L0,${markerSize} Z`} fill={EDGE_COLOR} />
            </marker>
            <marker
              id="playground-tree-arrow-highlight"
              markerWidth={markerSize}
              markerHeight={markerSize}
              refX={markerSize * 0.85}
              refY={markerSize / 2}
              orient="auto"
            >
              <path d={`M0,0 L${markerSize},${markerSize / 2} L0,${markerSize} Z`} fill={EDGE_HIGHLIGHT_COLOR} />
            </marker>
            <marker
              id="playground-tree-arrow-merged"
              markerWidth={markerSize}
              markerHeight={markerSize}
              refX={markerSize * 0.85}
              refY={markerSize / 2}
              orient="auto"
            >
              <path d={`M0,0 L${markerSize},${markerSize / 2} L0,${markerSize} Z`} fill={MERGED_TRANSITION_COLOR} />
            </marker>
          </defs>

          {layout.depthLabels.map((band) => (
            <g key={`depth-band-${band.depth}`}>
              <text
                x={metrics.padLeft * 0.22}
                y={band.y}
                className="dt-depth-label"
                fontSize={metrics.fontSize}
                dominantBaseline="central"
              >
                {band.label}
              </text>
              <line
                x1={metrics.padLeft}
                x2={layout.width}
                y1={band.y}
                y2={band.y}
                stroke="#eef0f8"
                strokeWidth={metrics.edgeStroke}
                strokeOpacity={opacity}
              />
            </g>
          ))}

          {layout.edges.map((edge) => {
            const isEdgeHovered = hoveredEdgeKey === edge.key;
            const isIncomingToNode = incomingEdgeKeys.has(edge.key);
            const showMerged = highlightMergedTransitions && edge.isMergedTransition;
            const isHighlighted = isEdgeHovered || isIncomingToNode;
            const strokeColor = showMerged
              ? MERGED_TRANSITION_COLOR
              : isHighlighted
                ? EDGE_HIGHLIGHT_COLOR
                : EDGE_COLOR;
            const strokeWidth = showMerged
              ? metrics.edgeStroke * 2.4
              : isEdgeHovered
                ? metrics.edgeStroke * 2.2
                : metrics.edgeStroke;
            const markerEnd = showMerged
              ? "url(#playground-tree-arrow-merged)"
              : isHighlighted
                ? "url(#playground-tree-arrow-highlight)"
                : "url(#playground-tree-arrow)";

            return (
              <g key={edge.key}>
                <path
                  d={edge.path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={hitStroke}
                  pointerEvents="stroke"
                  onMouseEnter={() => setHoveredEdgeKey(edge.key)}
                  onMouseLeave={() => setHoveredEdgeKey(null)}
                />
                <path
                  d={edge.path}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={strokeWidth}
                  strokeOpacity={opacity}
                  pointerEvents="none"
                  markerEnd={markerEnd}
                />
                {edge.label ? (
                  <text
                    x={edge.labelX}
                    y={edge.labelY}
                    textAnchor="middle"
                    className={
                      showMerged
                        ? "dt-edge-label dt-edge-label--merged"
                        : isHighlighted
                          ? "dt-edge-label dt-edge-label--on"
                          : "dt-edge-label"
                    }
                    fontSize={metrics.fontSize}
                    strokeWidth={labelStrokeWidth}
                    pointerEvents="none"
                  >
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}

          {visibleNodes.map((node) => {
            const isNodeHovered = hoveredNodeHash === node.state_hash;
            const radius = isNodeHovered ? metrics.nodeRadius * 1.15 : metrics.nodeRadius;

            return (
              <g
                key={node.state_hash}
                onMouseEnter={() => setHoveredNodeHash(node.state_hash)}
                onMouseLeave={() => setHoveredNodeHash(null)}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius}
                  fill="#F28E2B"
                  stroke="#fff"
                  strokeWidth={metrics.nodeStroke}
                  className="dt-node"
                />
                <text
                  x={node.x}
                  y={node.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="dt-node-label"
                  fontSize={metrics.fontSize}
                  pointerEvents="none"
                >
                  {stateId(node)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {!hasEdges && visibleNodes.length === 1 ? (
        <p className="muted playground-tree-hint">Commit actions in the graph to grow the decision tree.</p>
      ) : null}
      {highlightMergedTransitions && mergedEdgeCount > 0 ? (
        <p className="muted playground-tree-hint">
          {mergedEdgeCount.toLocaleString()} edge{mergedEdgeCount === 1 ? "" : "s"} with multiple actions (same state →
          same next state).
        </p>
      ) : null}
      {timeslotStats.length > 0 ? (
        <div className="playground-tree-timeslot-table-wrap">
          <div className="playground-tree-timeslot-table-head">
            <h6 className="playground-tree-timeslot-table-title">Timeslot summary</h6>
            <button
              type="button"
              className="secondary-cta small"
              onClick={handleExportTimeslotCsv}
              title="Download timeslot summary as CSV."
            >
              Export CSV
            </button>
          </div>
          <table className="playground-tree-timeslot-table">
            <thead>
              <tr>
                <th>Timeslot</th>
                <th>States</th>
                <th>Outgoing actions</th>
              </tr>
            </thead>
            <tbody>
              {timeslotStats.map((row) => (
                <tr key={`timeslot-${row.depth}`}>
                  <td>{row.timeslotLabel}</td>
                  <td>{row.stateCount.toLocaleString()}</td>
                  <td>{row.outgoingActionCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="playground-tree-timeslot-table-total">
                <td>Total</td>
                <td>
                  <span className="playground-tree-timeslot-foot-label">Total state in Q</span>
                  <span className="playground-tree-timeslot-foot-value">{timeslotTotals.stateCount.toLocaleString()}</span>
                </td>
                <td>
                  <span className="playground-tree-timeslot-foot-label">Total action in Q</span>
                  <span className="playground-tree-timeslot-foot-value">
                    {timeslotTotals.outgoingActionCount.toLocaleString()}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </div>
  );
});

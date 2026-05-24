import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BatchGridSection,
  FocusedTopologySection,
  TopologyGridSection
} from "./topology-workspace/TopologyWorkspaceSections";
import BatchResultDetailBody, { linearAxisTicks } from "./BatchResultDetailBody";
import CompareWorkspace from "./CompareWorkspace";

function buildEdges(nodes, txRange) {
  if (!nodes || nodes.length === 0) return [];
  const thresholdSq = txRange * txRange;
  const edges = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      if (dx * dx + dy * dy <= thresholdSq) {
        edges.push([nodes[i], nodes[j]]);
      }
    }
  }
  return edges;
}

function buildAdjacencyFromGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return new Map();
  const adjacency = new Map(graph.nodes.map((node) => [node.node_id, new Set()]));
  buildEdges(graph.nodes, graph.tx_range).forEach(([a, b]) => {
    adjacency.get(a.node_id)?.add(b.node_id);
    adjacency.get(b.node_id)?.add(a.node_id);
  });
  return adjacency;
}

function downsampleNodes(nodes, maxNodes) {
  if (!maxNodes || nodes.length <= maxNodes) return nodes;
  const sink = nodes.find((node) => node.node_id === 0);
  const others = nodes.filter((node) => node.node_id !== 0);
  const keep = Math.max(1, maxNodes - (sink ? 1 : 0));
  const step = Math.max(1, Math.ceil(others.length / keep));
  const sampled = [];
  for (let idx = 0; idx < others.length && sampled.length < keep; idx += step) {
    sampled.push(others[idx]);
  }
  return sink ? [sink, ...sampled] : sampled;
}

const TIMESLOT_COLORS = [
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

function colorForTimeslot(timeslot) {
  if (!Number.isFinite(timeslot) || timeslot <= 0) return "#9da5bf";
  return TIMESLOT_COLORS[(timeslot - 1) % TIMESLOT_COLORS.length];
}

function computeReceiveTimeslotMap(timeslots = []) {
  const byNode = {};
  timeslots.forEach((slot) => {
    const ts = Number(slot.timeslot) || 0;
    (slot.receivers ?? []).forEach((nodeId) => {
      if (!Number.isFinite(byNode[nodeId])) {
        byNode[nodeId] = ts;
      }
    });
  });
  byNode[0] = 0;
  return byNode;
}

function buildTransmissionEdgePairs(graph, timeslots = [], mode = "all", replaySlot = 0) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return [];
  if (!Array.isArray(timeslots) || timeslots.length === 0) return [];
  const nodeById = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const txRange = Number(graph.tx_range) || 0;
  const txRangeSq = txRange * txRange;
  const pairs = new Map();
  const received = new Set([0]);
  const useSlots =
    mode === "slot"
      ? timeslots.filter((slot) => Number(slot.timeslot) === Number(replaySlot))
      : mode === "upto"
        ? timeslots.filter((slot) => Number(slot.timeslot) <= Number(replaySlot))
        : timeslots;

  useSlots.forEach((slot) => {
    const transmitters = slot.transmitters ?? [];
    const receivers = slot.receivers ?? [];
    receivers.forEach((rxId) => {
      if (mode === "all" && received.has(rxId)) return;
      const rxNode = nodeById.get(rxId);
      if (!rxNode) return;

      let bestParent = null;
      let bestDistanceSq = Number.POSITIVE_INFINITY;
      transmitters.forEach((txId) => {
        const txNode = nodeById.get(txId);
        if (!txNode || txId === rxId) return;
        const dx = txNode.x - rxNode.x;
        const dy = txNode.y - rxNode.y;
        const dSq = dx * dx + dy * dy;
        if (dSq <= txRangeSq && dSq < bestDistanceSq) {
          bestDistanceSq = dSq;
          bestParent = txId;
        }
      });

      if (bestParent !== null) {
        pairs.set(`${bestParent}-${rxId}`, { from: bestParent, to: rxId });
        received.add(rxId);
      }
    });
  });
  return Array.from(pairs.values());
}

function buildTransmissionDiagnosticEdges(graph, timeslots = [], mode = "all", replaySlot = 0) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return [];
  if (!Array.isArray(timeslots) || timeslots.length === 0) return [];
  const nodeById = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const txRange = Number(graph.tx_range) || 0;
  const txRangeSq = txRange * txRange;
  const edgeMap = new Map();
  const useSlots =
    mode === "slot"
      ? timeslots.filter((slot) => Number(slot.timeslot) === Number(replaySlot))
      : mode === "upto"
        ? timeslots.filter((slot) => Number(slot.timeslot) <= Number(replaySlot))
        : timeslots;

  useSlots.forEach((slot) => {
    const transmitters = slot.transmitters ?? [];
    const receivers = slot.receivers ?? [];
    receivers.forEach((rxId) => {
      const rxNode = nodeById.get(rxId);
      if (!rxNode) return;
      const eligible = transmitters.filter((txId) => {
        const txNode = nodeById.get(txId);
        if (!txNode || txId === rxId) return false;
        const dx = txNode.x - rxNode.x;
        const dy = txNode.y - rxNode.y;
        return dx * dx + dy * dy <= txRangeSq;
      });
      const isCollision = eligible.length > 1;
      eligible.forEach((txId) => {
        const key = `${txId}-${rxId}`;
        const prev = edgeMap.get(key);
        const next = {
          from: txId,
          to: rxId,
          directed: true,
          collision: isCollision,
          color: isCollision ? "#d62728" : "#2b2f3a"
        };
        if (!prev || (prev && !prev.collision && isCollision)) {
          edgeMap.set(key, next);
        }
      });
    });
  });
  return Array.from(edgeMap.values());
}

function buildReplayLayeredEdges(graph, timeslots = [], replaySlot = 0, options = {}) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return [];
  const slot = Number(replaySlot) || 0;
  const totalSlots = Array.isArray(timeslots) ? timeslots.length : 0;
  const hideBaseEdgesAtEnd = options.hideBaseEdgesAtEnd ?? true;
  if (slot <= 0) {
    return buildEdges(graph.nodes, graph.tx_range).map(([a, b]) => ({
      from: a.node_id,
      to: b.node_id,
      directed: false,
      color: "#d0d5ea"
    }));
  }

  const transmittedNodes = new Set();
  (timeslots ?? []).forEach((item) => {
    if ((Number(item.timeslot) || 0) <= slot) {
      (item.transmitters ?? []).forEach((nodeId) => transmittedNodes.add(nodeId));
    }
  });

  const baseEdges =
    hideBaseEdgesAtEnd && slot >= totalSlots
      ? []
      : buildEdges(graph.nodes, graph.tx_range)
          .filter(([a, b]) => !transmittedNodes.has(a.node_id) && !transmittedNodes.has(b.node_id))
          .map(([a, b]) => ({
            from: a.node_id,
            to: b.node_id,
            directed: false,
            color: "#d0d5ea"
          }));

  const directedEdges = buildTransmissionDiagnosticEdges(graph, timeslots, "upto", slot);

  return [...baseEdges, ...directedEdges];
}

function coveredNodesUpToSlot(timeslots = [], slot = 0) {
  const covered = new Set([0]);
  for (let idx = 0; idx < Math.max(0, Number(slot) || 0); idx += 1) {
    (timeslots[idx]?.receivers ?? []).forEach((nodeId) => covered.add(nodeId));
  }
  return covered;
}

function flattenQTableRows(qTablePayload, limit = 300) {
  if (!qTablePayload || typeof qTablePayload !== "object") return [];
  const rows = [];
  Object.entries(qTablePayload).forEach(([stateHash, actions]) => {
    if (!actions || typeof actions !== "object") return;
    Object.entries(actions).forEach(([action, qValue]) => {
      rows.push({
        state_hash: stateHash,
        action: Number(action),
        q_value: Number(qValue)
      });
    });
  });
  return rows.slice(0, limit);
}

function computeTemperatureProbabilities(qValues = [], tau = 1) {
  const epsilon = 1e-6;
  const values = (qValues ?? []).map((value) => Number(value) || 0);
  if (!values.length) return [];
  if (!Number.isFinite(Number(tau)) || Number(tau) <= epsilon) {
    const maxQ = Math.max(...values);
    const winnerIndexes = values.map((value, index) => ({ value, index })).filter((item) => item.value === maxQ);
    const winnerProbability = winnerIndexes.length > 0 ? 1 / winnerIndexes.length : 0;
    return values.map((value, index) => ({
      action: `A${index + 1}`,
      qValue: value,
      logit: value / epsilon,
      probability: winnerIndexes.some((item) => item.index === index) ? winnerProbability : 0
    }));
  }
  const safeTau = Number(tau);
  const logits = values.map((value) => value / safeTau);
  const maxLogit = Math.max(...logits);
  const expValues = logits.map((logit) => Math.exp(logit - maxLogit));
  const expSum = expValues.reduce((sum, value) => sum + value, 0);
  return values.map((value, index) => ({
    action: `A${index + 1}`,
    qValue: value,
    logit: logits[index],
    probability: expSum > 0 ? expValues[index] / expSum : 0
  }));
}

function TemperatureProbabilityBarChart({ rows = [] }) {
  if (!rows.length) {
    return <p className="muted">No action probabilities.</p>;
  }
  const maxProbability = Math.max(...rows.map((row) => Number(row.probability) || 0), 1e-6);
  return (
    <div className="temperature-chart">
      <div className="temperature-chart-bars">
        {rows.map((row) => {
          const probability = Number(row.probability) || 0;
          const height = `${Math.max(probability * 100, probability > 0 ? 2 : 0)}%`;
          const isTop = probability === maxProbability;
          return (
            <div key={row.action} className="temperature-bar-item">
              <span className="temperature-bar-value">{(probability * 100).toFixed(1)}%</span>
              <div className="temperature-bar-track">
                <div className={`temperature-bar-fill ${isTop ? "top" : ""}`} style={{ height }} />
              </div>
              <span className="temperature-bar-label">{row.action}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TemperatureToolWorkspace({
  tool,
  rows,
  onReset,
  onActionCountChange,
  onTauRangeChange,
  onQRangeChange,
  onTauChange,
  onQValueChange
}) {
  const totalProbability = rows.reduce((sum, row) => sum + (Number(row.probability) || 0), 0);
  const totalQValue = rows.reduce((sum, row) => sum + (Number(row.qValue) || 0), 0);
  const totalLogit = rows.reduce(
    (sum, row) => sum + (Number.isFinite(Number(row.logit)) ? Number(row.logit) : 0),
    0
  );
  return (
    <div
      className="temperature-tool-shell"
      style={{ "--temperature-font-scale": String(Number(tool?.fontScale) || 1) }}
    >
      <section className="temperature-tool-controls">
        <div className="edit-panel-header">
          <h3>Temperature Tool</h3>
          <button type="button" className="secondary-cta" onClick={onReset}>
            Reset
          </button>
        </div>
        <div className="temperature-grid">
          <label className="field-label">
            Action count
            <input
              type="number"
              min="1"
              max="10"
              value={tool.actionCount}
              onChange={(e) => onActionCountChange(Number(e.target.value))}
            />
          </label>
          <label className="field-label">
            Tau min
            <input
              type="number"
              step="0.001"
              value={tool.tauMin}
              onChange={(e) => onTauRangeChange(Number(e.target.value), tool.tauMax)}
            />
          </label>
          <label className="field-label">
            Tau max
            <input
              type="number"
              step="0.001"
              value={tool.tauMax}
              onChange={(e) => onTauRangeChange(tool.tauMin, Number(e.target.value))}
            />
          </label>
          <label className="field-label">
            Q min
            <input
              type="number"
              step="0.1"
              value={tool.qMin}
              onChange={(e) => onQRangeChange(Number(e.target.value), tool.qMax)}
            />
          </label>
          <label className="field-label">
            Q max
            <input
              type="number"
              step="0.1"
              value={tool.qMax}
              onChange={(e) => onQRangeChange(tool.qMin, Number(e.target.value))}
            />
          </label>
        </div>
        <label className="field-label temperature-slider-field">
          Tau
          <input
            type="range"
            min={tool.tauMin}
            max={tool.tauMax}
            step="0.001"
            value={tool.tau}
            onChange={(e) => onTauChange(Number(e.target.value))}
          />
          <small className="muted">{tool.tau.toFixed(3)}</small>
        </label>
        <div className="temperature-action-slider-list">
          {tool.qValues.map((value, index) => (
            <label key={`temperature-action-${index}`} className="field-label temperature-slider-field">
              {`A${index + 1} Q value`}
              <input
                type="range"
                min={tool.qMin}
                max={tool.qMax}
                step="0.1"
                value={value}
                onChange={(e) => onQValueChange(index, Number(e.target.value))}
              />
              <small className="muted">{Number(value).toFixed(2)}</small>
            </label>
          ))}
        </div>
      </section>
      <section className="temperature-tool-results">
        <div className="temperature-results-header">
          <h3>Selection Probability</h3>
          <span className="muted">Total {(totalProbability * 100).toFixed(2)}%</span>
        </div>
        <TemperatureProbabilityBarChart rows={rows} />
        <div className="table-scroll">
          <table className="node-edit-table temperature-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Q value</th>
                <th>Logit</th>
                <th>Probability</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`temperature-row-${row.action}`}>
                  <td>{row.action}</td>
                  <td>{row.qValue.toFixed(2)}</td>
                  <td>{Number.isFinite(row.logit) ? row.logit.toFixed(4) : "-"}</td>
                  <td>{(row.probability * 100).toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="temperature-table-total-row">
                <td>Total</td>
                <td>{totalQValue.toFixed(2)}</td>
                <td>{totalLogit.toFixed(4)}</td>
                <td>{(totalProbability * 100).toFixed(2)}%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}

function ActionSpaceMeanBarChart({ summary, yMax }) {
  const rows = Array.isArray(summary?.timeslots) ? summary.timeslots : [];
  const rawAxis = String(summary?.action_axis ?? "");
  const axisLabel = rawAxis === "receiver" || rawAxis === "rcv_cands" ? "rcv_cands" : "br_cands";
  const axisText = axisLabel === "rcv_cands" ? "receive candidate" : "broadcast candidate";
  if (rows.length === 0) {
    return <p className="muted">No aggregate candidate data.</p>;
  }
  const counts = rows.map((row) => Number(row.mean_candidate_count)).filter((n) => Number.isFinite(n));
  const computedMaxC = Math.max(...counts, 1e-6);
  const maxC = Number.isFinite(Number(yMax)) ? Math.max(Number(yMax), 1e-6) : computedMaxC;
  const n = rows.length;
  const padL = 54;
  const padR = 22;
  const padT = 16;
  const padB = 52;
  const innerW = Math.max(420, Math.min(880, n * 28));
  const width = padL + innerW + padR;
  const height = 300;
  const chartW = innerW;
  const chartH = height - padT - padB;
  const slotW = chartW / Math.max(n, 1);
  const barW = Math.max(6, slotW * 0.58);
  const yTicksRaw = linearAxisTicks(0, maxC, 6).filter((t) => t <= maxC + 1e-9);
  const yTicks = yTicksRaw.length > 0 ? yTicksRaw : [0, maxC];
  const yToSvg = (v) => padT + chartH - (v / maxC) * chartH;
  const formatYTick = (t) => (Number.isInteger(t) ? String(t) : t.toFixed(1));
  const xLabelStep = n > 48 ? 3 : n > 32 ? 2 : 1;

  return (
    <div className="delay-chart-wrap action-space-mean-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="delay-chart action-space-mean-chart-svg"
        preserveAspectRatio="xMidYMid meet"
      >
        <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
        {yTicks.map((t) => (
          <g key={`yt-${t}`}>
            <line
              x1={padL}
              x2={padL + chartW}
              y1={yToSvg(t)}
              y2={yToSvg(t)}
              stroke="#e2e5f0"
              strokeWidth="1"
            />
            <text
              x={padL - 8}
              y={yToSvg(t) + 4}
              textAnchor="end"
              fontSize="12"
              fill="#4d5478"
            >
              {formatYTick(t)}
            </text>
          </g>
        ))}
        <line
          x1={padL}
          y1={padT + chartH}
          x2={padL + chartW}
          y2={padT + chartH}
          stroke="#2b2f3a"
          strokeWidth="1.2"
        />
        <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="#2b2f3a" strokeWidth="1.2" />
        <text x={padL + chartW / 2} y={height - 8} textAnchor="middle" fontSize="12" fill="#4d5478">
          Timeslot
        </text>
        <text x={padL} y={padT - 2} textAnchor="start" fontSize="11" fill="#4d5478">
          {`Mean ${axisText}`}
        </text>
        {rows.map((row, i) => {
          const mean = Number(row.mean_candidate_count);
          if (!Number.isFinite(mean)) return null;
          const h = (mean / maxC) * chartH;
          const xCenter = padL + i * slotW + slotW / 2;
          const x = xCenter - barW / 2;
          const y = padT + chartH - h;
          const ts = row.timeslot;
          return (
            <g key={`${row.timeslot}-${i}`}>
              <rect x={x} y={y} width={barW} height={Math.max(h, 1)} fill="#63a5c7" rx={2} />
              {i % xLabelStep === 0 ? (
                <text
                  x={xCenter}
                  y={padT + chartH + 18}
                  textAnchor="middle"
                  fontSize={n > 28 ? 10 : 12}
                  fill="#4d5478"
                >
                  {String(ts)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="delay-chart-meta">
        <span>
          {n} timeslots · mean {axisText}
        </span>
      </div>
    </div>
  );
}

function QProfileEpochBarChart({ chart, actionAxis }) {
  const rows = Array.isArray(chart?.timeslots) ? chart.timeslots : [];
  if (rows.length === 0) {
    return <p className="muted">No q-profile data.</p>;
  }
  const values = rows.flatMap((row) => [Number(row.max_q), Number(row.mean_q)]).filter((n) => Number.isFinite(n));
  const maxY = Math.max(...values, 0.000001);
  const n = rows.length;
  const padL = 54;
  const padR = 18;
  const padT = 18;
  const padB = 48;
  const innerW = Math.max(420, Math.min(900, n * 28));
  const width = padL + innerW + padR;
  const height = 280;
  const chartW = innerW;
  const chartH = height - padT - padB;
  const slotW = chartW / Math.max(n, 1);
  const groupW = Math.max(8, slotW * 0.72);
  const barW = Math.max(3, groupW / 2 - 1.5);
  const yTicksRaw = linearAxisTicks(0, maxY, 6).filter((t) => t <= maxY + 1e-9);
  const yTicks = yTicksRaw.length > 0 ? yTicksRaw : [0, maxY];
  const yToSvg = (v) => padT + chartH - (v / maxY) * chartH;
  const xLabelStep = n > 48 ? 3 : n > 32 ? 2 : 1;
  const axisLabel = actionAxis === "receiver" ? "rcv_cands" : "br_cands";
  return (
    <div className="delay-chart-wrap action-space-mean-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="delay-chart action-space-mean-chart-svg">
        <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
        {yTicks.map((t) => (
          <g key={`qy-${t}`}>
            <line x1={padL} x2={padL + chartW} y1={yToSvg(t)} y2={yToSvg(t)} stroke="#e2e5f0" strokeWidth="1" />
            <text x={padL - 8} y={yToSvg(t) + 4} textAnchor="end" fontSize="11" fill="#4d5478">
              {Number.isInteger(t) ? String(t) : t.toFixed(2)}
            </text>
          </g>
        ))}
        <line x1={padL} y1={padT + chartH} x2={padL + chartW} y2={padT + chartH} stroke="#2b2f3a" strokeWidth="1.2" />
        <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="#2b2f3a" strokeWidth="1.2" />
        <text x={padL + chartW / 2} y={height - 8} textAnchor="middle" fontSize="12" fill="#4d5478">
          Timeslot
        </text>
        <text x={padL} y={padT - 4} textAnchor="start" fontSize="11" fill="#4d5478">
          {`Q by valid actions (${axisLabel})`}
        </text>
        {rows.map((row, i) => {
          const maxQ = Number(row.max_q);
          const meanQ = Number(row.mean_q);
          const ts = row.timeslot;
          const xCenter = padL + i * slotW + slotW / 2;
          const leftX = xCenter - groupW / 2;
          const maxH = Number.isFinite(maxQ) ? (Math.max(maxQ, 0) / maxY) * chartH : 0;
          const meanH = Number.isFinite(meanQ) ? (Math.max(meanQ, 0) / maxY) * chartH : 0;
          return (
            <g key={`qprof-${ts}-${i}`}>
              <rect x={leftX} y={padT + chartH - maxH} width={barW} height={Math.max(maxH, 1)} fill="#4E79A7" rx={1} />
              <rect
                x={leftX + barW + 3}
                y={padT + chartH - meanH}
                width={barW}
                height={Math.max(meanH, 1)}
                fill="#E15759"
                rx={1}
              />
              {i % xLabelStep === 0 ? (
                <text x={xCenter} y={padT + chartH + 16} textAnchor="middle" fontSize={n > 28 ? 10 : 12} fill="#4d5478">
                  {String(ts)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="delay-chart-meta">
        <span>Bars: blue=max Q, red=mean Q</span>
        <span>Timeslots: {n}</span>
      </div>
    </div>
  );
}


function TopologyGraph({
  graph,
  className = "",
  interactive = false,
  showLabels = true,
  renderEdges = true,
  maxNodes = null,
  nodeFillById = {},
  nodeStrokeById = {},
  nodeStrokeWidthById = {},
  nodeRadius = 1.35,
  labelSize = 2.4,
  edgeWidth = 0.45,
  edgeColor = "#d0d5ea",
  customEdges = null,
  directedEdges = false,
  onNodeHover = null,
  onNodeLeave = null,
  onNodeClick = null,
  clickableNodeIds = [],
  hoveredNodeId = null
}) {
  if (!graph) {
    return <div className={`topology-thumb ${className}`} />;
  }

  const rawNodes = graph.nodes || [];
  const nodes = useMemo(() => downsampleNodes(rawNodes, maxNodes), [rawNodes, maxNodes]);
  const edges = useMemo(() => {
    if (customEdges) {
      const nodeById = new Map(rawNodes.map((node) => [node.node_id, node]));
      return customEdges
        .map((edge) => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          if (!from || !to) return null;
          return {
            from,
            to,
            color: edge.color ?? edgeColor,
            width: edge.width ?? edgeWidth,
            directed: Boolean(edge.directed)
          };
        })
        .filter(Boolean);
    }
    return renderEdges
      ? buildEdges(nodes, graph.tx_range).map(([from, to]) => ({
          from,
          to,
          color: edgeColor,
          width: edgeWidth ?? (interactive ? 0.35 : 0.45),
          directed: directedEdges
        }))
      : [];
  }, [customEdges, rawNodes, renderEdges, nodes, graph.tx_range, edgeColor, edgeWidth, interactive, directedEdges]);
  const width = graph.space_width || 100;
  const height = graph.space_height || 100;
  const minScale = 0.8;
  const maxScale = 6;
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const svgRef = useRef(null);
  const dragStateRef = useRef({ active: false, lastX: 0, lastY: 0 });
  const clickableIdSet = useMemo(
    () => (clickableNodeIds instanceof Set ? clickableNodeIds : new Set(clickableNodeIds ?? [])),
    [clickableNodeIds]
  );

  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [graph.topology_id]);

  function clampScale(nextScale) {
    return Math.min(maxScale, Math.max(minScale, nextScale));
  }

  function zoomBy(delta) {
    if (!interactive) return;
    setScale((prev) => clampScale(prev + delta));
  }

  function resetView() {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  function handleWheel(event) {
    if (!interactive) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.nativeEvent?.stopImmediatePropagation) {
      event.nativeEvent.stopImmediatePropagation();
    }
    const delta = event.deltaY > 0 ? -0.2 : 0.2;
    setScale((prev) => clampScale(prev + delta));
  }

  function handleMouseDown(event) {
    if (!interactive) return;
    dragStateRef.current = {
      active: true,
      lastX: event.clientX,
      lastY: event.clientY
    };
  }

  function handleMouseMove(event) {
    if (!interactive || !dragStateRef.current.active || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dxPixels = event.clientX - dragStateRef.current.lastX;
    const dyPixels = event.clientY - dragStateRef.current.lastY;
    dragStateRef.current.lastX = event.clientX;
    dragStateRef.current.lastY = event.clientY;

    const dx = (dxPixels / rect.width) * width;
    const dy = (dyPixels / rect.height) * height;

    setPan((prev) => ({
      x: prev.x + dx,
      y: prev.y + dy
    }));
  }

  function handleMouseUp() {
    if (!interactive) return;
    dragStateRef.current.active = false;
  }

  function handleMouseLeave() {
    if (!interactive) return;
    dragStateRef.current.active = false;
  }

  return (
    <div
      className={`topology-graph-shell ${interactive ? "interactive" : ""}`}
      onWheelCapture={interactive ? handleWheel : undefined}
    >
      {interactive ? (
        <div className="graph-toolbar">
          <button type="button" onClick={() => zoomBy(0.2)}>+</button>
          <button type="button" onClick={() => zoomBy(-0.2)}>-</button>
          <button type="button" onClick={resetView}>Reset</button>
          <span>{scale.toFixed(1)}x</span>
        </div>
      ) : null}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className={`topology-svg ${className}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <marker id="topology-arrow" markerWidth="4" markerHeight="4" refX="3.2" refY="2" orient="auto">
            <path d="M0,0 L0,4 L4,2 z" fill={edgeColor} />
          </marker>
        </defs>
        <rect x="0" y="0" width={width} height={height} fill="#f7f8fd" />
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`} transformOrigin={`${width / 2} ${height / 2}`}>
          {edges.map((edge, idx) => (
            <line
              key={`${edge.from.node_id}-${edge.to.node_id}-${idx}`}
              x1={edge.from.x}
              y1={height - edge.from.y}
              x2={edge.to.x}
              y2={height - edge.to.y}
              stroke={edge.color ?? edgeColor}
              strokeWidth={edge.width ?? edgeWidth ?? (interactive ? 0.35 : 0.45)}
              markerEnd={edge.directed ? "url(#topology-arrow)" : undefined}
            />
          ))}
          {nodes.map((node) => (
            <g key={node.node_id}>
              <circle
                cx={node.x}
                cy={height - node.y}
                r={node.node_id === 0 ? nodeRadius + 0.25 : nodeRadius}
                fill={nodeFillById[node.node_id] ?? (node.node_id === 0 ? "#ec5bb8" : "#9da5bf")}
                stroke={nodeStrokeById[node.node_id] ?? "none"}
                strokeWidth={nodeStrokeWidthById[node.node_id] ?? 0}
                className={clickableIdSet.has(node.node_id) ? "topology-node--clickable" : ""}
                style={{ cursor: clickableIdSet.has(node.node_id) ? "pointer" : undefined }}
                onMouseEnter={onNodeHover ? () => onNodeHover(node.node_id) : undefined}
                onMouseLeave={onNodeLeave ?? undefined}
                onClick={onNodeClick && clickableIdSet.has(node.node_id) ? () => onNodeClick(node.node_id) : undefined}
              />
              {showLabels ? (
                <text
                  x={node.x + 1.4}
                  y={height - node.y - 1.2}
                  className="node-label"
                  style={{ fontSize: `${labelSize}px` }}
                  onMouseEnter={onNodeHover ? () => onNodeHover(node.node_id) : undefined}
                  onMouseLeave={onNodeLeave ?? undefined}
                  onClick={onNodeClick && clickableIdSet.has(node.node_id) ? () => onNodeClick(node.node_id) : undefined}
                >
                  {node.node_id}
                </text>
              ) : null}
              {hoveredNodeId === node.node_id ? (
                <circle
                  cx={node.x}
                  cy={height - node.y}
                  r={(node.node_id === 0 ? nodeRadius + 0.25 : nodeRadius) + 0.9}
                  fill="none"
                  stroke="#c22c2c"
                  strokeWidth={0.55}
                  pointerEvents="none"
                />
              ) : null}
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

function TopologyCard({
  topo,
  selected,
  onSelect,
  graph,
  selectionControl = null,
  previewMaxNodes = 80,
  previewShowEdges = true
}) {
  const skipGridVisual = topo.node_count >= 500;
  return (
    <button
      type="button"
      className={`topology-card ${selected ? "selected" : ""}`}
      onClick={() => onSelect(topo)}
    >
      <div className="topology-thumb-wrap">
        {skipGridVisual ? (
          <div className="large-topo-placeholder">
            <span>Preview hidden for {topo.node_count} nodes</span>
            <small>Click to open detail view</small>
          </div>
        ) : (
          <TopologyGraph
            graph={graph}
            className="thumb-graph"
            showLabels={false}
            renderEdges={previewShowEdges}
            maxNodes={previewMaxNodes}
          />
        )}
      </div>
      <div className={`topology-meta ${selectionControl ? "with-selection-control" : ""}`}>
        <span className="topology-name">{topo.topology_name}</span>
        {selectionControl}
        {topo.status === "done" && (
          <span className="topology-metrics">
            <span className="metric-delay">{topo.finished_delay ?? "-"}</span>
            <span className="metric-sep">/</span>
            <span className="metric-lb">{topo.lower_bound ?? "-"}</span>
          </span>
        )}
      </div>
    </button>
  );
}

function BatchCard({ batch, onOpen, statusLabel, idSubtitle, actions = null }) {
  return (
    <button type="button" className="batch-grid-card" onClick={() => onOpen(batch.batch_id)}>
      <div className="batch-grid-title-row">
        <div className="batch-grid-title">{batch.batch_name}</div>
        {actions ? (
          <div className="batch-card-actions" onClick={(event) => event.stopPropagation()}>
            {actions}
          </div>
        ) : null}
      </div>
      <div className="batch-grid-meta">
        {batch.topologies.length} topologies
        {statusLabel ? <span className="batch-status-pill">{statusLabel}</span> : null}
        {idSubtitle ? <span className="batch-card-id-snippet muted">id {idSubtitle}</span> : null}
      </div>
    </button>
  );
}

function QueueLaneDropdown({ lane, index, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelRef = useRef(null);
  const workerLabel = lane.worker_id ? `Worker ${index + 1}` : "Queue";
  const items = [...(Array.isArray(lane.queued) ? lane.queued : []), ...(lane.running ? [lane.running] : [])];
  if (!items.length) return null;

  useEffect(() => {
    if (!open || !panelRef.current) return;
    panelRef.current.scrollTop = panelRef.current.scrollHeight;
  }, [open, items.length]);

  return (
    <div className="queue-lane-dropdown">
      {open ? (
        <div ref={panelRef} className="queue-lane-panel">
          {items.map((item, itemIndex) => {
            const isRunning = item.status === "running" && itemIndex === items.length - 1;
            return (
              <div
                key={item.run_id}
                className={`queue-run-line ${isRunning ? "running" : "queued"} ${item.mode === "single" ? "single" : "batch"}`}
                title={`${item.topology_name} · ${item.mode}${item.batch_label ? ` · ${item.batch_label}` : ""}`}
              >
                <span className="queue-run-line-text">{item.topology_name}</span>
              </div>
            );
          })}
        </div>
      ) : null}
      <button type="button" className="queue-lane-trigger" onClick={() => setOpen((value) => !value)}>
        <span>{workerLabel}</span>
        <span className="queue-lane-count">{items.length}</span>
      </button>
    </div>
  );
}

function QueueOverlay({ snapshot }) {
  const lanes = Array.isArray(snapshot?.lanes) ? snapshot.lanes.filter((lane) => (lane?.queued?.length ?? 0) > 0 || lane?.running) : [];
  if (!lanes.length) return null;
  return (
    <div className="queue-overlay">
      <div className="queue-overlay-header">
        <span>Queue</span>
        <span className="muted">
          running {snapshot?.total_running ?? 0} · queued {snapshot?.total_queued ?? 0}
        </span>
      </div>
      <div className="queue-overlay-lanes">
        {lanes.map((lane, index) => (
          <QueueLaneDropdown
            key={lane.lane_id || lane.worker_id || `lane-${index}`}
            lane={lane}
            index={index}
            defaultOpen={index < 2}
          />
        ))}
      </div>
    </div>
  );
}

function BatchModal({ open, mode, value, setValue, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <h3>{mode === "create" ? "New batch" : "Edit batch"}</h3>
        <input
          autoFocus
          className="modal-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm();
            }
          }}
          placeholder="Batch name"
        />
        <div className="modal-actions">
          <button type="button" className="secondary-cta" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary-cta small" onClick={onConfirm}>OK</button>
        </div>
      </div>
    </div>
  );
}

export default function MainTopologyPanel({
  activeMenu,
  activePanel2Tab,
  mainTitle,
  temperatureTool,
  resetTemperatureTool,
  updateTemperatureActionCount,
  updateTemperatureTauRange,
  updateTemperatureQRange,
  updateTemperatureTau,
  updateTemperatureQValue,
  runBatches,
  resultsSingleRunBatches,
  runMultiForm,
  setRunMultiForm,
  runMultiSubMode = "multi",
  setRunMultiSubMode,
  repeatTopologyId = "",
  setRepeatTopologyId,
  repeatRunCount = 5,
  setRepeatRunCount,
  runBatchTopologies,
  runHistoryItems,
  latestCompletedRun,
  runSummaryPayload,
  transmissionLastPayload,
  transmissionBestPayload,
  qTablePayload,
  transmissionAllPayload,
  qTableAllEpochsPayload,
  resultsViewMode,
  setResultsViewMode,
  resultsEpochMode,
  setResultsEpochMode,
  selectedEpisode,
  setSelectedEpisode,
  replaySlot,
  setReplaySlot,
  latestRunCapabilities,
  graphDisplaySettings,
  bestDelayOverlayOpacity,
  selectedRunId,
  onSelectRun,
  onDeleteRun,
  topologies,
  selectedTopology,
  setSelectedTopology,
  focusedBatchId,
  setFocusedBatchId,
  batchRunResults,
  isLoadingBatchRunResults,
  batchRunResultsError,
  onRetryBatchRunResults,
  focusedBatchRunId,
  setFocusedBatchRunId,
  focusedBatchRunResult,
  isLoadingBatchRunResult,
  batchRunResultDetailError,
  onRetryBatchRunResultDetail,
  batchRunProgress,
  queueSnapshot,
  onBatchStop,
  onBatchResume,
  onDeleteBatchRunResult,
  graphByTopologyId,
  playgroundState,
  setPlaygroundMode,
  setPlaygroundViewSlot,
  setPlaygroundHoverNode,
  clearPlaygroundHoverPreview,
  commitPlaygroundNode,
  focusedTopologyId,
  setFocusedTopologyId,
  onDeleteTopology,
  onOpenTopology,
  onPickTopologyForRun,
  onRepeatTopologyPick,
  batches,
  statusFilter,
  setStatusFilter,
  nodeFilter,
  setNodeFilter,
  nodeOptions,
  onCreateBatch,
  onDeleteBatch,
  previewMaxNodesPercent = 80,
  previewShowEdges = true,
  onRenameBatch,
  generateMode,
  setGenerateMode,
  generateForm,
  multiGenerateForm,
  updateGenerateField,
  updateMultiGenerateField,
  toggleMultiNodeCount,
  handleGenerate,
  handleGenerateMulti,
  isGenerating,
  selectedBatchId,
  setSelectedBatchId,
  generateBatches,
  generateSelectedBatch,
  onToggleBatchLock,
  apiBase,
  singleRunTopologyIds,
  topologyNameById
}) {
  const BATCH_RESULT_ALIAS_STORAGE_KEY = "qbr_batch_result_alias_map_v1";
  const RUN_TOPO_PRESET_STORAGE_KEY = "qbr_run_topo_presets_v1";
  const homeViewMode = activeMenu === "home";
  const generateViewMode = activeMenu === "generate";
  const topologyViewMode = activeMenu === "topologies";
  const runTopoViewMode = activeMenu === "run_topo";
  const runMultiViewMode = activeMenu === "run_multi";
  const resultsView = activeMenu === "results";
  const compareViewMode = activeMenu === "compare";
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const [runPickerOpen, setRunPickerOpen] = useState(false);
  const [generateBatchModalOpen, setGenerateBatchModalOpen] = useState(false);
  const [generateBatchModalName, setGenerateBatchModalName] = useState("");
  const isTopologyPlayground = activeMenu === "topologies" && focusedTopologyId && activePanel2Tab === "playground";
  const temperatureProbabilityRows = useMemo(
    () => computeTemperatureProbabilities(temperatureTool?.qValues ?? [], temperatureTool?.tau ?? 1),
    [temperatureTool?.qValues, temperatureTool?.tau]
  );
  const focusedGraph = focusedTopologyId ? graphByTopologyId[focusedTopologyId] : null;
  const focusedTopo = focusedTopologyId
    ? topologies.find((item) => item.topology_id === focusedTopologyId) ?? selectedTopology
    : null;
  const focusedBatch = focusedBatchId ? batches.find((batch) => batch.batch_id === focusedBatchId) : null;
  const topologiesInBatch = focusedBatch?.topologies ?? [];
  const runFocusedBatch = focusedBatchId ? runBatches.find((batch) => batch.batch_id === focusedBatchId) : null;
  const runTopologies = runFocusedBatch?.topologies ?? [];
  const resultsSingleFocusedBatch = focusedBatchId
    ? (resultsSingleRunBatches ?? []).find((batch) => batch.batch_id === focusedBatchId) ?? null
    : null;
  const resultsSingleTopologies = resultsSingleFocusedBatch?.topologies ?? [];
  const runMultiSelectedBatch = useMemo(
    () => (runBatchTopologies ?? []).find((batch) => batch.batch_id === runMultiForm?.batch_id) ?? null,
    [runBatchTopologies, runMultiForm?.batch_id]
  );
  const runMultiTopologies = runMultiSelectedBatch?.topologies ?? [];
  const resultTopologies = focusedBatchRunResult?.topologies ?? [];
  const selectedEpisodeNum = Number(selectedEpisode) || 0;
  const transmissionEpisodes = Array.isArray(transmissionAllPayload?.episodes) ? transmissionAllPayload.episodes : [];
  const qTableEpisodes = Array.isArray(qTableAllEpochsPayload?.episodes) ? qTableAllEpochsPayload.episodes : [];
  const episodeOptions = transmissionEpisodes
    .map((item) => Number(item.episode))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const selectedEpisodeTransmission =
    selectedEpisodeNum > 0
      ? transmissionEpisodes.find((item) => Number(item.episode) === selectedEpisodeNum) ?? null
      : null;
  const selectedEpisodeQTable =
    selectedEpisodeNum > 0 ? qTableEpisodes.find((item) => Number(item.episode) === selectedEpisodeNum)?.q_table ?? null : null;
  const showMissingQTableEpisodeWarning = selectedEpisodeNum > 0 && !selectedEpisodeQTable && qTableEpisodes.length === 0;
  const currentTransmissionPayload =
    selectedEpisodeTransmission ?? (resultsEpochMode === "best" ? transmissionBestPayload : transmissionLastPayload);
  const replayTimeslots = currentTransmissionPayload?.timeslots ?? [];
  const maxReplaySlot = replayTimeslots.length;
  const replaySlotClamped =
    maxReplaySlot > 0 ? Math.min(Math.max(0, Number(replaySlot) || 0), maxReplaySlot) : 0;
  const coloredByTimeslot = useMemo(
    () => computeReceiveTimeslotMap(currentTransmissionPayload?.timeslots ?? []),
    [currentTransmissionPayload?.timeslots]
  );
  const timeslotEdges = useMemo(
    () =>
      buildTransmissionDiagnosticEdges(
        focusedGraph,
        currentTransmissionPayload?.timeslots ?? [],
        "all",
        replaySlotClamped
      ),
    [focusedGraph, currentTransmissionPayload?.timeslots, replaySlotClamped]
  );
  const replayEdges = useMemo(
    () => buildReplayLayeredEdges(focusedGraph, currentTransmissionPayload?.timeslots ?? [], replaySlotClamped),
    [focusedGraph, currentTransmissionPayload?.timeslots, replaySlotClamped]
  );
  const playgroundLatestSlot = playgroundState?.timeslots?.length ?? 0;
  const playgroundViewSlot = Math.min(Math.max(0, Number(playgroundState?.viewSlot) || 0), playgroundLatestSlot);
  const playgroundIsLatestView = playgroundViewSlot === playgroundLatestSlot;
  const playgroundActionLocked = !playgroundIsLatestView || Boolean(playgroundState?.isComplete);
  const playgroundPreview = playgroundActionLocked ? null : playgroundState?.hoverPreview ?? null;
  const playgroundCandidateIds = useMemo(() => {
    if (!focusedGraph || playgroundActionLocked) return [];
    const committedCovered = new Set(playgroundState?.coveredNodeIds ?? [0]);
    const adjacency = buildAdjacencyFromGraph(focusedGraph);
    const broadcasterCandidates = Array.from(committedCovered)
      .filter((nodeId) => Array.from(adjacency.get(nodeId) ?? []).some((neighborId) => !committedCovered.has(neighborId)))
      .sort((a, b) => a - b);
    if (playgroundState?.mode === "receiver") {
      const receiverSet = new Set();
      broadcasterCandidates.forEach((nodeId) => {
        (adjacency.get(nodeId) ?? new Set()).forEach((neighborId) => {
          if (!committedCovered.has(neighborId)) receiverSet.add(neighborId);
        });
      });
      return Array.from(receiverSet).sort((a, b) => a - b);
    }
    return broadcasterCandidates;
  }, [focusedGraph, playgroundActionLocked, playgroundState?.coveredNodeIds, playgroundState?.mode]);
  const playgroundEdges = useMemo(() => {
    if (!focusedGraph) return [];
    const committedEdges = buildReplayLayeredEdges(focusedGraph, playgroundState?.timeslots ?? [], playgroundViewSlot, {
      hideBaseEdgesAtEnd: Boolean(playgroundState?.isComplete)
    });
    if (!playgroundPreview) return committedEdges;
    const previewSlot = {
      timeslot: playgroundViewSlot + 1,
      transmitters: playgroundPreview.transmitters,
      receivers: playgroundPreview.receivers
    };
    return [
      ...committedEdges,
      ...buildTransmissionDiagnosticEdges(focusedGraph, [previewSlot], "all", playgroundViewSlot + 1).map((edge) => ({
        ...edge,
        color: "#d9485f"
      }))
    ];
  }, [focusedGraph, playgroundPreview, playgroundState?.isComplete, playgroundState?.timeslots, playgroundViewSlot]);
  const playgroundVisual = useMemo(() => {
    const fillById = { 0: "#ec5bb8" };
    const strokeById = {};
    const strokeWidthById = {};
    const committedTimeslotMap = computeReceiveTimeslotMap((playgroundState?.timeslots ?? []).slice(0, playgroundViewSlot));
    Object.entries(committedTimeslotMap).forEach(([nodeId, ts]) => {
      if (Number(nodeId) !== 0) {
        fillById[nodeId] = colorForTimeslot(Number(ts));
      }
    });
    (playgroundCandidateIds ?? []).forEach((nodeId) => {
      strokeById[nodeId] = "#d62839";
      strokeWidthById[nodeId] = 0.7;
    });
    if (playgroundPreview) {
      const previewColor = colorForTimeslot(playgroundViewSlot + 1);
      (playgroundPreview.transmitters ?? []).forEach((nodeId) => {
        strokeById[nodeId] = "#8f0f15";
        strokeWidthById[nodeId] = 0.85;
      });
      (playgroundPreview.receivers ?? []).forEach((nodeId) => {
        fillById[nodeId] = previewColor;
        strokeById[nodeId] = "#d75a1a";
        strokeWidthById[nodeId] = 0.75;
      });
    }
    return { fillById, strokeById, strokeWidthById };
  }, [playgroundCandidateIds, playgroundPreview, playgroundState?.timeslots, playgroundViewSlot]);

  const replayVisual = useMemo(() => {
    const fillById = { 0: "#ec5bb8" };
    const receiveTsByNode = {};
    for (let idx = 0; idx < replaySlotClamped; idx += 1) {
      const slot = replayTimeslots[idx];
      (slot?.receivers ?? []).forEach((nodeId) => {
        if (!Number.isFinite(receiveTsByNode[nodeId])) {
          receiveTsByNode[nodeId] = Number(slot.timeslot) || idx + 1;
        }
      });
    }
    Object.entries(receiveTsByNode).forEach(([nodeId, ts]) => {
      if (Number(nodeId) !== 0) {
        fillById[nodeId] = colorForTimeslot(Number(ts));
      }
    });

    return { fillById };
  }, [maxReplaySlot, replaySlotClamped, replayTimeslots]);
  const qTableRows = useMemo(
    () => flattenQTableRows(selectedEpisodeQTable ?? qTablePayload, 300),
    [selectedEpisodeQTable, qTablePayload]
  );
  const hasTransmissionTrace = latestRunCapabilities?.has_transmission_trace ?? true;
  const hasQTable = latestRunCapabilities?.has_q_table ?? true;
  const hasEpochCompare = latestRunCapabilities?.has_epoch_compare ?? true;
  const completedRuns = useMemo(
    () => (runHistoryItems ?? []).filter((item) => item.status === "done"),
    [runHistoryItems]
  );
  const selectedRun = useMemo(
    () =>
      (selectedRunId
        ? completedRuns.find((item) => item.run_id === selectedRunId) ?? null
        : null) ?? completedRuns[0] ?? null,
    [completedRuns, selectedRunId]
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState("create");
  const [modalBatchName, setModalBatchName] = useState("");
  const [qValueSortMode, setQValueSortMode] = useState("none");
  const [batchResultAliasMap, setBatchResultAliasMap] = useState({});
  const [presetLabelMap, setPresetLabelMap] = useState({});
  /** Multi batch detail: which chart groups to show — not a per-density filter. */
  const [batchArtifactFilter, setBatchArtifactFilter] = useState(() => "all");

  useEffect(() => {
    try {
      const rawAlias = window.localStorage.getItem(BATCH_RESULT_ALIAS_STORAGE_KEY);
      if (rawAlias) {
        const parsed = JSON.parse(rawAlias);
        if (parsed && typeof parsed === "object") setBatchResultAliasMap(parsed);
      }
    } catch {
      // ignore invalid local storage content
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(BATCH_RESULT_ALIAS_STORAGE_KEY, JSON.stringify(batchResultAliasMap));
    } catch {
      // ignore write errors
    }
  }, [batchResultAliasMap]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RUN_TOPO_PRESET_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const nextMap = {};
      parsed.forEach((item) => {
        if (!item || typeof item !== "object") return;
        const id = typeof item.id === "string" ? item.id : "";
        const label = typeof item.label === "string" ? item.label.trim() : "";
        if (!id || !label) return;
        nextMap[id] = label;
      });
      setPresetLabelMap(nextMap);
    } catch {
      // Ignore invalid local storage content.
    }
  }, []);

  async function handleGenerateBatchModalConfirm() {
    const id = await onCreateBatch(generateBatchModalName);
    if (id) {
      setGenerateBatchModalOpen(false);
      setGenerateBatchModalName("");
      setSelectedBatchId(id);
    }
  }

  useEffect(() => {
    if (!hasTransmissionTrace && (resultsViewMode === "timeslot" || resultsViewMode === "replay")) {
      setResultsViewMode("normal");
    }
  }, [hasTransmissionTrace, resultsViewMode, setResultsViewMode]);

  useEffect(() => {
    setQValueSortMode("none");
  }, [latestCompletedRun?.run_id]);

  const displayedQTableRows = useMemo(() => {
    if (qValueSortMode === "none") return qTableRows;
    const sorted = [...qTableRows].sort((a, b) => {
      const av = Number.isFinite(a.q_value) ? a.q_value : Number.NEGATIVE_INFINITY;
      const bv = Number.isFinite(b.q_value) ? b.q_value : Number.NEGATIVE_INFINITY;
      return qValueSortMode === "desc" ? bv - av : av - bv;
    });
    return sorted;
  }, [qTableRows, qValueSortMode]);

  function getQSortIcon() {
    if (qValueSortMode === "desc") return "▽";
    if (qValueSortMode === "asc") return "△";
    return "○";
  }

  function cycleQSortMode() {
    setQValueSortMode((prev) => {
      if (prev === "none") return "desc";
      if (prev === "desc") return "asc";
      return "none";
    });
  }

  useEffect(() => {
    if (!hasEpochCompare && resultsEpochMode !== "last") {
      setResultsEpochMode("last");
    }
  }, [hasEpochCompare, resultsEpochMode, setResultsEpochMode]);

  useEffect(() => {
    setRunPickerOpen(false);
  }, [focusedTopologyId, selectedTopology?.topology_id]);

  function formatRunOptionLabel(run) {
    const delay = run.finished_delay ?? run.best_delay_explored ?? "-";
    const presetId = typeof run.preset_id === "string" && run.preset_id.trim() ? run.preset_id.trim() : "default_v1";
    const presetNameRaw = typeof run.preset_name === "string" ? run.preset_name.trim() : "";
    const storedPresetLabel = presetLabelMap[presetId] ?? null;
    const presetLabel = presetNameRaw || storedPresetLabel || presetId;
    return `${presetLabel} || ${delay}`;
  }

  async function handleModalConfirm() {
    if (modalMode === "create") {
      const id = await onCreateBatch(modalBatchName);
      if (id) {
        setModalOpen(false);
        setFocusedBatchId(id);
      }
      return;
    }
    if (!focusedBatch) return;
    const ok = await onRenameBatch(focusedBatch.batch_id, modalBatchName);
    if (ok) {
      setModalOpen(false);
    }
  }

  function toggleRunMultiTopology(topologyId) {
    setRunMultiForm((prev) => {
      const set = new Set(prev.selected_topology_ids ?? []);
      if (set.has(topologyId)) {
        set.delete(topologyId);
      } else {
        set.add(topologyId);
      }
      return { ...prev, selected_topology_ids: Array.from(set) };
    });
  }

  function toggleRunMultiBatchSelection() {
    setRunMultiForm((prev) => ({
      ...prev,
      batch_selected: !prev.batch_selected,
      selected_topology_ids: prev.batch_selected ? [] : runMultiTopologies.map((topo) => topo.topology_id)
    }));
  }

  const isRunMultiRepeatMode = runMultiSubMode === "repeat";

  function switchRunMultiSubMode(nextMode) {
    if (!setRunMultiSubMode) return;
    setRunMultiSubMode(nextMode);
    setRunMultiForm((prev) => ({
      ...prev,
      batch_selected: false,
      selected_topology_ids: []
    }));
    if (setRepeatTopologyId) setRepeatTopologyId("");
    setFocusedTopologyId(null);
    setSelectedTopology(null);
  }

  function openRunMultiBatch(batchId) {
    const pickedBatch = (runBatchTopologies ?? []).find((item) => item.batch_id === batchId) ?? null;
    if (isRunMultiRepeatMode) {
      setRunMultiForm((prev) => ({
        ...prev,
        batch_id: batchId,
        batch_selected: false,
        selected_topology_ids: []
      }));
      if (setRepeatTopologyId) setRepeatTopologyId("");
    } else {
      const allTopologyIds = (pickedBatch?.topologies ?? []).map((topo) => topo.topology_id);
      setRunMultiForm((prev) => ({
        ...prev,
        batch_id: batchId,
        batch_selected: true,
        selected_topology_ids: allTopologyIds
      }));
    }
    setFocusedTopologyId(null);
    setSelectedTopology(null);
  }

  function clearRunMultiBatchSelection() {
    setRunMultiForm((prev) => ({
      ...prev,
      batch_id: "",
      batch_selected: false,
      selected_topology_ids: []
    }));
    if (setRepeatTopologyId) setRepeatTopologyId("");
    setFocusedTopologyId(null);
    setSelectedTopology(null);
  }

  const handleRunMultiVisibleTopologiesChange = useCallback(
    (visibleTopologies) => {
      const visibleIds = visibleTopologies.map((topo) => topo.topology_id).sort();
      setRunMultiForm((prev) => {
        const prevIds = [...(prev.selected_topology_ids ?? [])].sort();
        const same =
          prevIds.length === visibleIds.length && prevIds.every((id, idx) => id === visibleIds[idx]);
        const nextBatchSelected = visibleIds.length > 0 && visibleIds.length === runMultiTopologies.length;
        if (same && prev.batch_selected === nextBatchSelected) return prev;
        return {
          ...prev,
          selected_topology_ids: visibleIds,
          batch_selected: nextBatchSelected
        };
      });
    },
    [runMultiTopologies.length, setRunMultiForm]
  );

  return (
    <section className={`main-panel-shell${compareViewMode ? " main-panel-shell--compare" : ""}`}>
      <header className="main-panel-header">
        <div>
          <h1>Main Panel 1</h1>
          <p>{mainTitle}</p>
        </div>
        <div className="main-header-actions">
          {topologyViewMode && focusedTopologyId ? (
            <button type="button" className="back-to-grid-btn" onClick={() => setFocusedTopologyId(null)}>
              Back to topologies
            </button>
          ) : runTopoViewMode && focusedTopologyId ? (
            <button type="button" className="back-to-grid-btn" onClick={() => setFocusedTopologyId(null)}>
              Back to topologies
            </button>
          ) : topologyViewMode && focusedBatchId ? (
            <button type="button" className="back-to-grid-btn" onClick={() => setFocusedBatchId(null)}>
              Back to batches
            </button>
          ) : runTopoViewMode && focusedBatchId ? (
            <button type="button" className="back-to-grid-btn" onClick={() => setFocusedBatchId(null)}>
              Back to batches
            </button>
          ) : runMultiViewMode && focusedTopologyId ? (
            <button type="button" className="back-to-grid-btn" onClick={() => setFocusedTopologyId(null)}>
              Back to topologies
            </button>
          ) : runMultiViewMode && runMultiForm.batch_id ? (
            <button type="button" className="back-to-grid-btn" onClick={clearRunMultiBatchSelection}>
              Back to batches
            </button>
          ) : resultsView && focusedTopologyId ? (
            <button type="button" className="back-to-grid-btn" onClick={() => setFocusedTopologyId(null)}>
              Back to topologies
            </button>
          ) : resultsView && focusedBatchId ? (
            <button type="button" className="back-to-grid-btn" onClick={() => setFocusedBatchId(null)}>
              Back to batches
            </button>
          ) : resultsView && focusedBatchRunId ? (
            <button type="button" className="back-to-grid-btn" onClick={() => setFocusedBatchRunId(null)}>
              Back to batches
            </button>
          ) : null}
        </div>
      </header>

      {homeViewMode ? (
        <TemperatureToolWorkspace
          tool={temperatureTool}
          rows={temperatureProbabilityRows}
          onReset={resetTemperatureTool}
          onActionCountChange={updateTemperatureActionCount}
          onTauRangeChange={updateTemperatureTauRange}
          onQRangeChange={updateTemperatureQRange}
          onTauChange={updateTemperatureTau}
          onQValueChange={updateTemperatureQValue}
        />
      ) : generateViewMode ? (
        <div className="generate-workspace">
          <div className="generate-mode-toggle">
            <button
              type="button"
              className={generateMode === "single" ? "active" : ""}
              onClick={() => setGenerateMode("single")}
            >
              Single topology
            </button>
            <button
              type="button"
              className={generateMode === "multi" ? "active" : ""}
              onClick={() => setGenerateMode("multi")}
            >
              Multi topologies
            </button>
          </div>

          <div className="batch-dropdown">
            <button
              type="button"
              className="batch-dropdown-trigger"
              onClick={() => setBatchPickerOpen((o) => !o)}
            >
              <span>
                {generateSelectedBatch
                  ? `${generateSelectedBatch.batch_name}${generateSelectedBatch.is_locked ? " (locked)" : ""}`
                  : "Select batch (optional — default batch if empty)"}
              </span>
              <span>{batchPickerOpen ? "▴" : "▾"}</span>
            </button>
            {batchPickerOpen ? (
              <div className="batch-dropdown-menu">
                <button
                  type="button"
                  className="batch-add-btn"
                  onClick={() => {
                    setGenerateBatchModalOpen(true);
                    setBatchPickerOpen(false);
                  }}
                >
                  + New batch
                </button>
                {generateBatches.map((batch) => (
                  <div
                    key={batch.batch_id}
                    className={`batch-menu-item ${selectedBatchId === batch.batch_id ? "active" : ""}`}
                  >
                    <button
                      type="button"
                      className="batch-select-btn"
                      onClick={() => {
                        setSelectedBatchId(batch.batch_id);
                        setBatchPickerOpen(false);
                      }}
                    >
                      {batch.batch_name}
                    </button>
                    <div className="batch-actions">
                      <button
                        type="button"
                        className="batch-icon-btn"
                        title={batch.is_locked ? "Unlock" : "Lock"}
                        onClick={() => onToggleBatchLock(batch.batch_id, batch.is_locked)}
                      >
                        {batch.is_locked ? "🔓" : "🔒"}
                      </button>
                      <button
                        type="button"
                        className="batch-icon-btn danger"
                        title="Delete batch"
                        onClick={() => {
                          if (batch.batch_name === "Default batch") return;
                          onDeleteBatch(batch.batch_id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {generateSelectedBatch?.is_locked ? (
            <p className="muted">This batch is locked. Unlock it to generate into it.</p>
          ) : null}

          {generateMode === "single" ? (
            <form className="generate-form-wrap" onSubmit={handleGenerate}>
              <div className="generate-inline-form">
                <label className="field-label">
                  Nodes
                  <select
                    value={generateForm.num_nodes}
                    onChange={(e) => updateGenerateField("num_nodes", Number(e.target.value))}
                  >
                    {nodeOptions.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  Space width
                  <input
                    type="number"
                    min={10}
                    value={generateForm.space_width}
                    onChange={(e) => updateGenerateField("space_width", Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  Space height
                  <input
                    type="number"
                    min={10}
                    value={generateForm.space_height}
                    onChange={(e) => updateGenerateField("space_height", Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  Tx range
                  <input
                    type="number"
                    min={1}
                    value={generateForm.tx_range}
                    onChange={(e) => updateGenerateField("tx_range", Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  Sink mode
                  <select
                    value={generateForm.sink_mode}
                    onChange={(e) => updateGenerateField("sink_mode", e.target.value)}
                  >
                    <option value="manual">Manual</option>
                    <option value="center">Center</option>
                    <option value="corner_tl">Corner TL</option>
                    <option value="corner_tr">Corner TR</option>
                    <option value="corner_bl">Corner BL</option>
                    <option value="corner_br">Corner BR</option>
                  </select>
                </label>
                {generateForm.sink_mode === "manual" ? (
                  <>
                    <label className="field-label">
                      Sink X
                      <input
                        type="number"
                        min={0}
                        value={generateForm.sink_x}
                        onChange={(e) => updateGenerateField("sink_x", Number(e.target.value))}
                      />
                    </label>
                    <label className="field-label">
                      Sink Y
                      <input
                        type="number"
                        min={0}
                        value={generateForm.sink_y}
                        onChange={(e) => updateGenerateField("sink_y", Number(e.target.value))}
                      />
                    </label>
                  </>
                ) : null}
                <label className="field-label">
                  Seed
                  <div className="seed-toggle-row">
                    <input
                      type="checkbox"
                      checked={generateForm.use_seed}
                      onChange={(e) => updateGenerateField("use_seed", e.target.checked)}
                    />
                    <input
                      type="number"
                      disabled={!generateForm.use_seed}
                      value={generateForm.seed}
                      onChange={(e) => updateGenerateField("seed", Number(e.target.value))}
                    />
                  </div>
                </label>
                <label className="field-label">
                  Max retry
                  <input
                    type="number"
                    min={1}
                    value={generateForm.max_retry}
                    onChange={(e) => updateGenerateField("max_retry", Number(e.target.value))}
                  />
                </label>
                <button className="primary-cta" type="submit" disabled={isGenerating || generateSelectedBatch?.is_locked}>
                  {isGenerating ? "Generating..." : "Generate"}
                </button>
              </div>
            </form>
          ) : (
            <form className="generate-form-wrap" onSubmit={handleGenerateMulti}>
              <div className="multi-node-grid">
                {nodeOptions.map((n) => (
                  <label key={n} className="multi-node-option">
                    <input
                      type="checkbox"
                      checked={multiGenerateForm.node_counts.includes(n)}
                      onChange={() => toggleMultiNodeCount(n)}
                    />
                    {n}
                  </label>
                ))}
              </div>
              <div className="generate-inline-form">
                <label className="field-label">
                  Count per node count
                  <input
                    type="number"
                    min={1}
                    value={multiGenerateForm.count_per_node_count}
                    onChange={(e) => updateMultiGenerateField("count_per_node_count", Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  Space width
                  <input
                    type="number"
                    min={10}
                    value={multiGenerateForm.space_width}
                    onChange={(e) => updateMultiGenerateField("space_width", Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  Space height
                  <input
                    type="number"
                    min={10}
                    value={multiGenerateForm.space_height}
                    onChange={(e) => updateMultiGenerateField("space_height", Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  Tx range
                  <input
                    type="number"
                    min={1}
                    value={multiGenerateForm.tx_range}
                    onChange={(e) => updateMultiGenerateField("tx_range", Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  Sink mode
                  <select
                    value={multiGenerateForm.sink_mode}
                    onChange={(e) => updateMultiGenerateField("sink_mode", e.target.value)}
                  >
                    <option value="manual">Manual</option>
                    <option value="center">Center</option>
                    <option value="corner_tl">Corner TL</option>
                    <option value="corner_tr">Corner TR</option>
                    <option value="corner_bl">Corner BL</option>
                    <option value="corner_br">Corner BR</option>
                  </select>
                </label>
                {multiGenerateForm.sink_mode === "manual" ? (
                  <>
                    <label className="field-label">
                      Sink X
                      <input
                        type="number"
                        min={0}
                        value={multiGenerateForm.sink_x}
                        onChange={(e) => updateMultiGenerateField("sink_x", Number(e.target.value))}
                      />
                    </label>
                    <label className="field-label">
                      Sink Y
                      <input
                        type="number"
                        min={0}
                        value={multiGenerateForm.sink_y}
                        onChange={(e) => updateMultiGenerateField("sink_y", Number(e.target.value))}
                      />
                    </label>
                  </>
                ) : null}
                <label className="field-label">
                  Seed policy
                  <small className="muted">Multi-generate uses unique random seed per topology.</small>
                </label>
                <label className="field-label">
                  Max retry
                  <input
                    type="number"
                    min={1}
                    value={multiGenerateForm.max_retry}
                    onChange={(e) => updateMultiGenerateField("max_retry", Number(e.target.value))}
                  />
                </label>
                <button className="primary-cta" type="submit" disabled={isGenerating || generateSelectedBatch?.is_locked}>
                  {isGenerating ? "Generating..." : "Generate multi"}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : runTopoViewMode ? (
        <>
          {focusedTopologyId ? (
            <FocusedTopologySection
              title="Topology detail"
              subtitle={selectedTopology?.topology_name ?? "No selection"}
            >
              <TopologyGraph
                graph={focusedGraph}
                className="full-graph"
                interactive
                showLabels
                nodeRadius={graphDisplaySettings.node_size}
                labelSize={graphDisplaySettings.label_size}
                edgeWidth={graphDisplaySettings.edge_width}
              />
            </FocusedTopologySection>
          ) : !runFocusedBatch ? (
            <BatchGridSection
              batches={runBatches}
              renderBatchCard={(batch) => (
                <BatchCard
                  key={batch.batch_id}
                  batch={batch}
                  onOpen={(batchId) => {
                    setFocusedBatchId(batchId);
                    setFocusedTopologyId(null);
                    setSelectedTopology(null);
                  }}
                />
              )}
            />
          ) : (
            <TopologyGridSection
              title={runFocusedBatch.batch_name}
              topologies={runTopologies}
              renderTopologyCard={(topo) => (
                <TopologyCard
                  key={topo.topology_id}
                  topo={topo}
                  selected={selectedTopology?.topology_id === topo.topology_id}
                  graph={graphByTopologyId[topo.topology_id]}
                  onSelect={onPickTopologyForRun}
                />
              )}
            />
          )}
        </>
      ) : runMultiViewMode ? (
        <section className="generate-workspace">
          <div className="generate-mode-toggle run-multi-submode-toggle">
            <button
              type="button"
              className={!isRunMultiRepeatMode ? "active" : ""}
              onClick={() => switchRunMultiSubMode("multi")}
            >
              Multi topologies
            </button>
            <button
              type="button"
              className={isRunMultiRepeatMode ? "active" : ""}
              onClick={() => switchRunMultiSubMode("repeat")}
            >
              Repeat 1 topology
            </button>
          </div>
          <div className="generate-form-wrap">
            {focusedTopologyId ? (
              <FocusedTopologySection
                title="Topology detail"
                subtitle={selectedTopology?.topology_name ?? "No selection"}
              >
                <TopologyGraph
                  graph={focusedGraph}
                  className="full-graph"
                  interactive
                  showLabels
                  nodeRadius={graphDisplaySettings.node_size}
                  labelSize={graphDisplaySettings.label_size}
                  edgeWidth={graphDisplaySettings.edge_width}
                />
              </FocusedTopologySection>
            ) : !runMultiForm.batch_id ? (
              <BatchGridSection
                batches={runBatchTopologies}
                renderBatchCard={(batch) => (
                  <BatchCard key={batch.batch_id} batch={batch} onOpen={openRunMultiBatch} />
                )}
              />
            ) : null}

            {runMultiForm.batch_id && !focusedTopologyId ? (
              <TopologyGridSection
                title={runMultiSelectedBatch?.batch_name ?? "Batch"}
                headerRight={
                  <div className="batch-top-actions">
                    {!isRunMultiRepeatMode ? (
                      <button type="button" className="secondary-cta" onClick={toggleRunMultiBatchSelection}>
                        {runMultiForm.batch_selected ? "✓ Batch selected" : "○ Select batch"}
                      </button>
                    ) : null}
                    <button type="button" className="secondary-cta" onClick={clearRunMultiBatchSelection}>
                      Change batch
                    </button>
                  </div>
                }
              topologies={runMultiTopologies}
              emptyMessage="No topology available in this batch."
              onVisibleTopologiesChange={isRunMultiRepeatMode ? undefined : handleRunMultiVisibleTopologiesChange}
                renderTopologyCard={(topo) => (
                  <TopologyCard
                    key={topo.topology_id}
                    topo={topo}
                    selected={
                      isRunMultiRepeatMode
                        ? repeatTopologyId === topo.topology_id
                        : selectedTopology?.topology_id === topo.topology_id
                    }
                    graph={graphByTopologyId[topo.topology_id]}
                    onSelect={
                      isRunMultiRepeatMode
                        ? () => (onRepeatTopologyPick ? onRepeatTopologyPick(topo) : onPickTopologyForRun(topo))
                        : () => onPickTopologyForRun(topo)
                    }
                    selectionControl={
                      isRunMultiRepeatMode ? null : (
                        <label className="topology-card-checkbox" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={(runMultiForm.selected_topology_ids ?? []).includes(topo.topology_id)}
                            onChange={() => toggleRunMultiTopology(topo.topology_id)}
                          />
                          Selected
                        </label>
                      )
                    }
                  />
                )}
              />
            ) : null}

            <div className="generate-inline-form">
              {isRunMultiRepeatMode ? (
                <>
                  <label className="field-label">
                    Selected topology
                    <input
                      type="text"
                      value={selectedTopology?.topology_name ?? (repeatTopologyId ? "1 selected" : "None")}
                      disabled
                    />
                  </label>
                  <label className="field-label">
                    Runs (set in Run panel)
                    <input type="text" value={Math.max(1, Math.min(100, Math.trunc(Number(repeatRunCount) || 0)))} disabled />
                  </label>
                </>
              ) : (
                <label className="field-label">
                  Selected topologies
                  <input type="text" value={(runMultiForm.selected_topology_ids ?? []).length} disabled />
                </label>
              )}
            </div>
          </div>
        </section>
      ) : resultsView ? (
        focusedBatchRunId ? (
          isLoadingBatchRunResult && !focusedBatchRunResult && !batchRunResultDetailError ? (
            <div className="empty-topology-state">Loading batch result…</div>
          ) : batchRunResultDetailError && !focusedBatchRunResult ? (
            <div className="empty-topology-state batch-results-error">
              <p>{batchRunResultDetailError}</p>
              <button type="button" className="secondary-cta" onClick={onRetryBatchRunResultDetail}>
                Retry
              </button>
            </div>
          ) : !focusedBatchRunResult ? (
            <div className="empty-topology-state">Batch result not found.</div>
          ) : resultTopologies.length === 0 ? (
            <div className="empty-topology-state">No topology with results in this batch run.</div>
          ) : (
            <section className="generate-workspace">
              <div className="generate-form-wrap">
                <h3>{focusedBatchRunResult.result_label}</h3>
                {batchRunProgress ? (
                  <div className="batch-progress-panel">
                    <div className="batch-progress-summary">
                      <span>
                        Status: <strong>{batchRunProgress.batch_status}</strong>
                        {batchRunProgress.stop_requested ? (
                          <span className="muted"> — finishing current run, then stop</span>
                        ) : null}
                      </span>
                      <span className="batch-progress-counts muted">
                        done {batchRunProgress.done} / {batchRunProgress.total_topologies} · pending{" "}
                        {batchRunProgress.pending} · running {batchRunProgress.running} · failed{" "}
                        {batchRunProgress.failed} · stopped {batchRunProgress.stopped}
                      </span>
                    </div>
                    <div className="batch-progress-actions">
                      {(batchRunProgress.batch_status === "running" || batchRunProgress.batch_status === "queued") ? (
                        <button type="button" className="secondary-cta" onClick={onBatchStop}>
                          Stop batch
                        </button>
                      ) : null}
                      {batchRunProgress.batch_status === "stopped" && batchRunProgress.pending > 0 ? (
                        <button type="button" className="primary-cta small" onClick={onBatchResume}>
                          Resume
                        </button>
                      ) : null}
                    </div>
                    {Array.isArray(batchRunProgress.rows) && batchRunProgress.rows.length > 0 ? (
                      <div className="batch-progress-table-wrap">
                        <table className="batch-progress-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Topology</th>
                              <th>Run status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {batchRunProgress.rows.map((r) => (
                              <tr key={r.run_id}>
                                <td>{r.topology_index}</td>
                                <td>{r.topology_name}</td>
                                <td>
                                  <code>{r.status}</code>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <BatchResultDetailBody
                  result={focusedBatchRunResult}
                  artifactFilter={batchArtifactFilter}
                  onArtifactFilterChange={setBatchArtifactFilter}
                  bestDelayOverlayOpacity={bestDelayOverlayOpacity}
                />
              </div>
            </section>
          )
        ) : (
        <>
          <section className="results-hub-block results-hub-block--single">
            <div className="results-hub-block-heading">
              <h3 className="results-hub-title">Block 1 — Single topology</h3>
              <p className="muted results-hub-sub">
                Flow cũ: chọn batch đã run → mở grid topology → chọn topology để xem kết quả run đơn.
              </p>
            </div>
            {focusedTopologyId && selectedTopology ? (
              <section className="hero-preview single-topology-mode">
              <div className="hero-preview-header">
                <h3>Results view</h3>
                <span>{selectedTopology?.topology_name ?? "No selection"}</span>
              </div>
              <div className="results-graph-controls">
                <label className="field-label">
                  Display
                  <select value={resultsViewMode} onChange={(e) => setResultsViewMode(e.target.value)}>
                    <option value="normal">Normal</option>
                    {hasTransmissionTrace ? <option value="timeslot">Color by timeslot</option> : null}
                    {hasTransmissionTrace ? <option value="replay">Replay</option> : null}
                  </select>
                </label>
                {hasEpochCompare && (resultsViewMode === "replay" || resultsViewMode === "timeslot") ? (
                  <label className="field-label">
                    Epoch
                    <select value={resultsEpochMode} onChange={(e) => setResultsEpochMode(e.target.value)}>
                      <option value="last">Last epoch</option>
                      <option value="best">Best delay epoch</option>
                    </select>
                  </label>
                ) : null}
                {episodeOptions.length > 0 ? (
                  <label className="field-label">
                    Episode
                    <select value={selectedEpisode} onChange={(e) => setSelectedEpisode(e.target.value)}>
                      <option value="">Follow last/best</option>
                      {episodeOptions.map((ep) => (
                        <option key={ep} value={ep}>
                          Episode {ep}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className="run-dropdown">
                  <button
                    type="button"
                    className="run-dropdown-trigger"
                    onClick={() => setRunPickerOpen((open) => !open)}
                    disabled={completedRuns.length === 0}
                  >
                    <span>{selectedRun ? formatRunOptionLabel(selectedRun) : "No completed run"}</span>
                    <span>{runPickerOpen ? "▴" : "▾"}</span>
                  </button>
                  {runPickerOpen ? (
                    <div className="run-dropdown-menu">
                      {completedRuns.length === 0 ? (
                        <p className="muted">No completed run.</p>
                      ) : (
                        completedRuns.map((run) => (
                          <div key={run.run_id} className={`run-dropdown-item ${selectedRun?.run_id === run.run_id ? "active" : ""}`}>
                            <button
                              type="button"
                              className="run-dropdown-select-btn"
                              onClick={() => {
                                if (run.mode === "batch") {
                                  const ok = window.confirm(
                                    "Kết quả run từ chạy multi-run, có thể thiếu thông tin. Xác nhận xem ?"
                                  );
                                  if (!ok) return;
                                }
                                onSelectRun(run.run_id);
                                setRunPickerOpen(false);
                              }}
                            >
                              {formatRunOptionLabel(run)}
                            </button>
                            <button
                              type="button"
                              className="run-dropdown-delete-btn"
                              title="Delete run"
                              onClick={async () => {
                                await onDeleteRun(run.run_id);
                                setRunPickerOpen(false);
                              }}
                            >
                              🗑
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="hero-canvas-wrap full">
                <TopologyGraph
                  graph={focusedGraph}
                  className="full-graph"
                  interactive
                  showLabels
                  nodeRadius={graphDisplaySettings.node_size}
                  labelSize={graphDisplaySettings.label_size}
                  edgeWidth={graphDisplaySettings.edge_width}
                  edgeColor={
                    resultsViewMode === "normal" || (resultsViewMode === "replay" && replaySlotClamped === 0)
                      ? "#d0d5ea"
                      : "#2b2f3a"
                  }
                  customEdges={
                    resultsViewMode === "timeslot"
                      ? timeslotEdges
                      : resultsViewMode === "replay"
                        ? replayEdges
                        : null
                  }
                  directedEdges={resultsViewMode === "timeslot"}
                  nodeFillById={
                    resultsViewMode === "timeslot"
                      ? Object.fromEntries(
                          Object.entries(coloredByTimeslot)
                            .filter(([nodeId]) => Number(nodeId) !== 0)
                            .map(([nodeId, ts]) => [nodeId, colorForTimeslot(Number(ts))])
                        )
                      : resultsViewMode === "replay"
                        ? replayVisual.fillById
                        : {}
                  }
                />
              </div>
              {resultsViewMode === "replay" ? (
                <div className="replay-bar-wrap">
                  <input
                    type="range"
                    min={0}
                    max={maxReplaySlot}
                    value={replaySlotClamped}
                    onChange={(e) => setReplaySlot(Number(e.target.value))}
                  />
                  <div className="replay-bar-meta">
                    <span>Timeslot: {replaySlotClamped}</span>
                    <span>Total slots: {maxReplaySlot}</span>
                  </div>
                </div>
              ) : null}
              {hasQTable ? (
                <>
                  <div className="qtable-panel">
                    <div className="qtable-header">
                      <h4>
                        Q-table (by state){selectedEpisodeNum > 0 ? ` - episode ${selectedEpisodeNum}` : ""}
                      </h4>
                      <div className="qtable-actions">
                        <span className="muted">{displayedQTableRows.length} rows</span>
                        <button
                          type="button"
                          className="qtable-sort-btn"
                          title={
                            qValueSortMode === "desc"
                              ? "Sort q_value: high to low"
                              : qValueSortMode === "asc"
                                ? "Sort q_value: low to high"
                                : "Sort q_value: normal"
                          }
                          onClick={cycleQSortMode}
                        >
                          {getQSortIcon()}
                        </button>
                      </div>
                    </div>
                    {showMissingQTableEpisodeWarning ? (
                      <p className="muted">No per-episode q-table exported for this run. Please enable export before running.</p>
                    ) : null}
                    {displayedQTableRows.length === 0 ? (
                      <p className="muted">No q-table data loaded.</p>
                    ) : (
                      <div className="table-scroll qtable-scroll">
                        <table className="node-edit-table">
                          <thead>
                            <tr>
                              <th>state_hash</th>
                              <th>action</th>
                              <th>q_value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {displayedQTableRows.map((row, idx) => (
                              <tr key={`${row.state_hash}-${row.action}-${idx}`}>
                                <td className="qtable-statehash-cell" title={row.state_hash}>
                                  {row.state_hash}
                                </td>
                                <td>{row.action}</td>
                                <td>{Number.isFinite(row.q_value) ? row.q_value.toFixed(4) : "-"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  {(runSummaryPayload?.action_space_by_timeslot_rcv?.timeslots?.length ||
                    runSummaryPayload?.action_space_by_timeslot_br?.timeslots?.length) ? (
                    <div className="qtable-panel action-space-below-qtable">
                      <div className="qtable-header">
                        <h4>Mean candidate count by timeslot</h4>
                        <div className="qtable-actions">
                          <button
                            type="button"
                            className="qtable-sort-btn"
                            title="Download CSV"
                            onClick={() => {
                              const ts = runSummaryPayload.action_space_by_timeslot_rcv?.timeslots ?? [];
                              const lines = [
                                "timeslot,mean_candidate_count,n_unique_paths",
                                ...ts.map(
                                  (r) =>
                                    `${String(r.timeslot)},${String(r.mean_candidate_count)},${String(r.n_unique_paths ?? "")}`
                                )
                              ].join("\n");
                              const blob = new Blob([lines], { type: "text/csv;charset=utf-8;" });
                              const url = URL.createObjectURL(blob);
                              const link = document.createElement("a");
                              link.href = url;
                              link.download = "action_space_by_timeslot_rcv.csv";
                              link.click();
                              URL.revokeObjectURL(url);
                            }}
                          >
                            CSV
                          </button>
                        </div>
                      </div>
                      <div className="mean-cands-grid">
                        <div>
                          <h4 className="chart-subheading">Mean broadcast candidate</h4>
                          <ActionSpaceMeanBarChart
                            summary={runSummaryPayload.action_space_by_timeslot_br ?? runSummaryPayload.action_space_by_timeslot}
                            yMax={(() => {
                              const rcvTs = runSummaryPayload.action_space_by_timeslot_rcv?.timeslots ?? [];
                              const brTs = runSummaryPayload.action_space_by_timeslot_br?.timeslots ?? [];
                              const vals = [
                                ...rcvTs.map((r) => Number(r.mean_candidate_count)).filter((n) => Number.isFinite(n)),
                                ...brTs.map((r) => Number(r.mean_candidate_count)).filter((n) => Number.isFinite(n))
                              ];
                              return vals.length ? Math.max(...vals) : 0;
                            })()}
                          />
                        </div>
                        <div>
                          <h4 className="chart-subheading">Mean receive candidate</h4>
                          <ActionSpaceMeanBarChart
                            summary={runSummaryPayload.action_space_by_timeslot_rcv ?? runSummaryPayload.action_space_by_timeslot}
                            yMax={(() => {
                              const rcvTs = runSummaryPayload.action_space_by_timeslot_rcv?.timeslots ?? [];
                              const brTs = runSummaryPayload.action_space_by_timeslot_br?.timeslots ?? [];
                              const vals = [
                                ...rcvTs.map((r) => Number(r.mean_candidate_count)).filter((n) => Number.isFinite(n)),
                                ...brTs.map((r) => Number(r.mean_candidate_count)).filter((n) => Number.isFinite(n))
                              ];
                              return vals.length ? Math.max(...vals) : 0;
                            })()}
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {runSummaryPayload?.q_profile_by_epoch?.charts?.length ? (
                    <div className="qtable-panel action-space-below-qtable">
                      <div className="qtable-header">
                        <h4>Q profile by timeslot (epochs 200 / 450 / 700 / 1000)</h4>
                      </div>
                      <div className="qprofile-grid">
                        {(runSummaryPayload.q_profile_by_epoch.charts ?? []).map((chart, idx) => (
                          <div key={`${chart?.target_epoch ?? idx}-${chart?.resolved_epoch ?? idx}`} className="qprofile-epoch-block">
                            <div className="qtable-header">
                              <h4>
                                Epoch {chart?.target_epoch ?? "-"}
                                {Number(chart?.resolved_epoch) !== Number(chart?.target_epoch)
                                  ? ` (fallback: ${chart?.resolved_epoch ?? "-"})`
                                  : ""}
                              </h4>
                            </div>
                            <QProfileEpochBarChart
                              chart={chart}
                              actionAxis={runSummaryPayload?.q_profile_by_epoch?.action_axis ?? "broadcaster"}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
              </section>
            ) : focusedBatchId ? (
              <TopologyGridSection
                title={resultsSingleFocusedBatch?.batch_name ?? "Batch"}
                topologies={resultsSingleTopologies}
                emptyMessage="No topology available in this batch."
                renderTopologyCard={(topo) => (
                  <TopologyCard
                    key={topo.topology_id}
                    topo={topo}
                    selected={selectedTopology?.topology_id === topo.topology_id}
                    graph={graphByTopologyId[topo.topology_id]}
                    onSelect={() => {
                      setSelectedTopology(topo);
                      setFocusedTopologyId(topo.topology_id);
                    }}
                  />
                )}
              />
            ) : (
              <BatchGridSection
                batches={resultsSingleRunBatches ?? []}
                renderBatchCard={(batch, index) => (
                  <BatchCard
                    key={batch.batch_id ?? index}
                    batch={batch}
                    onOpen={(batchId) => {
                      setFocusedBatchId(batchId);
                      setFocusedTopologyId(null);
                      setSelectedTopology(null);
                    }}
                  />
                )}
              />
            )}
          </section>

          {!focusedBatchId ? (
            <section className="results-hub-block results-hub-block--multi">
            <div className="results-hub-block-heading">
              <h3 className="results-hub-title">Block 2 — Multi topology batches</h3>
              <p className="muted results-hub-sub">
                Mở một batch để xem Block A và mỗi density một card (Block B). Lọc theo loại biểu đồ chứ không ẩn density.
              </p>
            </div>
          {isLoadingBatchRunResults ? (
              <div className="empty-topology-state">Loading batch runs…</div>
            ) : batchRunResultsError ? (
              <div className="empty-topology-state batch-results-error">
                <p>{batchRunResultsError}</p>
                <button type="button" className="secondary-cta" onClick={onRetryBatchRunResults}>
                  Retry
                </button>
              </div>
            ) : !(batchRunResults ?? []).length ? (
              <div className="empty-topology-state">No batch runs yet.</div>
            ) : (
              <BatchGridSection
                batches={(batchRunResults ?? []).map((item) => ({
                  batch_id: item.batch_run_id,
                  batch_name:
                    typeof batchResultAliasMap[item.batch_run_id] === "string" && batchResultAliasMap[item.batch_run_id].trim()
                      ? batchResultAliasMap[item.batch_run_id].trim()
                      : item.result_label,
                  topologies: Array.from({ length: Number(item.total_topologies) || 0 }),
                  batch_status: item.batch_status ?? "completed"
                }))}
                renderBatchCard={(batch, index) => (
                  <BatchCard
                    key={batch.batch_id ?? index}
                    batch={batch}
                    statusLabel={batch.batch_status}
                    idSubtitle={(batch.batch_id ?? "").slice(0, 8)}
                    actions={
                      <>
                        <button
                          type="button"
                          className="batch-icon-btn"
                          title="Edit result name"
                          onClick={() => {
                            const current = typeof batchResultAliasMap[batch.batch_id] === "string" ? batchResultAliasMap[batch.batch_id] : "";
                            const next = window.prompt("Result display name (leave empty to reset):", current);
                            if (next === null) return;
                            const trimmed = next.trim();
                            setBatchResultAliasMap((prev) => {
                              const updated = { ...prev };
                              if (!trimmed) {
                                delete updated[batch.batch_id];
                              } else {
                                updated[batch.batch_id] = trimmed;
                              }
                              return updated;
                            });
                          }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="batch-icon-btn danger"
                          title="Delete this batch result"
                          onClick={() => {
                            onDeleteBatchRunResult(batch.batch_id);
                          }}
                        >
                          🗑
                        </button>
                      </>
                    }
                    onOpen={(batchRunId) => {
                      setFocusedBatchRunId(batchRunId);
                      setFocusedBatchId(null);
                    }}
                  />
                )}
              />
            )}
            </section>
          ) : null}
        </>
        )
      ) : compareViewMode ? (
        <CompareWorkspace
          apiBase={apiBase}
          batchRunResults={batchRunResults}
          isLoadingBatchRunResults={isLoadingBatchRunResults}
          batchRunResultsError={batchRunResultsError}
          onRetryBatchRunResults={onRetryBatchRunResults}
          singleRunTopologyIds={singleRunTopologyIds}
          topologyNameById={topologyNameById}
          bestDelayOverlayOpacity={bestDelayOverlayOpacity}
        />
      ) : !topologyViewMode ? (
        <div className="hero-placeholder">
          <p>{mainTitle} is coming soon.</p>
        </div>
      ) : (
        <>
          {!focusedTopologyId ? (
            <section className="topology-main-filters">
              <label className="field-label">
                Status
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">all</option>
                  <option value="new">new</option>
                  <option value="done">done</option>
                </select>
              </label>
              <label className="field-label">
                Nodes
                <select value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)}>
                  <option value="">all</option>
                  {nodeOptions.map((nodes) => (
                    <option key={nodes} value={nodes}>
                      {nodes}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          ) : null}

          {focusedTopologyId ? (
            <FocusedTopologySection
              title={isTopologyPlayground ? "Topology playground" : "Topology detail"}
              subtitle={focusedTopo?.topology_name ?? "No selection"}
              headerRight={
                topologyViewMode && focusedTopo ? (
                  <button
                    type="button"
                    className="danger-ghost-btn"
                    onClick={() => {
                      const ok = window.confirm(`Delete topology "${focusedTopo.topology_name}"?`);
                      if (!ok) return;
                      onDeleteTopology(focusedTopo);
                    }}
                  >
                    Delete topo
                  </button>
                ) : null
              }
            >
              {isTopologyPlayground ? (
                <div className="playground-shell">
                  <TopologyGraph
                    graph={focusedGraph}
                    className="full-graph"
                    interactive
                    showLabels
                    nodeRadius={graphDisplaySettings.node_size}
                    labelSize={graphDisplaySettings.label_size}
                    edgeWidth={graphDisplaySettings.edge_width}
                    edgeColor="#d0d5ea"
                    customEdges={playgroundEdges}
                    nodeFillById={playgroundVisual.fillById}
                    nodeStrokeById={playgroundVisual.strokeById}
                    nodeStrokeWidthById={playgroundVisual.strokeWidthById}
                    clickableNodeIds={playgroundCandidateIds}
                    hoveredNodeId={playgroundPreview?.nodeId ?? null}
                    onNodeHover={setPlaygroundHoverNode}
                    onNodeLeave={clearPlaygroundHoverPreview}
                    onNodeClick={commitPlaygroundNode}
                  />
                  <div className="replay-bar-wrap playground-bar-wrap">
                    <input
                      type="range"
                      min={0}
                      max={playgroundLatestSlot}
                      value={playgroundViewSlot}
                      onChange={(e) => setPlaygroundViewSlot(Number(e.target.value))}
                    />
                    <div className="replay-bar-meta">
                      <span>Timeslot: {playgroundViewSlot}</span>
                      <span>
                        {playgroundActionLocked
                          ? playgroundState?.isComplete
                            ? "Done"
                            : "Viewing history"
                          : `Mode: ${playgroundState?.mode === "receiver" ? "Receiver" : "Broadcaster"}`}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <TopologyGraph
                  graph={focusedGraph}
                  className="full-graph"
                  interactive
                  showLabels
                  nodeRadius={graphDisplaySettings.node_size}
                  labelSize={graphDisplaySettings.label_size}
                  edgeWidth={graphDisplaySettings.edge_width}
                />
              )}
            </FocusedTopologySection>
          ) : focusedBatchId ? (
            <TopologyGridSection
              title={focusedBatch?.batch_name ?? "Batch"}
              headerRight={
                <div className="batch-top-actions">
                  <button
                    type="button"
                    className="secondary-cta"
                    onClick={() => {
                      setModalMode("edit");
                      setModalBatchName(focusedBatch?.batch_name ?? "");
                      setModalOpen(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger-ghost-btn"
                    onClick={() => focusedBatch && onDeleteBatch(focusedBatch.batch_id)}
                  >
                    Delete batch
                  </button>
                </div>
              }
              topologies={topologiesInBatch}
              emptyMessage="No topology available in this batch."
              renderTopologyCard={(topo) => (
                <TopologyCard
                  key={topo.topology_id}
                  topo={topo}
                  selected={selectedTopology?.topology_id === topo.topology_id}
                  graph={graphByTopologyId[topo.topology_id]}
                  onSelect={onOpenTopology}
                  previewShowEdges={previewShowEdges}
                  previewMaxNodes={Math.max(8, Math.ceil((Number(topo?.node_count) || 0) * (Number(previewMaxNodesPercent) || 0) / 100))}
                />
              )}
            />
          ) : (
            <BatchGridSection
              batches={batches}
              renderBatchCard={(batch) => <BatchCard key={batch.batch_id} batch={batch} onOpen={setFocusedBatchId} />}
              extraContent={
                <button
                  type="button"
                  className="batch-grid-card new-batch-card"
                  onClick={() => {
                    setModalMode("create");
                    setModalBatchName("");
                    setModalOpen(true);
                  }}
                >
                  <div className="batch-grid-title">+ New batch</div>
                  <div className="batch-grid-meta">Create a new batch</div>
                </button>
              }
            />
          )}
        </>
      )}
      <BatchModal
        open={modalOpen}
        mode={modalMode}
        value={modalBatchName}
        setValue={setModalBatchName}
        onCancel={() => setModalOpen(false)}
        onConfirm={handleModalConfirm}
      />
      <BatchModal
        open={generateBatchModalOpen}
        mode="create"
        value={generateBatchModalName}
        setValue={setGenerateBatchModalName}
        onCancel={() => setGenerateBatchModalOpen(false)}
        onConfirm={handleGenerateBatchModalConfirm}
      />
      {resultsView ? <QueueOverlay snapshot={queueSnapshot} /> : null}
    </section>
  );
}

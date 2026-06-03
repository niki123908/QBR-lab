import { useMemo, useRef, useState } from "react";
import {
  batchHasPathMetricsData,
  buildBatchDelayScatterCsv,
  buildBatchPathMetricsCsv,
  buildBatchPathMetricsCsvForDensity,
  densityAxisLabel,
  downloadBatchPathMetricsCsv,
  downloadCsvText
} from "../export/batchRunBuilders.js";
import PolicyTraceLineChart from "./PolicyTraceLineChart.jsx";
import {
  buildBatchPolicyTrace,
  buildDensityDelayPathMatrix,
  buildDensityDelayPathMatrixCsv,
  delayPathMatrixCellStyle,
  densityDelayRangeLabel,
  densityLearningMeans,
  downloadAllDensityDelayPathMatrixCsv,
  downloadBatchLearningStatsCsv
} from "../utils/batchResultAnalytics.js";

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }
  return sortedValues[base];
}

function computeBoxStats(values) {
  const nums = values.filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  if (!nums.length) return null;
  return {
    min: nums[0],
    q1: quantile(nums, 0.25),
    median: quantile(nums, 0.5),
    q3: quantile(nums, 0.75),
    max: nums[nums.length - 1]
  };
}

/** Readable numeric ticks between lo..hi for SVG axes. */
export function linearAxisTicks(lo, hi, maxTicks = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi <= lo) return [lo];
  const span = hi - lo;
  const rough = span / Math.max(1, maxTicks - 1);
  const exp = Math.floor(Math.log10(rough));
  const pow10 = 10 ** exp;
  let inc = Math.ceil(rough / pow10) * pow10;
  if (!Number.isFinite(inc) || inc <= 0) inc = span;
  const ticks = [];
  const start = Math.floor(lo / inc) * inc;
  for (let v = start; v <= hi + inc * 0.001; v += inc) {
    if (v >= lo - 1e-9 && v <= hi + 1e-9) {
      const rounded = Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v) : Math.round(v * 1000) / 1000;
      ticks.push(rounded);
    }
  }
  return ticks.length > 0 ? ticks : [lo, hi];
}

/** Y-axis ticks as integers only (for boxplot). */
function linearAxisTicksInteger(lo, hi, maxTicks = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  const loI = Math.floor(lo);
  const hiI = Math.ceil(hi);
  if (hiI <= loI) return [loI];
  const span = hiI - loI;
  const step = Math.max(1, Math.ceil(span / Math.max(1, maxTicks - 1)));
  const ticks = [];
  for (let v = loI; v <= hiI; v += step) {
    ticks.push(v);
  }
  if (ticks[ticks.length - 1] !== hiI) {
    ticks.push(hiI);
  }
  return ticks;
}

const PATH_METRIC_AXIS_MAX = 1000;
const PATH_METRIC_Y_TICKS = [0, 200, 400, 600, 800, 1000];

/** Per-density integer Y domain for compare scatter charts (keyed by node_count label). */
export function scatterYAxisByDensityFromResults(...results) {
  const valueBuckets = new Map();
  results.forEach((result) => {
    (result?.density_groups ?? []).forEach((group) => {
      const key = densityAxisLabel(group);
      if (!valueBuckets.has(key)) valueBuckets.set(key, []);
      const bucket = valueBuckets.get(key);
      (group.topologies ?? []).forEach((topo) => {
        ["last_delay", "best_delay", "lower_bound"].forEach((k) => {
          const n = Number(topo[k]);
          if (Number.isFinite(n)) bucket.push(n);
        });
      });
    });
  });
  const out = {};
  valueBuckets.forEach((vals, key) => {
    if (!vals.length) return;
    const lo = Math.floor(Math.min(...vals));
    const hi = Math.ceil(Math.max(...vals));
    out[key] = { min: lo, max: hi, yTicks: linearAxisTicksInteger(lo, hi, 5) };
  });
  return out;
}

/** Per-density delay-axis from path/episode artifacts (for delay-path matrix tables). */
export function delayAxisByDensityFromResults(...results) {
  const ranges = new Map();
  results.forEach((result) => {
    (result?.density_groups ?? []).forEach((group) => {
      const key = densityAxisLabel(group);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      (group.topologies ?? []).forEach((topo) => {
        const map = topo?.paths_count_by_delay;
        if (map && typeof map === "object") {
          Object.keys(map).forEach((k) => {
            const d = Number(k);
            if (Number.isFinite(d)) {
              min = Math.min(min, d);
              max = Math.max(max, d);
            }
          });
        }
        (topo?.delay_per_episode ?? []).forEach((v) => {
          const d = Number(v);
          if (Number.isFinite(d)) {
            min = Math.min(min, d);
            max = Math.max(max, d);
          }
        });
      });
      if (!Number.isFinite(min) || !Number.isFinite(max)) return;
      const cur = ranges.get(key);
      if (!cur) {
        ranges.set(key, { min, max });
      } else {
        cur.min = Math.min(cur.min, min);
        cur.max = Math.max(cur.max, max);
      }
    });
  });
  const out = {};
  ranges.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Shared integer Y domain for compare mode (union of one or more density_groups arrays). */
export function boxplotYAxisFromDensityGroups(...densityGroupsList) {
  const allValues = [];
  densityGroupsList.forEach((groups) => {
    (groups ?? []).forEach((group) => {
      (group.topologies ?? []).forEach((topo) => {
        ["last_delay", "best_delay", "lower_bound"].forEach((key) => {
          const n = Number(topo[key]);
          if (Number.isFinite(n)) allValues.push(n);
        });
      });
    });
  });
  if (!allValues.length) return null;
  const lo = Math.floor(Math.min(...allValues));
  const hi = Math.ceil(Math.max(...allValues));
  return {
    min: lo,
    max: hi,
    yTicks: linearAxisTicksInteger(lo, hi, 5)
  };
}

function seriesMeanDelay(group, key) {
  const vals = [];
  (group.topologies ?? []).forEach((topo) => {
    const n = Number(topo[key]);
    if (Number.isFinite(n)) vals.push(n);
  });
  if (!vals.length) return null;
  return vals.reduce((sum, v) => sum + v, 0) / vals.length;
}

function BatchSummaryStrip({ result }) {
  return (
    <div className="batch-summary-strip">
      <span>Total: {result?.total_topologies ?? 0}</span>
      <span>Successful: {result?.successful ?? 0}</span>
      <span>Failed: {result?.failed ?? 0}</span>
    </div>
  );
}

export function BatchPolicyTraceCard({ result }) {
  const policyRows = useMemo(() => buildBatchPolicyTrace(result), [result]);
  if (!policyRows?.length) return null;
  return (
    <div className="batch-chart-card batch-policy-trace-card">
      <div className="qtable-header">
        <h4>Policy trace (batch run config)</h4>
        <span className="muted chart-hint">Derived from shared run_config / resolved_run_config — same for all topologies.</span>
      </div>
      <PolicyTraceLineChart rows={policyRows} />
    </div>
  );
}

function BatchLearningMeansChart({ result }) {
  const groups = result?.density_groups ?? [];
  const rows = groups.map((group) => {
    const means = densityLearningMeans(group);
    return {
      label: densityAxisLabel(group),
      meanStates: means.meanStates,
      meanActions: means.meanStateActions,
      stateN: means.stateSampleCount,
      actionN: means.actionSampleCount
    };
  });
  const hasData = rows.some((r) => Number.isFinite(r.meanStates) || Number.isFinite(r.meanActions));
  if (!hasData) {
    return (
      <div className="batch-chart-card">
        <h4>Mean Q-table size by density</h4>
        <p className="muted chart-hint">No learning stats on topology points (run QBR/Greedy with metrics persisted).</p>
      </div>
    );
  }
  const height = 260;
  const pad = { left: 56, right: 24, top: 28, bottom: 48 };
  const plotH = height - pad.top - pad.bottom;
  const colSlot = 120;
  const width = Math.max(400, pad.left + pad.right + rows.length * colSlot);
  const innerW = width - pad.left - pad.right;
  const colW = innerW / Math.max(1, rows.length);
  const valueMax = rows.reduce((max, row) => {
    const candidates = [row.meanStates, row.meanActions].filter((n) => Number.isFinite(n));
    const localMax = candidates.length ? Math.max(...candidates) : 0;
    return Math.max(max, localMax);
  }, 0);
  const yTicks = linearAxisTicksInteger(0, Math.max(1, Math.ceil(valueMax)), 6);
  const axisMax = yTicks.length ? yTicks[yTicks.length - 1] : 1;
  const yBar = (v) => height - pad.bottom - (Math.max(0, v) / axisMax) * plotH;
  const barW = Math.min(28, colW * 0.22);

  return (
    <div className="batch-chart-card">
      <div className="qtable-header">
        <h4>Mean Q-table size by density</h4>
        <div className="qtable-actions">
          <button type="button" className="qtable-sort-btn" title="Download mean states/actions CSV" onClick={() => downloadBatchLearningStatsCsv(result)}>
            CSV
          </button>
        </div>
      </div>
      <p className="muted chart-hint">Average total_states and total_state_actions across topologies in each density group.</p>
      <div className="chart-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} className="batch-chart-svg" preserveAspectRatio="xMidYMid meet">
          <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
          {yTicks.map((tv) => {
            const y = yBar(tv);
            return (
              <g key={`learn-y-${tv}`}>
                <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#e8eaf5" strokeWidth="1" />
                <text x={pad.left - 8} y={y + 4} textAnchor="end" className="chart-axis-text">
                  {tv}
                </text>
              </g>
            );
          })}
          {rows.map((row, idx) => {
            const cx = pad.left + colW * idx + colW / 2;
            const ms = Number.isFinite(row.meanStates) ? row.meanStates : 0;
            const ma = Number.isFinite(row.meanActions) ? row.meanActions : 0;
            return (
              <g key={`${row.label}-${idx}`}>
                <text x={cx} y={height - 14} textAnchor="middle" className="chart-axis-text">
                  {row.label}
                </text>
                <title>{`density ${row.label}: mean states ${ms.toFixed(1)} (n=${row.stateN}), mean actions ${ma.toFixed(1)} (n=${row.actionN})`}</title>
                {Number.isFinite(row.meanStates) ? (
                  <rect x={cx - barW - 2} y={yBar(ms)} width={barW} height={Math.max(1, height - pad.bottom - yBar(ms))} fill="#4E79A7" opacity="0.65" />
                ) : null}
                {Number.isFinite(row.meanActions) ? (
                  <rect x={cx + 2} y={yBar(ma)} width={barW} height={Math.max(1, height - pad.bottom - yBar(ma))} fill="#59A14F" opacity="0.65" />
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-legend-row">
        <span className="chart-legend-item">
          <i style={{ background: "#4E79A7" }} /> mean states
        </span>
        <span className="chart-legend-item">
          <i style={{ background: "#59A14F" }} /> mean state-actions
        </span>
      </div>
    </div>
  );
}

function DensityDelayPathMatrixTable({ group, runLabel, sharedDelayAxis = null }) {
  const matrix = useMemo(() => buildDensityDelayPathMatrix(group, sharedDelayAxis), [group, sharedDelayAxis]);
  if (!matrix.delayColumns.length) return null;
  const safeLabel = String(runLabel ?? "batch").trim().replace(/[\\/:*?"<>|]/g, "-");

  const downloadMatrixCsv = () => {
    const csv = buildDensityDelayPathMatrixCsv(group);
    downloadCsvText(csv, `delay_path_matrix_density_${densityAxisLabel(group)}_${safeLabel}.csv`);
  };

  return (
    <div className="batch-chart-card batch-chart-card--nested">
      <div className="qtable-header">
        <h5 className="batch-chart-subtitle">Paths count by delay</h5>
        <div className="qtable-actions">
          <button type="button" className="qtable-sort-btn" title="Download delay × path count matrix CSV" onClick={downloadMatrixCsv}>
            CSV
          </button>
        </div>
      </div>
      <p className="muted chart-hint">
        Unique path signatures per finished delay (from run bundle). Delay range for density: <strong>{matrix.delayRange}</strong>.
        Colored cells: red near each topology&apos;s lower bound, blue farther away; darkest red = most paths for that topo. Empty gray = 0 paths.
      </p>
      <div className="batch-delay-path-table-wrap">
        <table className="batch-delay-path-table">
          <thead>
            <tr>
              <th>Delay</th>
              {matrix.topologies.map((topo) => (
                <th key={`h-${topo.topology_index}`} title={topo.topology_id || topo.topology_name || undefined}>
                  {topo.topology_index}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={`delay-${row.delay}`}>
                <td>{row.delay}</td>
                {matrix.topologies.map((topo) => {
                  const count = row.cells[topo.topology_index] ?? 0;
                  const cellStyle = delayPathMatrixCellStyle({
                    delay: row.delay,
                    lowerBound: topo.lower_bound,
                    maxDist: topo.maxDistFromLowerBound,
                    maxPathCount: topo.maxPathCount,
                    count
                  });
                  return (
                    <td
                      key={`${row.delay}-${topo.topology_index}`}
                      className={cellStyle.className}
                      style={
                        cellStyle.backgroundColor
                          ? { backgroundColor: cellStyle.backgroundColor, color: cellStyle.color }
                          : undefined
                      }
                      title={
                        cellStyle.showValue
                          ? `${count} paths @ delay ${row.delay} (topo ${topo.topology_index}, LB ${topo.lower_bound ?? "—"}${cellStyle.isPeak ? ", peak paths" : ""})`
                          : undefined
                      }
                    >
                      {cellStyle.showValue ? count : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DensityLearningMeansStrip({ group }) {
  const means = densityLearningMeans(group);
  if (!means.stateSampleCount && !means.actionSampleCount) return null;
  return (
    <div className="batch-density-learning-strip muted">
      <span>
        Mean states: {Number.isFinite(means.meanStates) ? means.meanStates.toFixed(1) : "—"} ({means.stateSampleCount} topo)
      </span>
      <span>
        Mean state-actions: {Number.isFinite(means.meanStateActions) ? means.meanStateActions.toFixed(1) : "—"} ({means.actionSampleCount}{" "}
        topo)
      </span>
      <span>Delay range: {densityDelayRangeLabel(group)}</span>
    </div>
  );
}

function DensityBoxplotChart({ densityGroups, yAxis, fitWidth = false }) {
  const rows = (densityGroups ?? []).filter((item) => (item.topologies ?? []).length > 0);
  if (!rows.length) return <div className="empty-topology-state">No density data.</div>;

  const height = 300;
  const pad = { left: 62, right: 24, top: 36, bottom: 40 };
  const plotH = height - pad.top - pad.bottom;
  const allValues = [];
  rows.forEach((group) => {
    group.topologies.forEach((topo) => {
      [topo.last_delay, topo.best_delay, topo.lower_bound].forEach((v) => {
        if (Number.isFinite(v)) allValues.push(v);
      });
    });
  });
  if (!allValues.length) return <div className="empty-topology-state">No delay values.</div>;
  const localMin = Math.min(...allValues);
  const localMax = Math.max(...allValues);
  const domainMin = yAxis?.min ?? Math.floor(localMin);
  const domainMax = yAxis?.max ?? Math.ceil(localMax);
  const span = domainMax - domainMin || 1;
  const yOf = (v) => height - pad.bottom - ((v - domainMin) / span) * plotH;
  const yTicks = yAxis?.yTicks ?? linearAxisTicksInteger(domainMin, domainMax, 5);
  const colSlot = fitWidth ? 100 : 180;
  const width = fitWidth
    ? Math.max(240, pad.left + pad.right + rows.length * colSlot)
    : Math.max(680, rows.length * colSlot);
  const series = [
    { key: "last_delay", label: "last_delay", color: "#4E79A7", offset: -26 },
    { key: "best_delay", label: "best_delay", color: "#59A14F", offset: 0 },
    { key: "lower_bound", label: "lower_bound", color: "#E15759", offset: 26 }
  ];
  const colW = (width - pad.left - pad.right) / Math.max(1, rows.length);

  return (
    <div className="batch-chart-card">
      <h4>Block A - Density Summary (Boxplot)</h4>
      <div className={`chart-scroll${fitWidth ? " chart-scroll--fit" : ""}`}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className={`batch-chart-svg${fitWidth ? " batch-chart-svg--fit" : ""}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
          <text
            x={18}
            y={pad.top + plotH / 2}
            className="chart-axis-text chart-axis-ylabel"
            transform={`rotate(-90 18 ${pad.top + plotH / 2})`}
            textAnchor="middle"
          >
            Delay (timeslots)
          </text>
          {yTicks.map((tv) => {
            const y = yOf(tv);
            return (
              <g key={`y-${tv}`}>
                <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#e8eaf5" strokeWidth="1" />
                <text x={pad.left - 8} y={y + 4} textAnchor="end" className="chart-axis-text">
                  {tv}
                </text>
              </g>
            );
          })}
          {rows.map((group, idx) => {
            const cx = pad.left + colW * idx + colW / 2;
            const label = Number(group.node_count) > 0 ? group.node_count : "?";
            return (
              <g key={`${group.node_count}-${idx}`}>
                <text x={cx} y={height - 14} textAnchor="middle" className="chart-axis-text">
                  {label}
                </text>
                <title>{`density (node_count): ${label}`}</title>
                {series.map((s) => {
                  const stats = computeBoxStats(group.topologies.map((t) => Number(t[s.key])));
                  if (!stats) return null;
                  const x = cx + s.offset;
                  const meanV = seriesMeanDelay(group, s.key);
                  const boxW = 16;
                  return (
                    <g key={`${group.node_count}-${s.key}-${idx}`}>
                      {Number.isFinite(meanV) ? (
                        <g transform={`translate(${x} ${yOf(meanV)})`} className="boxplot-mean-mark">
                          <title>{meanV.toFixed(2)}</title>
                          <line x1={-4} y1={-4} x2={4} y2={4} stroke={s.color} strokeWidth="1.4" />
                          <line x1={-4} y1={4} x2={4} y2={-4} stroke={s.color} strokeWidth="1.4" />
                        </g>
                      ) : null}
                      <line x1={x} x2={x} y1={yOf(stats.min)} y2={yOf(stats.max)} stroke={s.color} strokeWidth="1.2" />
                      <rect
                        x={x - boxW / 2}
                        y={yOf(stats.q3)}
                        width={boxW}
                        height={Math.max(1, yOf(stats.q1) - yOf(stats.q3))}
                        fill={s.color}
                        fillOpacity="0.2"
                        stroke={s.color}
                      />
                      <line x1={x - boxW / 2} x2={x + boxW / 2} y1={yOf(stats.median)} y2={yOf(stats.median)} stroke={s.color} />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-legend-row">
        {series.map((s) => (
          <span key={s.key} className="chart-legend-item">
            <i style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export { densityAxisLabel, batchHasPathMetricsData, downloadBatchPathMetricsCsv, buildBatchPathMetricsCsv };

const DELAY_SCATTER_SERIES = [
  { key: "last_delay", label: "last_delay", color: "#4E79A7" },
  { key: "best_delay", label: "best_delay", color: "#59A14F" },
  { key: "lower_bound", label: "lower_bound", color: "#E15759" }
];

function isBestEqLastTopo(p) {
  const best = Number(p.best_delay);
  const last = Number(p.last_delay);
  return Number.isFinite(best) && Number.isFinite(last) && Math.abs(best - last) <= 1e-9;
}

function DensityDelayScatterChart({ group, runLabel, yAxis, fitWidth = false }) {
  const [showLowerBound, setShowLowerBound] = useState(true);
  const [hideBestEqLast, setHideBestEqLast] = useState(false);
  const svgRef = useRef(null);
  const points = group.topologies ?? [];

  if (!points.length) return <div className="empty-topology-state">No topologies in this density.</div>;

  const delayValues = [];
  points.forEach((p) => [p.last_delay, p.best_delay, p.lower_bound].forEach((v) => Number.isFinite(v) && delayValues.push(v)));
  const localMin = delayValues.length ? Math.min(...delayValues) : 0;
  const localMax = delayValues.length ? Math.max(...delayValues) : 1;
  const domainMin = yAxis?.min ?? Math.floor(localMin);
  const domainMax = yAxis?.max ?? Math.ceil(localMax);
  const spanD = domainMax - domainMin || 1;
  const scatterH = 300;
  const pad = { left: 64, right: 24, top: 36, bottom: 42 };
  const slotW = fitWidth ? Math.max(24, Math.min(36, Math.floor(360 / Math.max(1, points.length)))) : 56;
  const scatterW = fitWidth
    ? Math.max(240, pad.left + pad.right + points.length * slotW)
    : Math.max(680, points.length * 56);
  const plotH = scatterH - pad.top - pad.bottom;
  const innerW = scatterW - pad.left - pad.right;
  const slotUnit = innerW / Math.max(1, points.length);
  const xBase = (idx) => pad.left + slotUnit * idx + slotUnit / 2;
  const yOf = (v) => scatterH - pad.bottom - ((v - domainMin) / spanD) * plotH;
  const yTicksDelay = yAxis?.yTicks ?? linearAxisTicksInteger(domainMin, domainMax, 5);
  const densityLabel = densityAxisLabel(group);
  const safeRunLabel = String(runLabel ?? "run")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ");

  const downloadDelayScatterCsv = () => {
    const csv = buildBatchDelayScatterCsv(points);
    downloadCsvText(csv, `delay_scatter_density_${String(group?.density_key ?? densityAxisLabel(group))}.csv`);
  };

  const downloadDelayScatterJpg = () => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const viewBox = svgEl.getAttribute("viewBox") || "";
    const parts = viewBox.split(/[ ,]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n));
    const vbW = parts.length >= 3 ? parts[2] : scatterW;
    const vbH = parts.length >= 3 ? parts[3] : scatterH;

    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svgEl);
    if (!source.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
      source = source.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      try {
        const scale = 2;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(vbW * scale));
        canvas.height = Math.max(1, Math.floor(vbH * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            if (!blob) return;
            const jpgUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = jpgUrl;
            link.download = `${safeRunLabel} delay ${String(densityLabel)}.jpg`;
            link.click();
            URL.revokeObjectURL(jpgUrl);
          },
          "image/jpeg",
          0.95
        );
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  return (
    <div className="batch-chart-card batch-chart-card--nested">
      <div className="qtable-header">
        <h5 className="batch-chart-subtitle">Delay by topology index</h5>
        <div className="qtable-actions">
          <button
            type="button"
            className={`qtable-sort-btn qtable-toggle-btn${hideBestEqLast ? " is-on" : ""}`}
            title="Hide delay markers (keep index) when best equals last"
            onClick={() => setHideBestEqLast((on) => !on)}
          >
            Best = last
          </button>
          <button
            type="button"
            className={`qtable-sort-btn qtable-toggle-btn${showLowerBound ? " is-on" : ""}`}
            title="Show or hide lower bound markers"
            onClick={() => setShowLowerBound((on) => !on)}
          >
            Lower bound
          </button>
          <button type="button" className="qtable-sort-btn" title="Download delay scatter CSV" onClick={downloadDelayScatterCsv}>
            CSV
          </button>
          <button type="button" className="qtable-sort-btn" title="Download delay scatter JPG" onClick={downloadDelayScatterJpg}>
            JPG
          </button>
        </div>
      </div>
      <p className="muted chart-hint">
        Dumbbell per topology: vertical segment between best (green) and last (blue). Red diamond = lower bound when enabled.
        Toggle <strong>Best = last</strong> to hide markers where best and last delay match (topology index stays).
      </p>
      <div className={`chart-scroll${fitWidth ? " chart-scroll--fit" : ""}`}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${scatterW} ${scatterH}`}
          className={`batch-chart-svg${fitWidth ? " batch-chart-svg--fit" : ""}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <rect x="0" y="0" width={scatterW} height={scatterH} fill="#fbfbff" />
          <text
            x={20}
            y={pad.top + plotH / 2}
            className="chart-axis-text chart-axis-ylabel"
            transform={`rotate(-90 20 ${pad.top + plotH / 2})`}
            textAnchor="middle"
          >
            Delay (timeslots)
          </text>
          {yTicksDelay.map((tv) => {
            const y = yOf(tv);
            return (
              <g key={`dly-${tv}`}>
                <line x1={pad.left} x2={scatterW - pad.right} y1={y} y2={y} stroke="#e8eaf5" strokeWidth="1" />
                <text x={pad.left - 8} y={y + 4} textAnchor="end" className="chart-axis-text">
                  {tv}
                </text>
              </g>
            );
          })}
          {points.map((p, idx) => {
            const x = xBase(idx);
            const hidden = hideBestEqLast && isBestEqLastTopo(p);
            const best = Number(p.best_delay);
            const last = Number(p.last_delay);
            const lower = Number(p.lower_bound);
            const hasBest = Number.isFinite(best);
            const hasLast = Number.isFinite(last);
            const hasLower = !hidden && showLowerBound && Number.isFinite(lower);
            const tip = hidden
              ? `topology ${Number.isFinite(Number(p.topology_index)) ? p.topology_index : idx} (best = last, hidden)`
              : [
                  `topology ${Number.isFinite(Number(p.topology_index)) ? p.topology_index : idx}`,
                  hasBest ? `best: ${best}` : null,
                  hasLast ? `last: ${last}` : null,
                  hasLower ? `lower: ${lower}` : null
                ]
                  .filter(Boolean)
                  .join(" · ");

            return (
              <g key={`${p.topology_id}-${idx}`}>
                <title>{tip}</title>
                <text
                  x={x}
                  y={scatterH - 14}
                  textAnchor="middle"
                  className={`chart-axis-text${hidden ? " batch-delay-scatter-index--muted" : ""}`}
                >
                  {Number.isFinite(Number(p.topology_index)) ? Number(p.topology_index) : idx}
                </text>
                {hidden ? null : (
                  <>
                {hasBest && hasLast && Math.abs(best - last) > 1e-9 ? (
                  <line
                    x1={x}
                    x2={x}
                    y1={yOf(best)}
                    y2={yOf(last)}
                    stroke="#b8bdd6"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                ) : null}
                {hasBest ? <circle cx={x} cy={yOf(best)} r="4.5" fill="#59A14F" stroke="#fff" strokeWidth="1" /> : null}
                {hasLast ? <circle cx={x} cy={yOf(last)} r="4.5" fill="#4E79A7" stroke="#fff" strokeWidth="1" /> : null}
                {hasLower ? (
                  <path
                    d={`M ${x} ${yOf(lower) - 5} L ${x + 5} ${yOf(lower)} L ${x} ${yOf(lower) + 5} L ${x - 5} ${yOf(lower)} Z`}
                    fill="#E15759"
                    stroke="#fff"
                    strokeWidth="1"
                  />
                ) : null}
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-legend-row">
        {DELAY_SCATTER_SERIES.filter((s) => s.key !== "lower_bound" || showLowerBound).map((s) => (
          <span key={s.key} className="chart-legend-item">
            <i style={{ background: s.color }} /> {s.label}
          </span>
        ))}
        <span className="chart-legend-item muted">segment = best↔last gap</span>
      </div>
    </div>
  );
}

function DensityPathMetricChart({ group, runLabel, bestDelayOverlayOpacity = 1, fitWidth = false }) {
  const points = group.topologies ?? [];
  if (!points.length) return <div className="empty-topology-state">No topologies in this density.</div>;

  const pathH = 280;
  const pathPad = { left: 52, right: 52, top: 22, bottom: 42 };
  const axisMax = PATH_METRIC_AXIS_MAX;
  const yTicksPath = PATH_METRIC_Y_TICKS;
  const slotW = fitWidth ? Math.max(24, Math.min(36, Math.floor(360 / Math.max(1, points.length)))) : 56;
  const pathW = fitWidth
    ? Math.max(240, pathPad.left + pathPad.right + points.length * slotW)
    : Math.max(680, points.length * 56);
  const pathInnerW = pathW - pathPad.left - pathPad.right;
  const pathPlotH = pathH - pathPad.top - pathPad.bottom;
  const pathSlotUnit = pathInnerW / Math.max(1, points.length);
  const pathX = (idx) => pathPad.left + pathSlotUnit * idx + pathSlotUnit / 2;

  const clampAxis = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(axisMax, n));
  };
  const yBar = (v) => pathH - pathPad.bottom - (clampAxis(v) / axisMax) * pathPlotH;
  const hasPathArtifactData = points.some((p) => Number.isFinite(p.unique_path_count));
  const svgRef = useRef(null);
  const densityLabel = densityAxisLabel(group);
  const safeRunLabel = String(runLabel ?? "run")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ");
  const downloadPathMetricsCsv = () => {
    const csv = buildBatchPathMetricsCsvForDensity(group);
    downloadCsvText(csv, `path_metrics_density_${densityAxisLabel(group)}.csv`);
  };

  const downloadPathMetricsJpg = () => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const viewBox = svgEl.getAttribute("viewBox") || "";
    const parts = viewBox.split(/[ ,]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n));
    const vbW = parts.length >= 3 ? parts[2] : 800;
    const vbH = parts.length >= 3 ? parts[3] : 280;

    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svgEl);
    if (!source.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
      source = source.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      try {
        const scale = 2; // improve readability
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(vbW * scale));
        canvas.height = Math.max(1, Math.floor(vbH * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            if (!blob) return;
            const jpgUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = jpgUrl;
            link.download = `${safeRunLabel} ${String(densityLabel)}.jpg`;
            link.click();
            URL.revokeObjectURL(jpgUrl);
          },
          "image/jpeg",
          0.95
        );
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  return (
    <div className="batch-chart-card batch-chart-card--nested">
      <div className="qtable-header">
        <h5 className="batch-chart-subtitle">Path metrics</h5>
        <div className="qtable-actions">
          <button type="button" className="qtable-sort-btn" title="Download path metrics CSV" onClick={downloadPathMetricsCsv}>
            CSV
          </button>
          <button type="button" className="qtable-sort-btn" title="Download path metrics JPG" onClick={downloadPathMetricsJpg}>
            JPG
          </button>
        </div>
      </div>
      {!hasPathArtifactData ? (
        <p className="muted chart-hint">
          No path CSV data (need <code>path_signatures</code> + <code>delay_per_episode</code>). Enable <strong>Path signature</strong> for
          batch runs or full artifacts.
        </p>
      ) : null}
      <div className={`chart-scroll${fitWidth ? " chart-scroll--fit" : ""}`}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${pathW} ${pathH}`}
          className={`batch-chart-svg batch-chart-svg--dual${fitWidth ? " batch-chart-svg--fit" : ""}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <rect x="0" y="0" width={pathW} height={pathH} fill="#fbfbff" />
          <text x="8" y={pathPad.top + 4} className="chart-axis-text" dominantBaseline="hanging">
            path count
          </text>
          {yTicksPath.map((vb) => {
            const y = yBar(vb);
            return (
              <g key={`bar-tick-${vb}`}>
                <line x1={pathPad.left - 4} x2={pathW - pathPad.right} y1={y} y2={y} stroke="#e8eaf5" strokeWidth="1" />
                <text x={pathPad.left - 8} y={y + 3} textAnchor="end" className="chart-axis-text">
                  {vb}
                </text>
              </g>
            );
          })}
          {points.map((p, idx) => {
            const x = pathX(idx);
            const rawPath = Number.isFinite(p.unique_path_count) ? p.unique_path_count : 0;
            const rawBest = Number.isFinite(p.best_delay_unique_path_count) ? p.best_delay_unique_path_count : 0;
            const vPath = clampAxis(rawPath);
            const vBest = clampAxis(rawBest);
            const bestTop = yBar(vBest);
            const slotW = Math.max(12, pathSlotUnit * 0.7);
            const barW = Math.max(10, slotW * 0.38);
            const barX = x - barW / 2;
            const pathTop = yBar(vPath);
            const pathHeight = Math.max(1, pathH - pathPad.bottom - pathTop);
            const bestHeight = Math.max(1, pathH - pathPad.bottom - bestTop);
            return (
              <g key={`${p.topology_id}-path-${idx}`}>
                <text x={x} y={pathH - 14} textAnchor="middle" className="chart-axis-text">
                  {Number.isFinite(Number(p.topology_index)) ? Number(p.topology_index) : idx}
                </text>
                <g>
                  <title>{`path count: ${p.unique_path_count ?? "—"}`}</title>
                  <rect
                    x={barX}
                    y={pathTop}
                    width={barW}
                    height={pathHeight}
                    fill="#4E79A7"
                    opacity="0.5"
                  />
                </g>
                <g>
                  <title>{`best delay unique path count: ${p.best_delay_unique_path_count ?? "—"}`}</title>
                  {vBest > 0 ? (
                    <rect
                      x={barX}
                      y={bestTop}
                      width={barW}
                      height={bestHeight}
                      fill="#E15759"
                      opacity={Math.max(0, Math.min(1, Number(bestDelayOverlayOpacity) || 0))}
                    />
                  ) : null}
                </g>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-legend-row">
        <span className="chart-legend-item">
          <i style={{ background: "#4E79A7" }} /> path count
        </span>
        <span className="chart-legend-item">
          <i style={{ background: "#E15759" }} /> best delay unique path count
        </span>
      </div>
    </div>
  );
}

export function MiniDelayPerEpisodeChart({ point }) {
  const series = Array.isArray(point?.delay_per_episode) ? point.delay_per_episode.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  if (!series.length) return null;
  const highlightStableBest =
    Number.isFinite(Number(point?.last_delay)) &&
    Number.isFinite(Number(point?.best_delay)) &&
    Number(point.last_delay) === Number(point.best_delay);
  const width = 220;
  const height = 108;
  const padL = 16;
  const padR = 10;
  const padT = 10;
  const padB = 18;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const points = series
    .map((value, index) => {
      const x = padL + (index / Math.max(1, series.length - 1)) * plotW;
      const y = padT + plotH - ((value - min) / span) * plotH;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div
      className={`mini-delay-chart-card ${highlightStableBest ? "stable-best" : ""}`}
      title={point.topology_name}
    >
      <div className="mini-delay-chart-header">
        <span className="mini-delay-chart-title">{point.topology_name}</span>
        <span
          className="mini-delay-chart-meta"
          title={point.topology_id ? `Topology index ${point.topology_index} · ${point.topology_id}` : ""}
        >
          {Number.isFinite(Number(point.topology_index)) ? point.topology_index : "-"}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mini-delay-chart-svg">
        <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
        <polyline points={points} fill="none" stroke="#7e6df2" strokeWidth="2" />
      </svg>
      <div className="mini-delay-chart-footer">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function DensityDelayPerEpisodeGrid({ group }) {
  const points = (group.topologies ?? []).filter((point) => Array.isArray(point.delay_per_episode) && point.delay_per_episode.length > 0);
  if (!points.length) return null;
  return (
    <div className="batch-chart-card batch-chart-card--nested">
      <div className="qtable-header">
        <h5 className="batch-chart-subtitle">Delay per episode</h5>
      </div>
      <div className="mini-delay-chart-grid">
        {points.map((point) => (
          <MiniDelayPerEpisodeChart key={`${point.topology_id}-delay-mini`} point={point} />
        ))}
      </div>
    </div>
  );
}

function BatchDensityBlockCard({
  group,
  artifactFilter,
  runLabel,
  bestDelayOverlayOpacity,
  scatterYAxis,
  delayAxis,
  scatterFitWidth,
  pathFitWidth
}) {
  const showDelayScatter = artifactFilter === "all" || artifactFilter === "delay";
  const showPathMetrics = artifactFilter === "all" || artifactFilter === "path";
  const showDelayPerEpisode = artifactFilter === "all" || artifactFilter === "delay_episode";
  const dLabel = densityAxisLabel(group);

  return (
    <div className="batch-density-block-card">
      <h4 className="batch-density-block-title">
        Density <span className="batch-density-num">{dLabel}</span> nodes
      </h4>
      <DensityLearningMeansStrip group={group} />
      {showDelayScatter ? (
        <DensityDelayScatterChart
          group={group}
          runLabel={runLabel}
          yAxis={scatterYAxis}
          fitWidth={scatterFitWidth}
        />
      ) : null}
      {showPathMetrics ? (
        <DensityPathMetricChart
          group={group}
          runLabel={runLabel}
          bestDelayOverlayOpacity={bestDelayOverlayOpacity}
          fitWidth={pathFitWidth}
        />
      ) : null}
      {showDelayPerEpisode ? <DensityDelayPerEpisodeGrid group={group} /> : null}
      <DensityDelayPathMatrixTable group={group} runLabel={runLabel} sharedDelayAxis={delayAxis} />
    </div>
  );
}

export default function BatchResultDetailBody({
  result,
  artifactFilter,
  onArtifactFilterChange,
  bestDelayOverlayOpacity = 1,
  showArtifactFilter = true,
  compact = false,
  boxplotYAxis = null,
  boxplotFitWidth = false,
  scatterYAxisByDensity = null,
  delayAxisByDensity = null
}) {
  if (!result) return null;
  const topologies = result.topologies ?? [];
  if (!topologies.length) {
    return <div className="empty-topology-state">No topology with results in this batch run.</div>;
  }
  return (
    <>
      <BatchSummaryStrip result={result} />
      <BatchLearningMeansChart result={result} />
      <div className="batch-path-metrics-download-row">
        <button
          type="button"
          className="secondary-cta small"
          title="Download delay × path count tables for all densities"
          onClick={() => downloadAllDensityDelayPathMatrixCsv(result)}
        >
          Download delay × path matrix CSV (all densities)
        </button>
      </div>
      <DensityBoxplotChart
        densityGroups={result.density_groups}
        yAxis={boxplotYAxis}
        fitWidth={boxplotFitWidth}
      />
      <div className="batch-path-metrics-download-row">
        <button
          type="button"
          className="secondary-cta small"
          disabled={!batchHasPathMetricsData(result)}
          title={
            batchHasPathMetricsData(result)
              ? "Download path metrics for every topology in this batch run"
              : "No path metrics (enable Path signature + delay_per_episode artifacts)"
          }
          onClick={() => downloadBatchPathMetricsCsv(result)}
        >
          Download path metrics CSV (all topologies)
        </button>
      </div>
      {showArtifactFilter ? (
        <div className="results-graph-controls batch-artifact-filter-row">
          <span className="field-label-span">Charts to show per density:</span>
          <div className="segmented-toggle segmented-toggle--dense">
            {[
              { k: "all", label: "All" },
              { k: "delay", label: "Delay only" },
              { k: "path", label: "Path metrics only" },
              { k: "delay_episode", label: "Delay per episode only" }
            ].map(({ k, label }) => (
              <button
                key={k}
                type="button"
                className={`segment-btn ${artifactFilter === k ? "active" : ""}`}
                onClick={() => onArtifactFilterChange?.(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className={`batch-density-blocks${compact ? " batch-density-blocks--compact" : ""}`}>
        {(result.density_groups ?? []).map((grp, idx) => (
          <BatchDensityBlockCard
            key={`${String(grp.node_count)}-${idx}`}
            group={grp}
            artifactFilter={artifactFilter}
            runLabel={result?.result_label}
            bestDelayOverlayOpacity={bestDelayOverlayOpacity}
            scatterYAxis={scatterYAxisByDensity?.[densityAxisLabel(grp)] ?? null}
            delayAxis={delayAxisByDensity?.[densityAxisLabel(grp)] ?? null}
            scatterFitWidth={boxplotFitWidth}
            pathFitWidth={boxplotFitWidth}
          />
        ))}
      </div>
    </>
  );
}

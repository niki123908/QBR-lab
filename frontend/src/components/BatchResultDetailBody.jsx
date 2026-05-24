import { useRef, useState } from "react";

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

function densityAxisLabel(group) {
  const n = Number(group?.node_count);
  return Number.isFinite(n) && n > 0 ? n : "?";
}

const DELAY_SCATTER_SERIES = [
  { key: "last_delay", label: "last_delay", color: "#4E79A7" },
  { key: "best_delay", label: "best_delay", color: "#59A14F" },
  { key: "lower_bound", label: "lower_bound", color: "#E15759" }
];

function DensityDelayScatterChart({ group, runLabel, yAxis, fitWidth = false }) {
  const [showLowerBound, setShowLowerBound] = useState(true);
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
  const svgRef = useRef(null);
  const densityLabel = densityAxisLabel(group);
  const safeRunLabel = String(runLabel ?? "run")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ");

  const downloadDelayScatterCsv = () => {
    const lines = [
      "topology_index,topology_id,last_delay,best_delay,lower_bound",
      ...points.map(
        (p, idx) =>
          `${Number.isFinite(Number(p.topology_index)) ? Number(p.topology_index) : idx},${String(p.topology_id ?? "")},${String(
            p.last_delay ?? ""
          )},${String(p.best_delay ?? "")},${String(p.lower_bound ?? "")}`
      )
    ].join("\n");
    const blob = new Blob([lines], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `delay_scatter_density_${String(group?.density_key ?? "all")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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
            const best = Number(p.best_delay);
            const last = Number(p.last_delay);
            const lower = Number(p.lower_bound);
            const hasBest = Number.isFinite(best);
            const hasLast = Number.isFinite(last);
            const hasLower = showLowerBound && Number.isFinite(lower);
            const tip = [
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
                <text x={x} y={scatterH - 14} textAnchor="middle" className="chart-axis-text">
                  {Number.isFinite(Number(p.topology_index)) ? Number(p.topology_index) : idx}
                </text>
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
    const lines = [
      "topology_index,topology_id,unique_path_count,best_delay_unique_path_count",
      ...points.map(
        (p, idx) =>
          `${Number.isFinite(Number(p.topology_index)) ? Number(p.topology_index) : idx},${String(p.topology_id ?? "")},${String(p.unique_path_count ?? "")},${String(
            p.best_delay_unique_path_count ?? ""
          )}`
      )
    ].join("\n");
    const blob = new Blob([lines], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `path_metrics_density_${String(group?.density_key ?? "all")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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
  scatterFitWidth,
  pathFitWidth
}) {
  const showDelayScatter = artifactFilter === "all" || artifactFilter === "delay";
  const showPathMetrics = artifactFilter === "all" || artifactFilter === "path";
  const showDelayPerEpisode =
    artifactFilter === "all" || artifactFilter === "path" || artifactFilter === "delay_episode";
  const dLabel = densityAxisLabel(group);

  return (
    <div className="batch-density-block-card">
      <h4 className="batch-density-block-title">
        Density <span className="batch-density-num">{dLabel}</span> nodes
      </h4>
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
  scatterYAxisByDensity = null
}) {
  if (!result) return null;
  const topologies = result.topologies ?? [];
  if (!topologies.length) {
    return <div className="empty-topology-state">No topology with results in this batch run.</div>;
  }
  return (
    <>
      <BatchSummaryStrip result={result} />
      <DensityBoxplotChart
        densityGroups={result.density_groups}
        yAxis={boxplotYAxis}
        fitWidth={boxplotFitWidth}
      />
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
            scatterFitWidth={boxplotFitWidth}
            pathFitWidth={boxplotFitWidth}
          />
        ))}
      </div>
    </>
  );
}

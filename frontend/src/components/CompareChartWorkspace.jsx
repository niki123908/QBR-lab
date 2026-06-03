import { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { buildCompareMetricCatalog } from "../utils/compareChartMetrics.js";
import {
  QUAD_COMPARE_SIDES,
  SIDE_COLORS,
  normalizeCompareChartInput,
  activeSideIds
} from "../utils/compareChartSides.js";
import { buildDensityMeanRows, buildDensityPairs, buildPerDensityChartRows } from "../utils/compareChartTransforms.js";

async function fetchBatchResultDetail(apiBase, batchRunId) {
  const response = await fetch(`${apiBase}/runs/batch/${batchRunId}/result`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || "Could not load batch result.");
  }
  return data;
}

function emptyBatchIds(sideIds) {
  return Object.fromEntries(sideIds.map((sideId) => [sideId, ""]));
}
const FIXED_GROUP_PATH = ["unique_path_count", "best_delay_unique_path_count"];
const FIXED_GROUP_DELAY = ["best_delay", "last_delay", "lower_bound"];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function valueTick(value) {
  if (!Number.isFinite(Number(value))) return "";
  const n = Number(value);
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function metricColor(metricKey, side) {
  const key = String(metricKey || "");
  const family = SIDE_COLORS[side] ?? SIDE_COLORS.A;
  if (key === "lower_bound" && side === "AB") return "#9333EA";
  if (key === "unique_path_count") return family.light;
  if (key === "best_delay_unique_path_count") return family.dark;
  if (key.includes("best")) return family.dark;
  if (key.includes("last")) return family.main;
  return family.light;
}

function buildMarkerByMetric(metricKeys) {
  const shapes = ["circle", "cross", "triangle", "diamond", "square"];
  const out = {};
  metricKeys.forEach((key, idx) => {
    out[key] = shapes[idx % shapes.length];
  });
  return out;
}

function MetricDot({ cx, cy, stroke, fill, shape = "circle" }) {
  const x = Number(cx);
  const y = Number(cy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const color = stroke || fill || "#333";
  if (shape === "cross") {
    return (
      <g>
        <line x1={x - 4} y1={y - 4} x2={x + 4} y2={y + 4} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
        <line x1={x - 4} y1={y + 4} x2={x + 4} y2={y - 4} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      </g>
    );
  }
  if (shape === "triangle") {
    return <path d={`M ${x} ${y - 5} L ${x + 5} ${y + 4} L ${x - 5} ${y + 4} Z`} fill={color} fillOpacity={0.7} stroke={color} strokeOpacity={0.7} strokeWidth={1} />;
  }
  if (shape === "diamond") {
    return <path d={`M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z`} fill={color} fillOpacity={0.7} stroke={color} strokeOpacity={0.7} strokeWidth={1} />;
  }
  if (shape === "square") {
    return <rect x={x - 4} y={y - 4} width={8} height={8} fill={color} fillOpacity={0.7} stroke={color} strokeOpacity={0.7} strokeWidth={1} />;
  }
  return <circle cx={x} cy={y} r={4} fill={color} fillOpacity={0.7} stroke={color} strokeOpacity={0.7} strokeWidth={1} />;
}

function seriesDefs(metricKeys, catalogMap, sideIds, sideLabelsById) {
  const defs = [];
  const useSharedLowerBound = sideIds.length === 2 && metricKeys.includes("lower_bound");

  metricKeys.forEach((key) => {
    const metric = catalogMap.get(key);
    if (!metric) return;

    if (key === "lower_bound" && useSharedLowerBound) {
      defs.push({
        dataKey: "AB__lower_bound",
        metricKey: key,
        side: "AB",
        name: `${metric.label} (shared)`,
        color: metricColor(key, "AB")
      });
      return;
    }

    sideIds.forEach((sideId) => {
      const sideLabel = sideLabelsById?.[sideId] || sideId;
      const suffix = key === "convergence_count" ? "convergence count (%)" : metric.label;
      defs.push({
        dataKey: `${sideId}__${key}`,
        metricKey: key,
        side: sideId,
        name: `${sideLabel} · ${suffix}`,
        color: metricColor(key, sideId)
      });
    });
  });

  return defs;
}

function withLeadingZeroRow(rows, xKey, defs) {
  if (!rows.length) return rows;
  const firstX = Number(rows[0]?.[xKey]);
  if (!Number.isFinite(firstX) || firstX <= 0) return rows;
  const row = { ...rows[0], [xKey]: 0 };
  defs.forEach((def) => {
    row[def.dataKey] = null;
  });
  return [row, ...rows];
}

function axisDomainForBar(rows, defs, yPaddingPct = 8) {
  const values = [];
  defs.forEach((def) => {
    rows.forEach((row) => {
      const n = Number(row[def.dataKey]);
      if (Number.isFinite(n)) values.push(n);
    });
  });
  if (!values.length) return [0, 1];
  const dataMax = Math.max(0, Math.max(...values));
  const pad = dataMax * (Math.max(0, Number(yPaddingPct) || 0) / 100);
  return [0, dataMax + pad];
}

function axisDomainForLine(rows, defs, yPaddingPct = 8) {
  const values = [];
  defs.forEach((def) => {
    rows.forEach((row) => {
      const n = Number(row[def.dataKey]);
      if (Number.isFinite(n)) values.push(n);
    });
  });
  if (!values.length) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1e-9, max - min);
  const pad = span * (Math.max(0, Number(yPaddingPct) || 0) / 100);
  const lo = 0;
  const hi = Math.ceil(max + pad);
  return [lo, hi > lo ? hi : lo + 1];
}

function materializeRowsForDefs(rows, defs) {
  if (!rows?.length) return rows ?? [];
  if (!defs.some((def) => def.dataKey === "AB__lower_bound")) return rows;
  return rows.map((row) => {
    const a = Number(row?.A__lower_bound);
    const b = Number(row?.B__lower_bound);
    const shared = Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : Number.isFinite(a) ? a : Number.isFinite(b) ? b : null;
    return { ...row, AB__lower_bound: shared };
  });
}

function shouldUseLeadingZeroPad(rows, xKey, chartType, enabled) {
  if (!enabled) return false;
  if (!rows?.length) return false;
  // Sparse bar charts (e.g. density mean with few buckets) look right-shifted
  // when adding a synthetic 0 bucket; keep natural centering instead.
  if (chartType === "bar" && rows.length <= 8) return false;
  const firstX = Number(rows[0]?.[xKey]);
  return Number.isFinite(firstX) && firstX > 0;
}

function defaultChartUi() {
  return {
    dotSize: 6,
    lineWidth: 3,
    yPaddingPct: 8,
    showGrid: true,
    showLegend: true,
    leadingZeroPad: true
  };
}

function formatMode(mode) {
  return mode === "densityMean" ? "Density mean" : "Density";
}

function hasPathOverlayPair(defs, sideIds) {
  if (sideIds.length !== 2) return false;
  return (
    defs.some((d) => d.dataKey === "A__unique_path_count") &&
    defs.some((d) => d.dataKey === "A__best_delay_unique_path_count") &&
    defs.some((d) => d.dataKey === "B__unique_path_count") &&
    defs.some((d) => d.dataKey === "B__best_delay_unique_path_count") &&
    defs.every((d) => ["unique_path_count", "best_delay_unique_path_count"].includes(d.metricKey))
  );
}

function pathOverlayLegendPayload(sideLabelsById) {
  return [
    {
      value: `${sideLabelsById?.A ?? "A"} · unique path count`,
      type: "square",
      color: SIDE_COLORS.A.light,
      id: "legend-a-unique"
    },
    {
      value: `${sideLabelsById?.A ?? "A"} · best delay unique path count`,
      type: "square",
      color: SIDE_COLORS.A.dark,
      id: "legend-a-best"
    },
    {
      value: `${sideLabelsById?.B ?? "B"} · unique path count`,
      type: "square",
      color: SIDE_COLORS.B.light,
      id: "legend-b-unique"
    },
    {
      value: `${sideLabelsById?.B ?? "B"} · best delay unique path count`,
      type: "square",
      color: SIDE_COLORS.B.dark,
      id: "legend-b-best"
    }
  ];
}

function PathOverlayLegend() {
  const items = pathOverlayLegendPayload();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "10px 14px", marginTop: 6 }}>
      {items.map((item) => (
        <span key={item.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#5a6375" }}>
          <i style={{ width: 10, height: 10, borderRadius: 2, background: item.color, display: "inline-block" }} />
          {item.value}
        </span>
      ))}
    </div>
  );
}

function overlayBarShapeFactory(baseColor, topColor, topKey) {
  return function OverlayBarShape(props) {
    const { x, y, width, height, payload } = props;
    const base = Number(props.value);
    const top = Number(payload?.[topKey]);
    const safeX = Number(x);
    const safeY = Number(y);
    const safeW = Number(width);
    const safeH = Number(height);
    if (![safeX, safeY, safeW, safeH].every(Number.isFinite) || safeW <= 0 || safeH <= 0) return null;
    const topRatio = Number.isFinite(base) && base > 0 && Number.isFinite(top) ? Math.max(0, Math.min(1, top / base)) : 0;
    const topHeight = safeH * topRatio;
    const topY = safeY + (safeH - topHeight);
    return (
      <g>
        <rect x={safeX} y={safeY} width={safeW} height={safeH} fill={baseColor} fillOpacity={0.65} />
        {topHeight > 0 ? <rect x={safeX} y={topY} width={safeW} height={topHeight} fill={topColor} /> : null}
      </g>
    );
  };
}

function convergenceOverlayShapeFactory(colorA, colorB, overlapColor) {
  return function ConvergenceOverlayShape(props) {
    const { x, y, width, height, payload } = props;
    const safeX = Number(x);
    const safeY = Number(y);
    const safeW = Number(width);
    const safeH = Number(height);
    if (![safeX, safeY, safeW, safeH].every(Number.isFinite) || safeW <= 0 || safeH <= 0) return null;
    const a = Number(payload?.__convergence_bg_a);
    const b = Number(payload?.__convergence_bg_b);
    const showA = Number.isFinite(a) && a > 0;
    const showB = Number.isFinite(b) && b > 0;
    if (!showA && !showB) return null;
    if (showA && showB) {
      return <rect x={safeX} y={safeY} width={safeW} height={safeH} fill={overlapColor} fillOpacity={0.26} />;
    }
    return (
      <g>
        {showA ? <rect x={safeX} y={safeY} width={safeW} height={safeH} fill={colorA} fillOpacity={0.22} /> : null}
        {showB ? <rect x={safeX} y={safeY} width={safeW} height={safeH} fill={colorB} fillOpacity={0.28} /> : null}
      </g>
    );
  };
}

function ChartCard({
  title,
  rows,
  xKey,
  xTickFormatter,
  chartType,
  defs,
  ui,
  markerByMetric,
  chartMode,
  sideIds,
  sideLabelsById
}) {
  if (!rows.length || !defs.length) return <div className="empty-topology-state">No data for this chart.</div>;
  const normalizedRows = materializeRowsForDefs(rows, defs);
  const useZeroPad = chartType === "bar" && shouldUseLeadingZeroPad(normalizedRows, xKey, chartType, ui.leadingZeroPad);
  const drawRows = useZeroPad ? withLeadingZeroRow(normalizedRows, xKey, defs) : normalizedRows;
  const isBar = chartType === "bar";
  const isPathOverlay = isBar && hasPathOverlayPair(defs, sideIds);
  const hasConvergenceMetric = defs.some((def) => def.metricKey === "convergence_count");
  const shouldPlotConvergenceSeries = chartMode === "densityMean" && hasConvergenceMetric;
  const hasConvergenceOverlay = hasConvergenceMetric && !shouldPlotConvergenceSeries && sideIds.length === 2;
  const plotDefs = shouldPlotConvergenceSeries ? defs : defs.filter((def) => def.metricKey !== "convergence_count");
  const convergenceSeriesOnly = plotDefs.length > 0 && plotDefs.every((def) => def.metricKey === "convergence_count");
  const yTickFormatter = convergenceSeriesOnly ? (value) => `${Math.round(Number(value) || 0)}%` : valueTick;
  const yDomain = convergenceSeriesOnly
    ? [0, 100]
    : isBar
      ? axisDomainForBar(drawRows, plotDefs, ui.yPaddingPct)
      : axisDomainForLine(drawRows, plotDefs, ui.yPaddingPct);

  return (
    <div className="compare-chart-card">
      <h4>{title}</h4>
      <div className="compare-chart-canvas">
        <ResponsiveContainer width="100%" height="100%">
          {isBar ? (
            <BarChart
              data={drawRows}
              margin={{ top: 12, right: 22, left: 20, bottom: 8 }}
              barCategoryGap={isPathOverlay ? "22%" : "34%"}
              barGap={isPathOverlay ? 0 : -5}
            >
              {ui.showGrid ? <CartesianGrid strokeDasharray="3 3" /> : null}
              <XAxis
                dataKey={xKey}
                tick={{ fontSize: 11 }}
                tickFormatter={xTickFormatter}
                padding={{ left: 44, right: 14 }}
              />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={yTickFormatter} domain={yDomain} />
              {hasConvergenceOverlay ? <YAxis yAxisId="bg" hide domain={[0, 1]} /> : null}
              {ui.showLegend ? (
                <Legend
                  payload={isPathOverlay ? pathOverlayLegendPayload(sideLabelsById) : undefined}
                  content={isPathOverlay ? <PathOverlayLegend /> : undefined}
                />
              ) : null}
              {hasConvergenceOverlay ? (
                <Bar
                  dataKey="__convergence_bg_a"
                  yAxisId="bg"
                  name="convergence overlay"
                  fill="transparent"
                  barSize={isPathOverlay ? 28 : 18}
                  isAnimationActive={false}
                  legendType="none"
                  shape={convergenceOverlayShapeFactory(SIDE_COLORS.A.light, "#FBCFE8", "#C4B5FD")}
                />
              ) : null}
              {isPathOverlay ? (
                <>
                  <Bar
                    dataKey="A__unique_path_count"
                    name="A column"
                    barSize={12}
                    minPointSize={2}
                    isAnimationActive={false}
                    shape={overlayBarShapeFactory(SIDE_COLORS.A.light, SIDE_COLORS.A.dark, "A__best_delay_unique_path_count")}
                  />
                  <Bar
                    dataKey="B__unique_path_count"
                    name="B column"
                    barSize={12}
                    minPointSize={2}
                    isAnimationActive={false}
                    shape={overlayBarShapeFactory(SIDE_COLORS.B.light, SIDE_COLORS.B.dark, "B__best_delay_unique_path_count")}
                  />
                </>
              ) : (
                plotDefs.map((def) => (
                  <Bar
                    key={def.dataKey}
                    dataKey={def.dataKey}
                    name={def.name}
                    fill={def.color}
                    maxBarSize={14}
                    minPointSize={2}
                    isAnimationActive={false}
                  />
                ))
              )}
            </BarChart>
          ) : (
            <ComposedChart data={drawRows} margin={{ top: 12, right: 22, left: 20, bottom: 8 }}>
              {ui.showGrid ? <CartesianGrid strokeDasharray="3 3" /> : null}
              <XAxis
                dataKey={xKey}
                type="category"
                tick={{ fontSize: 11 }}
                tickFormatter={xTickFormatter}
                padding={{ left: 44, right: 14 }}
              />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={yTickFormatter} domain={yDomain} />
              {hasConvergenceOverlay ? <YAxis yAxisId="bg" hide domain={[0, 1]} /> : null}
              {ui.showLegend ? <Legend /> : null}
              {hasConvergenceOverlay ? (
                <Bar
                  dataKey="__convergence_bg_a"
                  yAxisId="bg"
                  name="convergence overlay"
                  fill="transparent"
                  barSize={16}
                  isAnimationActive={false}
                  legendType="none"
                  shape={convergenceOverlayShapeFactory(SIDE_COLORS.A.light, "#FBCFE8", "#C4B5FD")}
                />
              ) : null}
              {plotDefs.map((def) => (
                <Line
                  key={def.dataKey}
                  type="linear"
                  dataKey={def.dataKey}
                  name={def.name}
                  stroke={def.color}
                  legendType={
                    (markerByMetric?.[def.metricKey] || "circle") === "cross"
                      ? "cross"
                      : (markerByMetric?.[def.metricKey] || "circle") === "triangle"
                        ? "triangle"
                        : (markerByMetric?.[def.metricKey] || "circle") === "diamond"
                          ? "diamond"
                          : (markerByMetric?.[def.metricKey] || "circle") === "square"
                            ? "square"
                            : "circle"
                  }
                  connectNulls
                  isAnimationActive={false}
                  strokeOpacity={0.5}
                  label={
                    convergenceSeriesOnly
                      ? ({ x, y, value }) => {
                          const n = Number(value);
                          if (!Number.isFinite(n)) return null;
                          const px = Number(x);
                          const py = Number(y);
                          const sideIdx = sideIds.indexOf(def.side);
                          const dy = sideIdx <= 0 ? -9 : 9 + sideIdx * 4;
                          return (
                            <text
                              x={px}
                              y={py + dy}
                              textAnchor="middle"
                              fontSize="10"
                              fill={def.color}
                              fillOpacity="0.95"
                            >
                              {`${Math.round(n)}%`}
                            </text>
                          );
                        }
                      : undefined
                  }
                  dot={(props) => (
                    <MetricDot
                      {...props}
                      shape={markerByMetric?.[def.metricKey] || "circle"}
                      stroke={def.color}
                      fill={def.color}
                    />
                  )}
                  activeDot={false}
                  strokeWidth={clamp(Number(ui.lineWidth) || 3, 1, 8)}
                />
              ))}
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function metricGroupsForModal(mode, catalog) {
  const allowed = mode === "densityMean" ? [...catalog.topologyMetrics, ...catalog.densityMetrics] : catalog.topologyMetrics;
  const map = new Map(allowed.map((metric) => [metric.key, metric]));

  const fixed = [];
  const firstRow = FIXED_GROUP_PATH.map((key) => map.get(key)).filter(Boolean);
  if (firstRow.length) fixed.push({ title: "Path count metrics", items: firstRow });
  const secondRow = FIXED_GROUP_DELAY.map((key) => map.get(key)).filter(Boolean);
  if (secondRow.length) fixed.push({ title: "Delay metrics", items: secondRow });

  const taken = new Set([...FIXED_GROUP_PATH, ...FIXED_GROUP_DELAY]);
  const autoGrouped = new Map();
  allowed.forEach((metric) => {
    if (taken.has(metric.key)) return;
    const key = metric.group || "Other";
    if (!autoGrouped.has(key)) autoGrouped.set(key, []);
    autoGrouped.get(key).push(metric);
  });

  const autoRows = Array.from(autoGrouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, items]) => ({
      title: `${title} metrics`,
      items: items.sort((a, b) => a.label.localeCompare(b.label))
    }));

  return [...fixed, ...autoRows];
}

function defaultDraft(densityLabels) {
  return {
    mode: "density",
    chartType: "line",
    selectedMetricKeys: [],
    selectedDensityLabels: [...densityLabels]
  };
}

function metricSummary(metricKeys, catalogMap) {
  return metricKeys.map((key) => catalogMap.get(key)?.label ?? key).join(", ");
}

function ChartConfigModal({
  open,
  title,
  draft,
  densityLabels,
  catalog,
  onClose,
  onDraftChange,
  onSave
}) {
  if (!open) return null;
  const rows = metricGroupsForModal(draft.mode, catalog);
  const selectedSet = new Set(draft.selectedMetricKeys);
  const densitySet = new Set(draft.selectedDensityLabels);
  const canSave = draft.selectedMetricKeys.length > 0 && draft.selectedDensityLabels.length > 0;

  const toggleMetric = (metricKey) => {
    onDraftChange({
      ...draft,
      selectedMetricKeys: selectedSet.has(metricKey)
        ? draft.selectedMetricKeys.filter((key) => key !== metricKey)
        : [...draft.selectedMetricKeys, metricKey]
    });
  };

  const toggleDensity = (label) => {
    onDraftChange({
      ...draft,
      selectedDensityLabels: densitySet.has(label)
        ? draft.selectedDensityLabels.filter((key) => key !== label)
        : [...draft.selectedDensityLabels, label]
    });
  };

  const switchMode = (nextMode) => {
    const allowed = new Set((nextMode === "densityMean" ? [...catalog.topologyMetrics, ...catalog.densityMetrics] : catalog.topologyMetrics).map((m) => m.key));
    onDraftChange({
      ...draft,
      mode: nextMode,
      selectedMetricKeys: draft.selectedMetricKeys.filter((key) => allowed.has(key))
    });
  };

  return (
    <div className="compare-chart-modal-backdrop" onClick={onClose}>
      <div className="compare-chart-modal" onClick={(e) => e.stopPropagation()}>
        <div className="compare-chart-modal-header">
          <h4>{title}</h4>
          <button type="button" className="batch-icon-btn" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <section className="compare-chart-modal-section">
          <h5>1) Mode</h5>
          <div className="segmented-toggle segmented-toggle--dense">
            <button type="button" className={`segment-btn ${draft.mode === "density" ? "active" : ""}`} onClick={() => switchMode("density")}>
              Density
            </button>
            <button
              type="button"
              className={`segment-btn ${draft.mode === "densityMean" ? "active" : ""}`}
              onClick={() => switchMode("densityMean")}
            >
              Density mean
            </button>
          </div>
        </section>

        <section className="compare-chart-modal-section">
          <h5>2) Data metrics</h5>
          <div className="compare-chart-modal-metric-groups">
            {rows.map((row) => (
              <div key={row.title} className="compare-chart-modal-metric-row">
                <strong>{row.title}</strong>
                <div className="compare-chart-modal-metric-items">
                  {row.items.map((metric) => (
                    <label key={metric.key} className="compare-chart-check">
                      <input type="checkbox" checked={selectedSet.has(metric.key)} onChange={() => toggleMetric(metric.key)} />
                      <span>{metric.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="compare-chart-modal-section">
          <h5>3) Chart type</h5>
          <div className="segmented-toggle segmented-toggle--dense">
            <button
              type="button"
              className={`segment-btn ${draft.chartType === "line" ? "active" : ""}`}
              onClick={() => onDraftChange({ ...draft, chartType: "line" })}
            >
              Line chart
            </button>
            <button
              type="button"
              className={`segment-btn ${draft.chartType === "bar" ? "active" : ""}`}
              onClick={() => onDraftChange({ ...draft, chartType: "bar" })}
            >
              Bar chart
            </button>
          </div>
        </section>

        <section className="compare-chart-modal-section">
          <h5>4) Density</h5>
          <div className="compare-chart-density-actions">
            <button type="button" className="secondary-cta small" onClick={() => onDraftChange({ ...draft, selectedDensityLabels: [...densityLabels] })}>
              Select all
            </button>
            <button type="button" className="secondary-cta small" onClick={() => onDraftChange({ ...draft, selectedDensityLabels: [] })}>
              Clear all
            </button>
            <span className="muted">
              {draft.selectedDensityLabels.length}/{densityLabels.length} selected
            </span>
          </div>
          <div className="compare-chart-density-grid">
            {densityLabels.map((label) => (
              <label key={`density-${label}`} className="compare-chart-check">
                <input type="checkbox" checked={densitySet.has(label)} onChange={() => toggleDensity(label)} />
                <span>Density {label}</span>
              </label>
            ))}
          </div>
        </section>

        <div className="compare-chart-modal-footer">
          <button type="button" className="secondary-cta small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-cta small" disabled={!canSave} onClick={onSave}>
            Save chart
          </button>
        </div>
      </div>
    </div>
  );
}

function batchOptionLabel(item) {
  return `${item.result_label || item.batch_name} (${item.successful}/${item.total_topologies})`;
}

const MAX_CHART_SLOTS = 4;

export default function CompareChartWorkspace({
  apiBase,
  batchRunResults
}) {
  const [slotCount, setSlotCount] = useState(2);
  const [batchIds, setBatchIds] = useState(() => emptyBatchIds(QUAD_COMPARE_SIDES));
  const [resultsBySide, setResultsBySide] = useState({});
  const [loadingBySide, setLoadingBySide] = useState({});
  const [errorsBySide, setErrorsBySide] = useState({});

  const activeSides = useMemo(() => QUAD_COMPARE_SIDES.slice(0, Math.max(1, Math.min(MAX_CHART_SLOTS, slotCount))), [slotCount]);

  const loadBatchSide = useCallback(
    async (sideId, batchRunId) => {
      if (!batchRunId) {
        setResultsBySide((prev) => ({ ...prev, [sideId]: null }));
        setErrorsBySide((prev) => ({ ...prev, [sideId]: null }));
        return;
      }
      setLoadingBySide((prev) => ({ ...prev, [sideId]: true }));
      setErrorsBySide((prev) => ({ ...prev, [sideId]: null }));
      try {
        const data = await fetchBatchResultDetail(apiBase, batchRunId);
        setResultsBySide((prev) => ({ ...prev, [sideId]: data }));
      } catch (err) {
        setResultsBySide((prev) => ({ ...prev, [sideId]: null }));
        setErrorsBySide((prev) => ({ ...prev, [sideId]: err?.message || "Failed to load." }));
      } finally {
        setLoadingBySide((prev) => ({ ...prev, [sideId]: false }));
      }
    },
    [apiBase]
  );

  useEffect(() => {
    activeSides.forEach((sideId) => {
      loadBatchSide(sideId, batchIds[sideId] ?? "");
    });
  }, [activeSides, batchIds, loadBatchSide]);

  const sideLabelsById = useMemo(() => {
    const labels = {};
    (batchRunResults ?? []).forEach((item) => {
      if (!item?.batch_run_id) return;
      labels[item.batch_run_id] = item.result_label || item.batch_name || item.batch_run_id.slice(0, 8);
    });
    const out = {};
    activeSides.forEach((sideId) => {
      const id = batchIds[sideId];
      out[sideId] = labels[id] || sideId;
    });
    return out;
  }, [batchRunResults, batchIds, activeSides]);

  const compareChartInput = useMemo(() => {
    const sides = activeSides
      .filter((sideId) => batchIds[sideId])
      .filter((sideId) => resultsBySide[sideId])
      .map((sideId) => ({
        sideId,
        batchRunId: batchIds[sideId] ?? "",
        label: sideLabelsById[sideId] ?? sideId,
        result: resultsBySide[sideId]
      }));
    return {
      ready: sides.length >= 1,
      sideCount: sides.length,
      sides
    };
  }, [activeSides, batchIds, resultsBySide, sideLabelsById]);

  const catalog = useMemo(() => buildCompareMetricCatalog(compareChartInput), [compareChartInput]);
  const catalogMap = useMemo(() => new Map(catalog.allMetrics.map((metric) => [metric.key, metric])), [catalog]);
  const densityPairs = useMemo(() => buildDensityPairs(compareChartInput), [compareChartInput]);
  const densityLabels = useMemo(() => densityPairs.map((pair) => pair.densityLabel), [densityPairs]);
  const sideIds = useMemo(() => activeSideIds(normalizeCompareChartInput(compareChartInput)), [compareChartInput]);

  const [chartConfigs, setChartConfigs] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(() => defaultDraft([]));

  const setChartSlotCount = (nextCount) => {
    const clamped = Math.max(1, Math.min(MAX_CHART_SLOTS, Number(nextCount) || 1));
    setSlotCount(clamped);
    if (clamped < MAX_CHART_SLOTS) {
      const cleared = QUAD_COMPARE_SIDES.slice(clamped);
      setBatchIds((prev) => {
        const next = { ...prev };
        cleared.forEach((sideId) => {
          next[sideId] = "";
        });
        return next;
      });
      setResultsBySide((prev) => {
        const next = { ...prev };
        cleared.forEach((sideId) => {
          next[sideId] = null;
        });
        return next;
      });
      setErrorsBySide((prev) => {
        const next = { ...prev };
        cleared.forEach((sideId) => {
          next[sideId] = null;
        });
        return next;
      });
    }
  };

  const chartReady = compareChartInput.ready;
  const selectedBatchCount = activeSides.filter((sideId) => batchIds[sideId]).length;

  const openNewChart = () => {
    setDraft(defaultDraft(densityLabels));
    setEditingId(null);
    setModalOpen(true);
  };

  const openEditChart = (chartId) => {
    const found = chartConfigs.find((item) => item.id === chartId);
    if (!found) return;
    setEditingId(chartId);
    setDraft({
      mode: found.mode,
      chartType: found.chartType,
      selectedMetricKeys: [...found.selectedMetricKeys],
      selectedDensityLabels: [...found.selectedDensityLabels]
    });
    setModalOpen(true);
  };

  const saveChart = () => {
    const sanitized = {
      mode: draft.mode,
      chartType: draft.chartType,
      selectedMetricKeys: [...new Set(draft.selectedMetricKeys)],
      selectedDensityLabels: [...new Set(draft.selectedDensityLabels)]
    };
    if (!sanitized.selectedMetricKeys.length || !sanitized.selectedDensityLabels.length) return;
    if (editingId) {
      setChartConfigs((prev) =>
        prev.map((chart) =>
          chart.id === editingId
            ? {
                ...chart,
                ...sanitized
              }
            : chart
        )
      );
    } else {
      setChartConfigs((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          ...sanitized,
          ui: defaultChartUi()
        }
      ]);
    }
    setModalOpen(false);
    setEditingId(null);
  };

  const removeChart = (id) => {
    setChartConfigs((prev) => prev.filter((item) => item.id !== id));
  };

  return (
    <section className="compare-chart-workspace">
      <div className="compare-chart-slot-toolbar">
        <span className="compare-chart-slot-label">Batches to compare</span>
        <div className="generate-mode-toggle compare-kind-toggle compare-chart-slot-toggle">
          {[1, 2, 3, 4].map((count) => (
            <button
              key={count}
              type="button"
              className={slotCount === count ? "active" : ""}
              onClick={() => setChartSlotCount(count)}
            >
              {count}
            </button>
          ))}
        </div>
        <span className="muted compare-toolbar-hint">
          Pick 1–{slotCount} batch result{slotCount > 1 ? "s" : ""} ({selectedBatchCount} selected)
        </span>
      </div>

      <div
        className="compare-chart-batch-pickers"
        style={{ "--chart-slot-count": String(activeSides.length) }}
      >
        {activeSides.map((sideId) => (
          <label key={sideId} className="field-label compare-picker-label">
            <span className={`compare-side-badge compare-side-badge--${sideId.toLowerCase()}`}>{sideId}</span>
            Batch result
            <select
              value={batchIds[sideId] ?? ""}
              onChange={(e) => setBatchIds((prev) => ({ ...prev, [sideId]: e.target.value }))}
            >
              <option value="">— Select batch result —</option>
              {(batchRunResults ?? []).map((item) => (
                <option key={item.batch_run_id} value={item.batch_run_id}>
                  {batchOptionLabel(item)}
                </option>
              ))}
            </select>
            {loadingBySide[sideId] ? <span className="muted">Loading…</span> : null}
            {errorsBySide[sideId] ? <span className="compare-chart-side-error">{errorsBySide[sideId]}</span> : null}
          </label>
        ))}
      </div>

      {!chartReady ? (
        <div className="empty-topology-state compare-empty-hint">
          Select at least one batch result above to build charts (up to {slotCount}).
        </div>
      ) : null}

      <div className="compare-chart-top-actions">
        <button type="button" className="primary-cta" onClick={openNewChart} disabled={!chartReady}>
          + Add new chart
        </button>
      </div>

      {chartReady && !chartConfigs.length ? (
        <div className="compare-chart-blank-state">
          <p>No charts yet.</p>
          <p className="muted">Click + Add new chart to select mode, metrics, chart type, and density.</p>
        </div>
      ) : null}

      <div className="compare-chart-cards">
        {chartReady
          ? chartConfigs.map((chart, idx) => {
          const defs = seriesDefs(chart.selectedMetricKeys, catalogMap, sideIds, sideLabelsById);
          const markerByMetric = buildMarkerByMetric(chart.selectedMetricKeys);
          const titleMetrics = metricSummary(chart.selectedMetricKeys, catalogMap);
          const selectedPairMap = new Map(
            densityPairs
              .filter((pair) => chart.selectedDensityLabels.includes(pair.densityLabel))
              .map((pair) => [pair.densityLabel, pair])
          );

          const topoKeys = chart.selectedMetricKeys.filter((key) => catalogMap.get(key)?.scope === "topology");
          const densityKeys = chart.selectedMetricKeys.filter((key) => catalogMap.get(key)?.scope === "density");
          const meanRows = buildDensityMeanRows(compareChartInput, topoKeys, densityKeys).filter((row) =>
            chart.selectedDensityLabels.includes(row.densityLabel)
          );

          return (
            <div key={chart.id} className="compare-chart-panel">
              <div className="compare-chart-panel-header">
                <strong>
                  Chart {idx + 1}: {formatMode(chart.mode)} · {chart.chartType === "bar" ? "bar" : "line"}
                </strong>
                <div className="compare-chart-panel-actions">
                  <button type="button" className="secondary-cta small" onClick={() => openEditChart(chart.id)}>
                    Edit
                  </button>
                  <button type="button" className="danger-ghost-btn" onClick={() => removeChart(chart.id)}>
                    Remove
                  </button>
                </div>
              </div>
              <p className="muted compare-chart-panel-sub">{titleMetrics}</p>

              {chart.mode === "density" ? (
                chart.selectedDensityLabels.map((densityLabel) => {
                  const pair = selectedPairMap.get(densityLabel);
                  const rows = pair ? buildPerDensityChartRows(pair, chart.selectedMetricKeys, sideIds) : [];
                  return (
                    <ChartCard
                      key={`${chart.id}-${densityLabel}`}
                      title={`Density ${densityLabel}`}
                      rows={rows}
                      xKey="x"
                      xTickFormatter={(value) => (Number(value) === 0 ? "0*" : String(value))}
                      chartType={chart.chartType}
                      defs={defs}
                      ui={chart.ui ?? defaultChartUi()}
                      markerByMetric={markerByMetric}
                      chartMode={chart.mode}
                      sideIds={sideIds}
                      sideLabelsById={sideLabelsById}
                    />
                  );
                })
              ) : (
                <ChartCard
                  title="Density mean comparison"
                  rows={meanRows}
                  xKey="x"
                  xTickFormatter={(value) => {
                    if (Number(value) === 0) return "0*";
                    const found = meanRows.find((row) => Number(row.x) === Number(value));
                    return found?.densityLabel ?? String(value);
                  }}
                  chartType={chart.chartType}
                  defs={defs}
                  ui={chart.ui ?? defaultChartUi()}
                  markerByMetric={markerByMetric}
                  chartMode={chart.mode}
                  sideIds={sideIds}
                  sideLabelsById={sideLabelsById}
                />
              )}
            </div>
          );
        })
          : null}
      </div>

      <ChartConfigModal
        open={modalOpen}
        title={editingId ? "Edit chart config" : "Create new chart"}
        draft={draft}
        densityLabels={densityLabels}
        catalog={catalog}
        onClose={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        onDraftChange={setDraft}
        onSave={saveChart}
      />
    </section>
  );
}


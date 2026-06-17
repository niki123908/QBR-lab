import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, XAxis, YAxis } from "recharts";
import {
  applySeriesStyles,
  appearanceDraftToUi,
  buildAppearanceDraft,
  defaultChartAxisLabels,
  defaultYAxisLabelFromMetrics,
  resolveChartDisplayUi,
  normalizeSeriesStylesMap,
  resolvePanelTitle,
  resolveYAxisDomain
} from "../utils/compareChartAppearance.js";
import { downloadPanelChartsAsPdf } from "../utils/compareChartExport.js";
import {
  buildChartFiguresForPanel,
  downloadPanelChartsAsLatex
} from "../utils/compareChartLatexExport.js";
import { buildCompareMetricCatalog } from "../utils/compareChartMetrics.js";
import {
  QUAD_COMPARE_SIDES,
  SIDE_COLORS,
  normalizeCompareChartInput,
  activeSideIds
} from "../utils/compareChartSides.js";
import { SERIES_MARKER_OPTIONS, rechartsLegendType } from "../utils/compareChartMarkers.js";
import {
  applyChartPresetToDraft,
  deleteChartPreset,
  presetSummaryLabel,
  readChartPresets,
  saveChartPreset
} from "../utils/compareChartPresetStorage.js";
import {
  readCompareChartWorkspaceSession,
  writeCompareChartWorkspaceSession
} from "../utils/compareChartWorkspaceStorage.js";
import {
  LOWER_BOUND_DATA_KEY,
  LOWER_BOUND_SERIES_LABEL,
  filterMetricKeysWithLowerBound,
  findQbrSideForLowerBound,
  materializeLowerBoundRows
} from "../utils/compareChartLowerBound.js";
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
const PATH_COUNT_METRICS = new Set(FIXED_GROUP_PATH);
const PATH_COUNT_Y_MAX = 1000;

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
  if (key === "lower_bound") return "#9333EA";
  if (key === "unique_path_count") return family.light;
  if (key === "best_delay_unique_path_count") return family.dark;
  if (key.includes("best")) return family.dark;
  if (key.includes("last")) return family.main;
  return family.light;
}

function LegendMarkerGlyph({ shape, color, size = 14 }) {
  const c = color || "#5a6375";
  const half = size / 2;
  if (shape === "none") {
    return (
      <svg width={size} height={size} className="compare-chart-legend-marker compare-chart-legend-marker--line-only" aria-hidden>
        <line x1={2} y1={half} x2={size - 2} y2={half} stroke={c} strokeWidth={2.2} strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} className="compare-chart-legend-marker" aria-hidden>
      <MetricDot cx={half} cy={half} stroke={c} fill={c} shape={shape} opacity={1} />
    </svg>
  );
}

function LineSeriesLegend({ defs }) {
  if (!defs?.length) return null;
  return (
    <div className="compare-chart-legend compare-chart-legend--line" role="list">
      {defs.map((def) => (
        <span key={def.dataKey} className="compare-chart-legend-item" role="listitem">
          <LegendMarkerGlyph shape={def.marker || "circle"} color={def.color} />
          <span className="compare-chart-legend-label">{def.name}</span>
        </span>
      ))}
    </div>
  );
}

function MetricDot({ cx, cy, stroke, fill, shape = "circle", opacity = 1 }) {
  const x = Number(cx);
  const y = Number(cy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const color = stroke || fill || "#333";
  const o = Math.min(1, Math.max(0.05, Number(opacity) || 1));
  if (shape === "cross") {
    return (
      <g>
        <line x1={x - 4} y1={y - 4} x2={x + 4} y2={y + 4} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
        <line x1={x - 4} y1={y + 4} x2={x + 4} y2={y - 4} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      </g>
    );
  }
  if (shape === "triangle") {
    return <path d={`M ${x} ${y - 5} L ${x + 5} ${y + 4} L ${x - 5} ${y + 4} Z`} fill={color} fillOpacity={o} stroke={color} strokeOpacity={o} strokeWidth={1} />;
  }
  if (shape === "diamond") {
    return <path d={`M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z`} fill={color} fillOpacity={o} stroke={color} strokeOpacity={o} strokeWidth={1} />;
  }
  if (shape === "square") {
    return <rect x={x - 4} y={y - 4} width={8} height={8} fill={color} fillOpacity={o} stroke={color} strokeOpacity={o} strokeWidth={1} />;
  }
  return <circle cx={x} cy={y} r={4} fill={color} fillOpacity={o} stroke={color} strokeOpacity={o} strokeWidth={1} />;
}

function seriesDefs(metricKeys, catalogMap, sideIds, sideLabelsById, compareChartInput) {
  const defs = [];
  const qbrSideId = findQbrSideForLowerBound(compareChartInput);

  metricKeys.forEach((key) => {
    const metric = catalogMap.get(key);
    if (!metric) return;

    if (key === "lower_bound") {
      if (!qbrSideId) return;
      defs.push({
        dataKey: LOWER_BOUND_DATA_KEY,
        metricKey: key,
        side: "LB",
        name: LOWER_BOUND_SERIES_LABEL,
        color: metricColor(key, "LB")
      });
      return;
    }

    sideIds.forEach((sideId) => {
      const sideLabel = sideLabelsById?.[sideId] || sideId;
      defs.push({
        dataKey: `${sideId}__${key}`,
        metricKey: key,
        side: sideId,
        name: sideLabel,
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

function materializeRowsForDefs(rows, defs, compareChartInput) {
  return materializeLowerBoundRows(rows, defs, findQbrSideForLowerBound(compareChartInput));
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
    showLineValues: false,
    leadingZeroPad: true,
    seriesStyles: {},
    yAxisManual: false,
    showXAxisTicks: true,
    showYAxisTicks: true,
    showXAxisLabel: false,
    showYAxisLabel: true,
    xAxisTickFontSize: 11,
    yAxisTickFontSize: 11
  };
}

function mergeChartUi(rawUi) {
  const base = defaultChartUi();
  if (!rawUi || typeof rawUi !== "object" || Array.isArray(rawUi)) return base;
  return {
    ...base,
    ...rawUi,
    seriesStyles: normalizeSeriesStylesMap(rawUi.seriesStyles)
  };
}

function chartUiForDisplay(chart, catalogMap) {
  return mergeChartUi(resolveChartDisplayUi(chart.ui, chart, catalogMap));
}

function filterPlotDefs(defs, chartMode) {
  const hasConvergenceMetric = defs.some((def) => def.metricKey === "convergence_count");
  const shouldPlotConvergenceSeries = chartMode === "densityMean" && hasConvergenceMetric;
  return shouldPlotConvergenceSeries ? defs : defs.filter((def) => def.metricKey !== "convergence_count");
}

function computeChartAutoYDomain({
  rows,
  plotDefs,
  chartType,
  chartMode,
  ui,
  sideIds,
  compareChartInput,
  xKey = "x"
}) {
  if (!rows?.length || !plotDefs?.length) return [0, 1];
  const normalizedRows = materializeRowsForDefs(rows, plotDefs, compareChartInput);
  const useZeroPad =
    chartType === "bar" && shouldUseLeadingZeroPad(normalizedRows, xKey, chartType, ui?.leadingZeroPad !== false);
  const drawRows = useZeroPad ? withLeadingZeroRow(normalizedRows, xKey, plotDefs) : normalizedRows;
  const isBar = chartType === "bar";
  const isPathOverlay = isBar && hasPathOverlayPair(plotDefs, sideIds);
  const convergenceSeriesOnly = plotDefs.length > 0 && plotDefs.every((def) => def.metricKey === "convergence_count");
  if (convergenceSeriesOnly) return [0, 100];
  if (isPathOverlay || isPathCountOnlyChart(plotDefs)) return [0, PATH_COUNT_Y_MAX];
  return isBar
    ? axisDomainForBar(drawRows, plotDefs, ui?.yPaddingPct ?? 8)
    : axisDomainForLine(drawRows, plotDefs, ui?.yPaddingPct ?? 8);
}

function isPathCountOnlyChart(plotDefs) {
  return plotDefs.length > 0 && plotDefs.every((def) => PATH_COUNT_METRICS.has(def.metricKey));
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

const PATH_OVERLAY_KEYS = [
  ["A__unique_path_count", "A", "unique path count", SIDE_COLORS.A.light],
  ["A__best_delay_unique_path_count", "A", "best delay unique path count", SIDE_COLORS.A.dark],
  ["B__unique_path_count", "B", "unique path count", SIDE_COLORS.B.light],
  ["B__best_delay_unique_path_count", "B", "best delay unique path count", SIDE_COLORS.B.dark]
];

function pathOverlayLegendPayload(defs, sideLabelsById) {
  const byKey = new Map((defs ?? []).map((def) => [def.dataKey, def]));
  return PATH_OVERLAY_KEYS.map(([dataKey, side, suffix, fallbackColor]) => {
    const def = byKey.get(dataKey);
    const sideLabel = sideLabelsById?.[side] ?? side;
    return {
      value: def?.name ?? sideLabel,
      type: "square",
      color: def?.color ?? fallbackColor,
      id: `legend-${dataKey}`
    };
  });
}

function PathOverlayLegend({ items }) {
  return (
    <div className="compare-chart-legend compare-chart-legend--bar" role="list">
      {items.map((item) => (
        <span key={item.id} className="compare-chart-legend-item" role="listitem">
          <i className="compare-chart-legend-swatch" style={{ background: item.color }} />
          <span className="compare-chart-legend-label">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

function overlayBarShapeFactory(baseColor, topColor, topKey, baseOpacity = 0.65) {
  const baseOp = Math.min(1, Math.max(0.05, Number(baseOpacity) || 0.65));
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
        <rect x={safeX} y={safeY} width={safeW} height={safeH} fill={baseColor} fillOpacity={baseOp} />
        {topHeight > 0 ? <rect x={safeX} y={topY} width={safeW} height={topHeight} fill={topColor} fillOpacity={baseOp} /> : null}
      </g>
    );
  };
}

function defByKey(defs, dataKey) {
  return defs.find((def) => def.dataKey === dataKey);
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
  chartMode,
  sideIds,
  sideLabelsById,
  compareChartInput
}) {
  if (!rows.length || !defs.length) return <div className="empty-topology-state">No data for this chart.</div>;
  const uiSafe = mergeChartUi(ui);
  const normalizedRows = materializeRowsForDefs(rows, defs, compareChartInput);
  const useZeroPad = chartType === "bar" && shouldUseLeadingZeroPad(normalizedRows, xKey, chartType, uiSafe.leadingZeroPad);
  const drawRows = useZeroPad ? withLeadingZeroRow(normalizedRows, xKey, defs) : normalizedRows;
  const isBar = chartType === "bar";
  const isPathOverlay = isBar && hasPathOverlayPair(defs, sideIds);
  const hasConvergenceMetric = defs.some((def) => def.metricKey === "convergence_count");
  const shouldPlotConvergenceSeries = chartMode === "densityMean" && hasConvergenceMetric;
  const hasConvergenceOverlay = hasConvergenceMetric && !shouldPlotConvergenceSeries && sideIds.length === 2;
  const plotDefs = filterPlotDefs(defs, chartMode);
  if (!plotDefs.length) {
    return <div className="empty-topology-state">No plottable series for this chart (check metrics / visibility).</div>;
  }
  const useFixedPathCountScale = isPathOverlay || isPathCountOnlyChart(plotDefs);
  const pathLegendItems = isPathOverlay ? pathOverlayLegendPayload(plotDefs, sideLabelsById) : [];
  const convergenceSeriesOnly = plotDefs.length > 0 && plotDefs.every((def) => def.metricKey === "convergence_count");
  const showLineValues =
    uiSafe.showLineValues === true || (uiSafe.showLineValues !== false && convergenceSeriesOnly);
  const yTickFormatter = convergenceSeriesOnly ? (value) => `${Math.round(Number(value) || 0)}%` : valueTick;

  function linePointValueLabel(def, plotIdx, seriesCount) {
    return ({ x, y, value }) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      const px = Number(x);
      const py = Number(y);
      const text = convergenceSeriesOnly ? `${Math.round(n)}%` : valueTick(n);
      // Near chart top, labels above the point are clipped — place below instead.
      // Alternate above/below when multiple series share the same x bucket.
      const stack = Math.floor(plotIdx / 2);
      const preferBelow = py < 24 || (seriesCount > 1 && plotIdx % 2 === 1);
      const labelY = preferBelow ? py + 14 + stack * 10 : py - 10 - stack * 11;
      return (
        <text
          x={px}
          y={labelY}
          textAnchor="middle"
          dominantBaseline={preferBelow ? "hanging" : "text-after-edge"}
          fontSize="10"
          fill={def.color}
          fillOpacity="0.95"
        >
          {text}
        </text>
      );
    };
  }

  const autoYDomain = computeChartAutoYDomain({
    rows,
    plotDefs,
    chartType,
    chartMode,
    ui: uiSafe,
    sideIds,
    compareChartInput,
    xKey
  });
  const yDomain = resolveYAxisDomain(autoYDomain, uiSafe);
  const xTickSize = Math.min(18, Math.max(8, Number(uiSafe.xAxisTickFontSize) || 11));
  const yTickSize = Math.min(18, Math.max(8, Number(uiSafe.yAxisTickFontSize) || 11));
  const xTickProps = { fontSize: xTickSize };
  const yTickProps = { fontSize: yTickSize };
  const xAxisLabelProps =
    uiSafe.showXAxisLabel && String(uiSafe.xAxisLabel ?? "").trim()
      ? {
          value: String(uiSafe.xAxisLabel).trim(),
          position: "insideBottom",
          offset: -2,
          style: { fontSize: Math.max(10, xTickSize), fill: "#5a6375" }
        }
      : undefined;
  const yAxisLabelProps =
    uiSafe.showYAxisLabel && String(uiSafe.yAxisLabel ?? "").trim()
      ? {
          value: String(uiSafe.yAxisLabel).trim(),
          angle: -90,
          position: "insideLeft",
          style: { fontSize: Math.max(10, yTickSize), fill: "#5a6375", textAnchor: "middle" }
        }
      : undefined;
  const legendBottomPad = !isBar && uiSafe.showLegend ? (uiSafe.showXAxisLabel ? 36 : 28) : 0;
  const valueLabelTopPad =
    !isBar && showLineValues ? Math.max(18, 10 + Math.ceil(plotDefs.length / 2) * 10) : 0;
  const chartMargin = {
    top: 12 + valueLabelTopPad,
    right: 22,
    left: uiSafe.showYAxisLabel ? 28 : 20,
    bottom: (uiSafe.showXAxisLabel ? 22 : 8) + legendBottomPad
  };

  return (
    <div className="compare-chart-card">
      <h4>{title}</h4>
      <div
        className={`compare-chart-canvas${useFixedPathCountScale ? " compare-chart-canvas--path-count" : ""}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          {isBar ? (
            <BarChart
              data={drawRows}
              margin={chartMargin}
              barCategoryGap={isPathOverlay ? "22%" : "34%"}
              barGap={isPathOverlay ? 0 : -5}
            >
              {uiSafe.showGrid ? <CartesianGrid strokeDasharray="3 3" /> : null}
              <XAxis
                dataKey={xKey}
                tick={xTickProps}
                hide={uiSafe.showXAxisTicks === false}
                tickFormatter={xTickFormatter}
                padding={{ left: 44, right: 14 }}
                label={xAxisLabelProps}
              />
              <YAxis
                tick={yTickProps}
                hide={uiSafe.showYAxisTicks === false}
                tickFormatter={yTickFormatter}
                domain={yDomain}
                label={yAxisLabelProps}
              />
              {hasConvergenceOverlay ? <YAxis yAxisId="bg" hide domain={[0, 1]} /> : null}
              {uiSafe.showLegend ? (
                <Legend
                  verticalAlign="bottom"
                  align="center"
                  wrapperStyle={{ width: "100%", paddingTop: 8 }}
                  payload={isPathOverlay ? pathLegendItems : undefined}
                  content={isPathOverlay ? <PathOverlayLegend items={pathLegendItems} /> : undefined}
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
                    name={defByKey(plotDefs, "A__unique_path_count")?.name ?? "A column"}
                    barSize={12}
                    minPointSize={2}
                    isAnimationActive={false}
                    shape={overlayBarShapeFactory(
                      defByKey(plotDefs, "A__unique_path_count")?.color ?? SIDE_COLORS.A.light,
                      defByKey(plotDefs, "A__best_delay_unique_path_count")?.color ?? SIDE_COLORS.A.dark,
                      "A__best_delay_unique_path_count",
                      defByKey(plotDefs, "A__unique_path_count")?.opacity ?? 0.65
                    )}
                  />
                  <Bar
                    dataKey="B__unique_path_count"
                    name={defByKey(plotDefs, "B__unique_path_count")?.name ?? "B column"}
                    barSize={12}
                    minPointSize={2}
                    isAnimationActive={false}
                    shape={overlayBarShapeFactory(
                      defByKey(plotDefs, "B__unique_path_count")?.color ?? SIDE_COLORS.B.light,
                      defByKey(plotDefs, "B__best_delay_unique_path_count")?.color ?? SIDE_COLORS.B.dark,
                      "B__best_delay_unique_path_count",
                      defByKey(plotDefs, "B__unique_path_count")?.opacity ?? 0.65
                    )}
                  />
                </>
              ) : (
                plotDefs.map((def) => (
                  <Bar
                    key={def.dataKey}
                    dataKey={def.dataKey}
                    name={def.name}
                    fill={def.color}
                    fillOpacity={def.opacity ?? 0.65}
                    maxBarSize={14}
                    minPointSize={2}
                    isAnimationActive={false}
                  />
                ))
              )}
            </BarChart>
          ) : (
            <ComposedChart data={drawRows} margin={chartMargin}>
              {uiSafe.showGrid ? <CartesianGrid strokeDasharray="3 3" /> : null}
              <XAxis
                dataKey={xKey}
                type="category"
                tick={xTickProps}
                hide={uiSafe.showXAxisTicks === false}
                tickFormatter={xTickFormatter}
                padding={{ left: 44, right: 14 }}
                label={xAxisLabelProps}
              />
              <YAxis
                tick={yTickProps}
                hide={uiSafe.showYAxisTicks === false}
                tickFormatter={yTickFormatter}
                domain={yDomain}
                label={yAxisLabelProps}
              />
              {hasConvergenceOverlay ? <YAxis yAxisId="bg" hide domain={[0, 1]} /> : null}
              {uiSafe.showLegend ? (
                <Legend
                  verticalAlign="bottom"
                  align="center"
                  wrapperStyle={{ width: "100%", paddingTop: 10 }}
                  content={<LineSeriesLegend defs={plotDefs} />}
                />
              ) : null}
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
              {plotDefs.map((def, plotIdx) => {
                const markerShape = def.marker || "circle";
                return (
                <Line
                  key={def.dataKey}
                  type="linear"
                  dataKey={def.dataKey}
                  name={def.name}
                  stroke={def.color}
                  legendType={rechartsLegendType(markerShape)}
                  connectNulls
                  isAnimationActive={false}
                  strokeOpacity={def.opacity ?? 0.5}
                  label={showLineValues ? linePointValueLabel(def, plotIdx, plotDefs.length) : undefined}
                  dot={
                    markerShape === "none"
                      ? false
                      : (props) => (
                          <MetricDot
                            {...props}
                            shape={markerShape}
                            stroke={def.color}
                            fill={def.color}
                            opacity={def.opacity ?? 1}
                          />
                        )
                  }
                  activeDot={false}
                  strokeWidth={clamp(Number(uiSafe.lineWidth) || 3, 1, 8)}
                />
              );
              })}
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
    selectedDensityLabels: [...densityLabels],
    presetUi: null,
    presetId: ""
  };
}

function metricSummary(metricKeys, catalogMap) {
  return metricKeys.map((key) => catalogMap.get(key)?.label ?? key).join(", ");
}

function ChartPresetNameModal({ open, value, setValue, defaultLabel, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="compare-chart-modal-backdrop" onClick={onCancel}>
      <div className="modal-card compare-chart-preset-name-card" onClick={(e) => e.stopPropagation()}>
        <h3>Save chart preset</h3>
        <p className="muted">
          Saves metrics, densities, chart type, mode, and appearance (titles, colors, axes). Leave empty to use:{" "}
          <strong>{defaultLabel}</strong>
        </p>
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
          placeholder={defaultLabel}
        />
        <div className="modal-actions">
          <button type="button" className="secondary-cta small" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-cta small" onClick={onConfirm}>
            Save preset
          </button>
        </div>
      </div>
    </div>
  );
}

function ChartConfigModal({
  open,
  title,
  draft,
  densityLabels,
  catalog,
  presets,
  onPresetSelect,
  onPresetDelete,
  onClose,
  onDraftChange,
  onSave
}) {
  if (!open) return null;
  const rows = metricGroupsForModal(draft.mode, catalog);
  const selectedSet = new Set(draft.selectedMetricKeys);
  const densitySet = new Set(draft.selectedDensityLabels);
  const canSave = draft.selectedMetricKeys.length > 0 && draft.selectedDensityLabels.length > 0;
  const selectedPresetId = draft.presetId ?? "";

  const toggleMetric = (metricKey) => {
    onDraftChange({
      ...draft,
      presetId: "",
      selectedMetricKeys: selectedSet.has(metricKey)
        ? draft.selectedMetricKeys.filter((key) => key !== metricKey)
        : [...draft.selectedMetricKeys, metricKey]
    });
  };

  const toggleDensity = (label) => {
    onDraftChange({
      ...draft,
      presetId: "",
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
      presetId: "",
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
          <h5>Load preset (optional)</h5>
          <div className="compare-chart-preset-load-row">
            <select
              className="modal-input"
              value={selectedPresetId}
              onChange={(e) => onPresetSelect(e.target.value)}
            >
              <option value="">— Configure from scratch —</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {presetSummaryLabel(preset)}
                </option>
              ))}
            </select>
            {selectedPresetId ? (
              <button
                type="button"
                className="danger-ghost-btn small"
                title="Delete saved preset"
                onClick={() => onPresetDelete(selectedPresetId)}
              >
                Delete preset
              </button>
            ) : null}
          </div>
          {!presets.length ? (
            <p className="muted compare-chart-preset-hint">No saved presets yet. Use “Save preset” on an existing chart.</p>
          ) : null}
        </section>

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
              onClick={() => onDraftChange({ ...draft, chartType: "line", presetId: "" })}
            >
              Line chart
            </button>
            <button
              type="button"
              className={`segment-btn ${draft.chartType === "bar" ? "active" : ""}`}
              onClick={() => onDraftChange({ ...draft, chartType: "bar", presetId: "" })}
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

function normalizeHexColor(raw) {
  const s = String(raw ?? "")
    .trim()
    .replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    const [r, g, b] = s.split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function SeriesColorPicker({ color, onChange }) {
  const resolved = normalizeHexColor(color) ?? "#888888";
  const [hexText, setHexText] = useState(() => resolved.slice(1));

  useEffect(() => {
    setHexText(resolved.slice(1));
  }, [resolved]);

  const commitHex = (text) => {
    const next = normalizeHexColor(text);
    if (next) {
      onChange(next);
      setHexText(next.slice(1));
      return;
    }
    setHexText(resolved.slice(1));
  };

  return (
    <div className="compare-chart-color-field">
      <input
        type="color"
        value={resolved}
        onChange={(e) => {
          const next = normalizeHexColor(e.target.value);
          if (next) onChange(next);
        }}
        title="Pick color"
      />
      <input
        type="text"
        className="modal-input compare-chart-color-hex"
        value={`#${hexText}`}
        onChange={(e) => {
          const v = e.target.value;
          setHexText(v.replace(/^#/, ""));
          const next = normalizeHexColor(v);
          if (next) onChange(next);
        }}
        onBlur={() => commitHex(hexText)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitHex(hexText);
          }
        }}
        spellCheck={false}
        aria-label="Hex color"
        placeholder="#RRGGBB"
      />
    </div>
  );
}

function ChartAppearanceModal({ open, draft, chartType, onClose, onDraftChange, onSave }) {
  if (!open || !draft) return null;

  const isLineChart = chartType === "line";

  const updateSeries = (dataKey, patch) => {
    onDraftChange({
      ...draft,
      series: draft.series.map((row) => (row.dataKey === dataKey ? { ...row, ...patch } : row))
    });
  };

  const visibleCount = draft.series.filter((row) => !row.hidden).length;

  return (
    <div className="compare-chart-modal-backdrop" onClick={onClose}>
      <div className="compare-chart-modal compare-chart-modal--appearance" onClick={(e) => e.stopPropagation()}>
        <div className="compare-chart-modal-header">
          <h4>Edit chart appearance</h4>
          <button type="button" className="batch-icon-btn" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <section className="compare-chart-modal-section">
          <h5>Chart title</h5>
          <input
            type="text"
            className="modal-input"
            value={draft.chartTitle}
            placeholder="Panel title (leave empty for default)"
            onChange={(e) => onDraftChange({ ...draft, chartTitle: e.target.value })}
          />
        </section>

        <section className="compare-chart-modal-section">
          <h5>Card title</h5>
          <input
            type="text"
            className="modal-input"
            value={draft.cardTitle}
            placeholder="Title inside chart area (optional)"
            onChange={(e) => onDraftChange({ ...draft, cardTitle: e.target.value })}
          />
        </section>

        <section className="compare-chart-modal-section">
          <h5>LaTeX export</h5>
          <label className="compare-chart-field-label">Figure caption</label>
          <input
            type="text"
            className="modal-input"
            value={draft.latexCaption}
            placeholder="\\caption{...} in exported .tex (optional)"
            onChange={(e) => onDraftChange({ ...draft, latexCaption: e.target.value })}
          />
          <label className="compare-chart-field-label">Figure label</label>
          <input
            type="text"
            className="modal-input"
            value={draft.latexLabel}
            placeholder="e.g. delay_performance → fig:delay_performance"
            onChange={(e) => onDraftChange({ ...draft, latexLabel: e.target.value })}
          />
        </section>

        <section className="compare-chart-modal-section">
          <h5>Data series</h5>
          <p className="muted">
            Rename, pick colors, adjust opacity, or hide lines/bars.
            {isLineChart ? " Line charts: choose a point marker per series." : ""} ({visibleCount} visible)
          </p>
          <div className="compare-chart-appearance-series">
            <div
              className={`compare-chart-appearance-row compare-chart-appearance-row-head${isLineChart ? " compare-chart-appearance-row--line" : ""}`}
            >
              <span>Show</span>
              <span>Name</span>
              <span>Color</span>
              {isLineChart ? <span>Marker</span> : null}
              <span>Opacity</span>
              <span />
            </div>
            {draft.series.map((row) => (
              <div
                key={row.dataKey}
                className={`compare-chart-appearance-row${isLineChart ? " compare-chart-appearance-row--line" : ""}`}
              >
                <label className="compare-chart-check" title="Show series">
                  <input
                    type="checkbox"
                    checked={!row.hidden}
                    onChange={(e) => updateSeries(row.dataKey, { hidden: !e.target.checked })}
                  />
                </label>
                <input
                  type="text"
                  className="modal-input"
                  value={row.name}
                  placeholder={row.defaultName}
                  onChange={(e) => updateSeries(row.dataKey, { name: e.target.value })}
                />
                <SeriesColorPicker color={row.color} onChange={(color) => updateSeries(row.dataKey, { color })} />
                {isLineChart ? (
                  <select
                    className="modal-input compare-chart-marker-select"
                    value={row.marker || "circle"}
                    onChange={(e) => updateSeries(row.dataKey, { marker: e.target.value })}
                    title="Point marker on line"
                  >
                    {SERIES_MARKER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={row.opacity}
                  onChange={(e) => updateSeries(row.dataKey, { opacity: Number(e.target.value) })}
                />
                <span className="muted">{Math.round((Number(row.opacity) || 1) * 100)}%</span>
              </div>
            ))}
          </div>
        </section>

        <section className="compare-chart-modal-section">
          <h5>Axes</h5>
          <div className="compare-chart-appearance-axis-block">
            <label className="compare-chart-check">
              <input
                type="checkbox"
                checked={draft.yAxisManual}
                onChange={(e) => onDraftChange({ ...draft, yAxisManual: e.target.checked })}
              />
              <span>Manual Y range</span>
            </label>
            <p className="muted compare-chart-axis-hint">
              Auto: {draft.yAxisAutoMin} – {draft.yAxisAutoMax}
            </p>
            <div className={`compare-chart-axis-range${draft.yAxisManual ? "" : " compare-chart-axis-range--disabled"}`}>
              <label className="field-label">
                Y min
                <input
                  type="number"
                  className="modal-input"
                  disabled={!draft.yAxisManual}
                  value={draft.yAxisMin}
                  onChange={(e) => onDraftChange({ ...draft, yAxisMin: Number(e.target.value) })}
                />
              </label>
              <label className="field-label">
                Y max
                <input
                  type="number"
                  className="modal-input"
                  disabled={!draft.yAxisManual}
                  value={draft.yAxisMax}
                  onChange={(e) => onDraftChange({ ...draft, yAxisMax: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="compare-chart-appearance-global">
              <label className="compare-chart-check">
                <input
                  type="checkbox"
                  checked={draft.showXAxisTicks}
                  onChange={(e) => onDraftChange({ ...draft, showXAxisTicks: e.target.checked })}
                />
                <span>X tick numbers</span>
              </label>
              <label className="compare-chart-check">
                <input
                  type="checkbox"
                  checked={draft.showYAxisTicks}
                  onChange={(e) => onDraftChange({ ...draft, showYAxisTicks: e.target.checked })}
                />
                <span>Y tick numbers</span>
              </label>
              <label className="compare-chart-check">
                <input
                  type="checkbox"
                  checked={draft.showXAxisLabel}
                  onChange={(e) => onDraftChange({ ...draft, showXAxisLabel: e.target.checked })}
                />
                <span>X axis label</span>
              </label>
              <label className="compare-chart-check">
                <input
                  type="checkbox"
                  checked={draft.showYAxisLabel}
                  onChange={(e) => onDraftChange({ ...draft, showYAxisLabel: e.target.checked })}
                />
                <span>Y axis label</span>
              </label>
            </div>
            <div className="compare-chart-axis-range">
              <label className="field-label">
                X label text
                <input
                  type="text"
                  className="modal-input"
                  disabled={!draft.showXAxisLabel}
                  value={draft.xAxisLabel}
                  onChange={(e) => onDraftChange({ ...draft, xAxisLabel: e.target.value })}
                />
              </label>
              <label className="field-label">
                Y label text
                <input
                  type="text"
                  className="modal-input"
                  disabled={!draft.showYAxisLabel}
                  value={draft.yAxisLabel}
                  onChange={(e) => onDraftChange({ ...draft, yAxisLabel: e.target.value })}
                />
              </label>
              <label className="field-label">
                X tick size
                <input
                  type="number"
                  className="modal-input"
                  min={8}
                  max={18}
                  value={draft.xAxisTickFontSize}
                  onChange={(e) => onDraftChange({ ...draft, xAxisTickFontSize: Number(e.target.value) })}
                />
              </label>
              <label className="field-label">
                Y tick size
                <input
                  type="number"
                  className="modal-input"
                  min={8}
                  max={18}
                  value={draft.yAxisTickFontSize}
                  onChange={(e) => onDraftChange({ ...draft, yAxisTickFontSize: Number(e.target.value) })}
                />
              </label>
            </div>
          </div>
        </section>

        <section className="compare-chart-modal-section">
          <h5>Display</h5>
          <div className="compare-chart-appearance-global">
            <label className="compare-chart-check">
              <input
                type="checkbox"
                checked={draft.showGrid}
                onChange={(e) => onDraftChange({ ...draft, showGrid: e.target.checked })}
              />
              <span>Show grid</span>
            </label>
            <label className="compare-chart-check">
              <input
                type="checkbox"
                checked={draft.showLegend}
                onChange={(e) => onDraftChange({ ...draft, showLegend: e.target.checked })}
              />
              <span>Show legend</span>
            </label>
            {chartType === "line" ? (
              <>
                <label className="compare-chart-check">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.showLineValues)}
                    onChange={(e) => onDraftChange({ ...draft, showLineValues: e.target.checked })}
                  />
                  <span>Show point values</span>
                </label>
                <label className="field-label compare-chart-line-width">
                  <span>Line width</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={draft.lineWidth}
                    onChange={(e) => onDraftChange({ ...draft, lineWidth: Number(e.target.value) })}
                  />
                </label>
              </>
            ) : null}
          </div>
        </section>

        <div className="compare-chart-modal-footer">
          <button type="button" className="secondary-cta small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-cta small" disabled={visibleCount < 1} onClick={onSave}>
            Save appearance
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

function hydrateBatchIds(stored) {
  const base = emptyBatchIds(QUAD_COMPARE_SIDES);
  if (!stored) return base;
  QUAD_COMPARE_SIDES.forEach((sideId) => {
    if (typeof stored[sideId] === "string") base[sideId] = stored[sideId];
  });
  return base;
}

export default function CompareChartWorkspace({
  apiBase,
  batchRunResults
}) {
  const restoredSession = useMemo(() => readCompareChartWorkspaceSession(), []);
  const [slotCount, setSlotCount] = useState(() => restoredSession?.slotCount ?? 2);
  const [batchIds, setBatchIds] = useState(() => hydrateBatchIds(restoredSession?.batchIds));
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

  const [chartConfigs, setChartConfigs] = useState(() => restoredSession?.chartConfigs ?? []);
  const [chartPresets, setChartPresets] = useState(() => readChartPresets());
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState(() => defaultDraft([]));
  const [presetSaveModalOpen, setPresetSaveModalOpen] = useState(false);
  const [presetSaveChartId, setPresetSaveChartId] = useState(null);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [appearanceModalOpen, setAppearanceModalOpen] = useState(false);
  const [appearanceChartId, setAppearanceChartId] = useState(null);
  const [appearanceDraft, setAppearanceDraft] = useState(null);
  const panelRefs = useRef({});

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeCompareChartWorkspaceSession({ slotCount, batchIds, chartConfigs });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [slotCount, batchIds, chartConfigs]);

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
    setConfigDraft(defaultDraft(densityLabels));
    setConfigModalOpen(true);
  };

  const handleConfigPresetSelect = (presetId) => {
    if (!presetId) {
      setConfigDraft(defaultDraft(densityLabels));
      return;
    }
    const preset = chartPresets.find((item) => item.id === presetId);
    const nextDraft = applyChartPresetToDraft(preset?.config, densityLabels, catalog);
    if (!nextDraft) {
      window.alert("This preset cannot be applied with the current batch data.");
      return;
    }
    setConfigDraft({ ...nextDraft, presetId });
  };

  const handleDeleteChartPreset = (presetId) => {
    if (!presetId) return;
    if (!window.confirm("Delete this chart preset?")) return;
    const next = deleteChartPreset(presetId);
    setChartPresets(next);
    if (configDraft.presetId === presetId) {
      setConfigDraft(defaultDraft(densityLabels));
    }
  };

  const openSaveChartPreset = (chartId, chartIdx) => {
    const chart = chartConfigs.find((item) => item.id === chartId);
    if (!chart) return;
    const chartUi = chartUiForDisplay(chart, catalogMap);
    const defaultLabel =
      chartUi.chartTitle?.trim() || resolvePanelTitle(chart, chartIdx) || `Chart preset ${chartPresets.length + 1}`;
    setPresetSaveChartId(chartId);
    setPresetNameDraft(defaultLabel);
    setPresetSaveModalOpen(true);
  };

  const confirmSaveChartPreset = () => {
    const chart = chartConfigs.find((item) => item.id === presetSaveChartId);
    if (!chart) {
      setPresetSaveModalOpen(false);
      return;
    }
    const saved = saveChartPreset(presetNameDraft, chart);
    if (!saved) {
      window.alert("Could not save preset (chart has no valid metrics).");
      return;
    }
    setChartPresets(readChartPresets());
    setPresetSaveModalOpen(false);
    setPresetSaveChartId(null);
    setPresetNameDraft("");
  };

  const buildChartRowsForAxis = useCallback(
    (chart) => {
      const topoKeys = chart.selectedMetricKeys.filter((key) => catalogMap.get(key)?.scope === "topology");
      const densityKeys = chart.selectedMetricKeys.filter((key) => catalogMap.get(key)?.scope === "density");
      if (chart.mode === "densityMean") {
        return buildDensityMeanRows(compareChartInput, topoKeys, densityKeys).filter((row) =>
          chart.selectedDensityLabels.includes(row.densityLabel)
        );
      }
      const selectedPairMap = new Map(
        densityPairs
          .filter((pair) => chart.selectedDensityLabels.includes(pair.densityLabel))
          .map((pair) => [pair.densityLabel, pair])
      );
      const rows = [];
      chart.selectedDensityLabels.forEach((densityLabel) => {
        const pair = selectedPairMap.get(densityLabel);
        if (pair) {
          rows.push(...buildPerDensityChartRows(pair, chart.selectedMetricKeys, sideIds));
        }
      });
      return rows;
    },
    [catalogMap, compareChartInput, densityPairs, sideIds]
  );

  const openEditChart = (chartId, chartIdx) => {
    const found = chartConfigs.find((item) => item.id === chartId);
    if (!found) return;
    const metricKeys = filterMetricKeysWithLowerBound(found.selectedMetricKeys, compareChartInput);
    const baseDefs = seriesDefs(metricKeys, catalogMap, sideIds, sideLabelsById, compareChartInput);
    const plotDefs = filterPlotDefs(
      applySeriesStyles(baseDefs, found.ui?.seriesStyles ?? {}, metricKeys),
      found.mode
    );
    const axisRows = buildChartRowsForAxis(found);
    const autoYDomain = computeChartAutoYDomain({
      rows: axisRows,
      plotDefs,
      chartType: found.chartType,
      chartMode: found.mode,
      ui: mergeChartUi(found.ui),
      sideIds,
      compareChartInput
    });
    setAppearanceChartId(chartId);
    const convergenceSeriesOnly =
      plotDefs.length > 0 && plotDefs.every((def) => def.metricKey === "convergence_count");
    setAppearanceDraft(
      buildAppearanceDraft(found, baseDefs, chartIdx, {
        autoYDomain,
        catalogMap,
        defaultAxisLabels: defaultChartAxisLabels(found.mode, found.selectedMetricKeys, catalogMap),
        convergenceSeriesOnly
      })
    );
    setAppearanceModalOpen(true);
  };

  const saveNewChart = () => {
    const sanitized = {
      mode: configDraft.mode,
      chartType: configDraft.chartType,
      selectedMetricKeys: [...new Set(configDraft.selectedMetricKeys)],
      selectedDensityLabels: [...new Set(configDraft.selectedDensityLabels)]
    };
    if (!sanitized.selectedMetricKeys.length || !sanitized.selectedDensityLabels.length) return;
    setChartConfigs((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ...sanitized,
        ui: (() => {
          const base = configDraft.presetUi ? mergeChartUi(configDraft.presetUi) : defaultChartUi();
          const yDefault = defaultYAxisLabelFromMetrics(sanitized.selectedMetricKeys, catalogMap);
          return {
            ...base,
            yAxisLabel: String(base.yAxisLabel ?? "").trim() || yDefault,
            showYAxisLabel: base.showYAxisLabel !== false
          };
        })()
      }
    ]);
    setConfigModalOpen(false);
  };

  const saveAppearance = () => {
    if (!appearanceChartId || !appearanceDraft) return;
    if (!appearanceDraft.series.some((row) => !row.hidden)) return;
    if (
      appearanceDraft.yAxisManual &&
      Number(appearanceDraft.yAxisMax) <= Number(appearanceDraft.yAxisMin)
    ) {
      window.alert("Y max must be greater than Y min.");
      return;
    }
    setChartConfigs((prev) =>
      prev.map((chart) =>
        chart.id === appearanceChartId
          ? {
              ...chart,
              ui: appearanceDraftToUi(appearanceDraft, mergeChartUi(chart.ui))
            }
          : chart
      )
    );
    setAppearanceModalOpen(false);
    setAppearanceChartId(null);
    setAppearanceDraft(null);
  };

  const downloadChartPdf = async (chartId, title) => {
    const panel = panelRefs.current[chartId];
    try {
      const ok = await downloadPanelChartsAsPdf(panel, title);
      if (!ok) {
        window.alert("Chart PDF is not ready yet. Wait for the chart to finish rendering.");
      }
    } catch (err) {
      console.error(err);
      window.alert("Could not export IEEE figure PDF. Try again after the chart finishes rendering.");
    }
  };

  const downloadChartLatex = (chartId, chart, chartIdx) => {
    const chartUi = chartUiForDisplay(chart, catalogMap);
    const metricKeys = filterMetricKeysWithLowerBound(chart.selectedMetricKeys, compareChartInput);
    const defs = applySeriesStyles(
      seriesDefs(metricKeys, catalogMap, sideIds, sideLabelsById, compareChartInput),
      chartUi.seriesStyles,
      metricKeys
    );
    const defaultCardTitle = chart.mode === "densityMean" ? "Density mean comparison" : "";
    const figures = buildChartFiguresForPanel({
      chart,
      chartUi,
      defs,
      densityPairs,
      sideIds,
      compareChartInput,
      catalogMap,
      defaultCardTitle
    });
    const panelTitle = resolvePanelTitle(chart, chartIdx);
    if (
      !downloadPanelChartsAsLatex(figures, {
        chart,
        chartIdx,
        chartUi,
        panelTitle
      })
    ) {
      window.alert("No chart data to export as LaTeX.");
    }
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
          const chartUi = chartUiForDisplay(chart, catalogMap);
          const metricKeys = filterMetricKeysWithLowerBound(chart.selectedMetricKeys, compareChartInput);
          const baseDefs = seriesDefs(metricKeys, catalogMap, sideIds, sideLabelsById, compareChartInput);
          const defs = applySeriesStyles(baseDefs, chartUi.seriesStyles, metricKeys);
          const titleMetrics = metricSummary(metricKeys, catalogMap);
          const panelTitle = resolvePanelTitle(chart, idx);
          const defaultCardTitle = chart.mode === "densityMean" ? "Density mean comparison" : "";
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
            <div
              key={chart.id}
              className="compare-chart-panel"
              ref={(el) => {
                if (el) panelRefs.current[chart.id] = el;
                else delete panelRefs.current[chart.id];
              }}
            >
              <div className="compare-chart-panel-header">
                <strong>{panelTitle}</strong>
                <div className="compare-chart-panel-actions">
                  <button
                    type="button"
                    className="secondary-cta small"
                    title="IEEE single-column PDF (3.5×2.4 in, 7–8 pt fonts)"
                    onClick={() => downloadChartPdf(chart.id, panelTitle)}
                  >
                    Download PDF
                  </button>
                  <button
                    type="button"
                    className="secondary-cta small"
                    title="pgfplots/TikZ snippet (3.5×2.4 in, 7–8 pt)"
                    onClick={() => downloadChartLatex(chart.id, chart, idx)}
                  >
                    Download LaTeX
                  </button>
                  <button type="button" className="secondary-cta small" onClick={() => openEditChart(chart.id, idx)}>
                    Edit
                  </button>
                  <button type="button" className="secondary-cta small" onClick={() => openSaveChartPreset(chart.id, idx)}>
                    Save preset
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
                      title={chartUi.cardTitle?.trim() || `Density ${densityLabel}`}
                      rows={rows}
                      xKey="x"
                      xTickFormatter={(value) => (Number(value) === 0 ? "0*" : String(value))}
                      chartType={chart.chartType}
                      defs={defs}
                      ui={chartUi}
                      chartMode={chart.mode}
                      sideIds={sideIds}
                      sideLabelsById={sideLabelsById}
                      compareChartInput={compareChartInput}
                    />
                  );
                })
              ) : (
                <ChartCard
                  title={chartUi.cardTitle?.trim() || defaultCardTitle || "Density mean comparison"}
                  rows={meanRows}
                  xKey="x"
                  xTickFormatter={(value) => {
                    if (Number(value) === 0) return "0*";
                    const found = meanRows.find((row) => Number(row.x) === Number(value));
                    return found?.densityLabel ?? String(value);
                  }}
                  chartType={chart.chartType}
                  defs={defs}
                  ui={chartUi}
                  chartMode={chart.mode}
                  sideIds={sideIds}
                  sideLabelsById={sideLabelsById}
                  compareChartInput={compareChartInput}
                />
              )}
            </div>
          );
        })
          : null}
      </div>

      <ChartConfigModal
        open={configModalOpen}
        title="Create new chart"
        draft={configDraft}
        densityLabels={densityLabels}
        catalog={catalog}
        presets={chartPresets}
        onPresetSelect={handleConfigPresetSelect}
        onPresetDelete={handleDeleteChartPreset}
        onClose={() => setConfigModalOpen(false)}
        onDraftChange={setConfigDraft}
        onSave={saveNewChart}
      />

      <ChartPresetNameModal
        open={presetSaveModalOpen}
        value={presetNameDraft}
        setValue={setPresetNameDraft}
        defaultLabel="Chart preset"
        onCancel={() => {
          setPresetSaveModalOpen(false);
          setPresetSaveChartId(null);
          setPresetNameDraft("");
        }}
        onConfirm={confirmSaveChartPreset}
      />

      <ChartAppearanceModal
        open={appearanceModalOpen}
        draft={appearanceDraft}
        chartType={chartConfigs.find((c) => c.id === appearanceChartId)?.chartType ?? "line"}
        onClose={() => {
          setAppearanceModalOpen(false);
          setAppearanceChartId(null);
          setAppearanceDraft(null);
        }}
        onDraftChange={setAppearanceDraft}
        onSave={saveAppearance}
      />
    </section>
  );
}


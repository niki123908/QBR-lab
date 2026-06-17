import { defaultSeriesMarker, normalizeSeriesMarker, resolveSeriesMarker } from "./compareChartMarkers.js";

export function normalizeSeriesStylesMap(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
}

function clampOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0.05, n));
}

/** Apply per-series UI overrides; drop hidden series from plotting. */
export function applySeriesStyles(defs, seriesStyles = {}, metricKeys = []) {
  if (!defs?.length) return [];
  const styles = normalizeSeriesStylesMap(seriesStyles);
  return defs
    .map((def) => {
      const style = styles[def.dataKey] || {};
      const name = String(style.name ?? "").trim();
      const color = String(style.color ?? "").trim();
      const markerOverride = normalizeSeriesMarker(style.marker);
      return {
        ...def,
        name: name || def.name,
        color: color || def.color,
        opacity: style.opacity != null ? clampOpacity(style.opacity) : 1,
        marker: markerOverride ?? resolveSeriesMarker(def, metricKeys),
        hidden: Boolean(style.hidden)
      };
    })
    .filter((def) => !def.hidden);
}

export function defaultPanelTitle(chart, idx) {
  const mode = chart.mode === "densityMean" ? "Density mean" : "Density";
  const kind = chart.chartType === "bar" ? "bar" : "line";
  return `Chart ${idx + 1}: ${mode} · ${kind}`;
}

export function resolvePanelTitle(chart, idx) {
  const custom = String(chart.ui?.chartTitle ?? "").trim();
  return custom || defaultPanelTitle(chart, idx);
}

export function resolveYAxisDomain(autoDomain, ui) {
  const auto = Array.isArray(autoDomain) && autoDomain.length === 2 ? autoDomain : [0, 1];
  if (!ui?.yAxisManual) return auto;
  const lo = Number(ui.yAxisMin);
  const hi = Number(ui.yAxisMax);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return [lo, hi];
  if (Number.isFinite(lo) && !Number.isFinite(hi)) return [lo, auto[1]];
  if (!Number.isFinite(lo) && Number.isFinite(hi)) return [auto[0], hi];
  return auto;
}

export function defaultYAxisLabelFromMetrics(metricKeys, catalogMap) {
  const labels = [];
  const seenKeys = new Set();
  for (const key of metricKeys ?? []) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const metric = catalogMap?.get?.(key);
    const label = String(metric?.label ?? "").trim();
    if (label) labels.push(label);
  }
  if (!labels.length) return "Value";
  if (labels.length === 1) return labels[0];
  return labels.join(" / ");
}

export function defaultChartAxisLabels(chartMode, metricKeys, catalogMap) {
  const x = chartMode === "densityMean" ? "Density (nodes)" : "Topology index";
  const y =
    metricKeys?.length && catalogMap ? defaultYAxisLabelFromMetrics(metricKeys, catalogMap) : "Value";
  return { x, y };
}

/** Merge stored UI with metric-derived Y-axis label when none was saved. */
export function resolveChartDisplayUi(rawUi, chart, catalogMap) {
  const ui = rawUi && typeof rawUi === "object" && !Array.isArray(rawUi) ? { ...rawUi } : {};
  const yDefault = defaultYAxisLabelFromMetrics(chart?.selectedMetricKeys, catalogMap);
  const yAxisLabel = String(ui.yAxisLabel ?? "").trim() || yDefault;
  const showYAxisLabel = ui.showYAxisLabel === false ? false : ui.showYAxisLabel === true || Boolean(yAxisLabel);
  return { ...ui, yAxisLabel, showYAxisLabel };
}

export function buildAppearanceDraft(chart, defs, idx, axisContext = null) {
  const ui = chart.ui ?? {};
  const seriesStyles = normalizeSeriesStylesMap(ui.seriesStyles);
  const autoY = axisContext?.autoYDomain ?? [0, 1];
  const defaultLabels =
    axisContext?.defaultAxisLabels ??
    defaultChartAxisLabels(chart.mode, chart.selectedMetricKeys, axisContext?.catalogMap);
  return {
    chartTitle: ui.chartTitle ?? "",
    cardTitle: ui.cardTitle ?? "",
    latexCaption: ui.latexCaption ?? "",
    latexLabel: ui.latexLabel ?? "",
    showGrid: ui.showGrid !== false,
    showLegend: ui.showLegend !== false,
    showLineValues:
      ui.showLineValues != null
        ? ui.showLineValues === true
        : Boolean(axisContext?.convergenceSeriesOnly),
    lineWidth: Number(ui.lineWidth) || 3,
    yAxisManual: Boolean(ui.yAxisManual),
    yAxisMin: Number.isFinite(Number(ui.yAxisMin)) ? Number(ui.yAxisMin) : autoY[0],
    yAxisMax: Number.isFinite(Number(ui.yAxisMax)) ? Number(ui.yAxisMax) : autoY[1],
    yAxisAutoMin: autoY[0],
    yAxisAutoMax: autoY[1],
    showXAxisTicks: ui.showXAxisTicks !== false,
    showYAxisTicks: ui.showYAxisTicks !== false,
    showXAxisLabel: Boolean(ui.showXAxisLabel),
    showYAxisLabel: Boolean(ui.showYAxisLabel),
    xAxisLabel: ui.xAxisLabel ?? defaultLabels.x,
    yAxisLabel: ui.yAxisLabel ?? defaultLabels.y,
    xAxisTickFontSize: Math.min(18, Math.max(8, Number(ui.xAxisTickFontSize) || 11)),
    yAxisTickFontSize: Math.min(18, Math.max(8, Number(ui.yAxisTickFontSize) || 11)),
    series: defs.map((def) => {
      const style = seriesStyles[def.dataKey] || {};
      const metricKeys = chart.selectedMetricKeys ?? [];
      return {
        dataKey: def.dataKey,
        metricKey: def.metricKey,
        defaultName: def.name,
        name: style.name ?? def.name,
        color: style.color ?? def.color,
        opacity: style.opacity != null ? clampOpacity(style.opacity) : 1,
        marker: normalizeSeriesMarker(style.marker) ?? defaultSeriesMarker(def.metricKey, metricKeys),
        hidden: Boolean(style.hidden)
      };
    })
  };
}

export function appearanceDraftToUi(draft, prevUi = {}) {
  const seriesStyles = {};
  (draft.series ?? []).forEach((row) => {
    const name = String(row.name ?? "").trim();
    const color = String(row.color ?? "").trim();
    const marker = normalizeSeriesMarker(row.marker);
    seriesStyles[row.dataKey] = {
      ...(name ? { name } : {}),
      ...(color ? { color } : {}),
      ...(marker ? { marker } : {}),
      opacity: clampOpacity(row.opacity),
      hidden: Boolean(row.hidden)
    };
  });

  const chartTitle = String(draft.chartTitle ?? "").trim();
  const cardTitle = String(draft.cardTitle ?? "").trim();
  const latexCaption = String(draft.latexCaption ?? "").trim();
  const latexLabel = String(draft.latexLabel ?? "").trim();
  const next = {
    ...prevUi,
    showGrid: Boolean(draft.showGrid),
    showLegend: Boolean(draft.showLegend),
    showLineValues: Boolean(draft.showLineValues),
    lineWidth: Math.min(8, Math.max(1, Number(draft.lineWidth) || 3)),
    yAxisManual: Boolean(draft.yAxisManual),
    yAxisMin: Number(draft.yAxisMin),
    yAxisMax: Number(draft.yAxisMax),
    showXAxisTicks: Boolean(draft.showXAxisTicks),
    showYAxisTicks: Boolean(draft.showYAxisTicks),
    showXAxisLabel: Boolean(draft.showXAxisLabel),
    showYAxisLabel: Boolean(draft.showYAxisLabel),
    xAxisLabel: String(draft.xAxisLabel ?? "").trim(),
    yAxisLabel: String(draft.yAxisLabel ?? "").trim(),
    xAxisTickFontSize: Math.min(18, Math.max(8, Number(draft.xAxisTickFontSize) || 11)),
    yAxisTickFontSize: Math.min(18, Math.max(8, Number(draft.yAxisTickFontSize) || 11)),
    seriesStyles
  };
  if (!next.yAxisManual) {
    delete next.yAxisMin;
    delete next.yAxisMax;
  }
  if (chartTitle) next.chartTitle = chartTitle;
  else delete next.chartTitle;
  if (cardTitle) next.cardTitle = cardTitle;
  else delete next.cardTitle;
  if (latexCaption) next.latexCaption = latexCaption;
  else delete next.latexCaption;
  if (latexLabel) next.latexLabel = latexLabel;
  else delete next.latexLabel;
  return next;
}

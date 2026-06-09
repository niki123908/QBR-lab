const STORAGE_KEY = "qbr.compare-chart-workspace";
const MAX_CHART_SLOTS = 4;
const SIDE_IDS = ["A", "B", "C", "D"];

function clampSlotCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(MAX_CHART_SLOTS, Math.round(n)));
}

function sanitizeChartUi(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const seriesStyles =
    raw.seriesStyles && typeof raw.seriesStyles === "object" && !Array.isArray(raw.seriesStyles)
      ? raw.seriesStyles
      : {};
  return { ...raw, seriesStyles };
}

function sanitizeBatchIds(raw) {
  const out = {};
  SIDE_IDS.forEach((sideId) => {
    const id = raw?.[sideId];
    out[sideId] = typeof id === "string" ? id : "";
  });
  return out;
}

function sanitizeChartConfigs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((chart, idx) => {
      if (!chart || typeof chart !== "object") return null;
      const mode = chart.mode === "densityMean" ? "densityMean" : "density";
      const chartType = chart.chartType === "bar" ? "bar" : "line";
      const selectedMetricKeys = Array.isArray(chart.selectedMetricKeys)
        ? [...new Set(chart.selectedMetricKeys.filter((k) => typeof k === "string" && k))]
        : [];
      const selectedDensityLabels = Array.isArray(chart.selectedDensityLabels)
        ? [...new Set(chart.selectedDensityLabels.map((l) => String(l)))]
        : [];
      if (!selectedMetricKeys.length || !selectedDensityLabels.length) return null;
      const id = typeof chart.id === "string" && chart.id ? chart.id : `restored-${idx}-${Date.now()}`;
      const ui = sanitizeChartUi(chart.ui);
      return {
        id,
        mode,
        chartType,
        selectedMetricKeys,
        selectedDensityLabels,
        ...(ui ? { ui } : {})
      };
    })
    .filter(Boolean);
}

export function readCompareChartWorkspaceSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      slotCount: clampSlotCount(parsed.slotCount),
      batchIds: sanitizeBatchIds(parsed.batchIds),
      chartConfigs: sanitizeChartConfigs(parsed.chartConfigs)
    };
  } catch {
    return null;
  }
}

export function writeCompareChartWorkspaceSession({ slotCount, batchIds, chartConfigs }) {
  try {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      slotCount: clampSlotCount(slotCount),
      batchIds: sanitizeBatchIds(batchIds),
      chartConfigs: sanitizeChartConfigs(chartConfigs)
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

export function clearCompareChartWorkspaceSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

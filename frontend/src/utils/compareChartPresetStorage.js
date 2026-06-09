const PRESET_STORAGE_KEY = "qbr.compare-chart-presets";
const MAX_PRESETS = 40;

function sanitizeChartUi(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const seriesStyles =
    raw.seriesStyles && typeof raw.seriesStyles === "object" && !Array.isArray(raw.seriesStyles)
      ? raw.seriesStyles
      : {};
  return { ...raw, seriesStyles };
}

function sanitizePresetConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mode = raw.mode === "densityMean" ? "densityMean" : "density";
  const chartType = raw.chartType === "bar" ? "bar" : "line";
  const selectedMetricKeys = Array.isArray(raw.selectedMetricKeys)
    ? [...new Set(raw.selectedMetricKeys.filter((k) => typeof k === "string" && k))]
    : [];
  const selectedDensityLabels = Array.isArray(raw.selectedDensityLabels)
    ? [...new Set(raw.selectedDensityLabels.map((l) => String(l)))]
    : [];
  if (!selectedMetricKeys.length) return null;
  const ui = sanitizeChartUi(raw.ui);
  return {
    mode,
    chartType,
    selectedMetricKeys,
    selectedDensityLabels,
    ...(ui ? { ui } : {})
  };
}

function sanitizePresetEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const config = sanitizePresetConfig(raw.config);
  if (!config) return null;
  const name = String(raw.name ?? "").trim() || "Chart preset";
  const id = typeof raw.id === "string" && raw.id ? raw.id : `preset-${Date.now()}`;
  return {
    id,
    name,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : new Date().toISOString(),
    config
  };
}

export function readChartPresets() {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizePresetEntry).filter(Boolean);
  } catch {
    return [];
  }
}

function writeChartPresets(presets) {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets.slice(0, MAX_PRESETS)));
  } catch {
    /* ignore */
  }
}

export function chartToPresetConfig(chart) {
  if (!chart || typeof chart !== "object") return null;
  return sanitizePresetConfig({
    mode: chart.mode,
    chartType: chart.chartType,
    selectedMetricKeys: chart.selectedMetricKeys,
    selectedDensityLabels: chart.selectedDensityLabels,
    ui: chart.ui
  });
}

export function saveChartPreset(name, chart) {
  const config = chartToPresetConfig(chart);
  if (!config) return null;
  const presets = readChartPresets();
  const entry = {
    id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: String(name ?? "").trim() || "Chart preset",
    savedAt: new Date().toISOString(),
    config
  };
  writeChartPresets([entry, ...presets]);
  return entry;
}

export function deleteChartPreset(presetId) {
  if (!presetId) return readChartPresets();
  const next = readChartPresets().filter((item) => item.id !== presetId);
  writeChartPresets(next);
  return next;
}

export function applyChartPresetToDraft(presetConfig, densityLabels, catalog) {
  const config = sanitizePresetConfig(presetConfig);
  if (!config) return null;

  const labels = Array.isArray(densityLabels) ? densityLabels.map(String) : [];
  const labelSet = new Set(labels);
  const allowedMetrics = new Set(
    (config.mode === "densityMean"
      ? [...(catalog?.topologyMetrics ?? []), ...(catalog?.densityMetrics ?? [])]
      : catalog?.topologyMetrics ?? []
    ).map((m) => m.key)
  );

  const selectedMetricKeys = config.selectedMetricKeys.filter((key) => allowedMetrics.has(key));
  if (!selectedMetricKeys.length) return null;

  let selectedDensityLabels = config.selectedDensityLabels.filter((label) => labelSet.has(String(label)));
  if (!selectedDensityLabels.length && labels.length) {
    selectedDensityLabels = [...labels];
  }
  if (!selectedDensityLabels.length) return null;

  return {
    mode: config.mode,
    chartType: config.chartType,
    selectedMetricKeys,
    selectedDensityLabels,
    presetUi: config.ui ?? null
  };
}

export function presetSummaryLabel(preset) {
  if (!preset?.config) return preset?.name ?? "";
  const mode = preset.config.mode === "densityMean" ? "Density mean" : "Density";
  const kind = preset.config.chartType === "bar" ? "bar" : "line";
  const metrics = preset.config.selectedMetricKeys.length;
  const densities = preset.config.selectedDensityLabels.length;
  return `${preset.name} · ${mode} · ${kind} · ${metrics} metrics · ${densities} densities`;
}

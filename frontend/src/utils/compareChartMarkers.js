export const SERIES_MARKER_SHAPES = ["circle", "cross", "triangle", "diamond", "square", "none"];

export const SERIES_MARKER_OPTIONS = [
  { value: "circle", label: "Circle" },
  { value: "cross", label: "Cross" },
  { value: "triangle", label: "Triangle" },
  { value: "diamond", label: "Diamond" },
  { value: "square", label: "Square" },
  { value: "none", label: "Line only" }
];

const METRIC_DEFAULT_SHAPES = ["circle", "cross", "triangle", "diamond", "square"];

export function normalizeSeriesMarker(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return SERIES_MARKER_SHAPES.includes(v) ? v : null;
}

export function defaultSeriesMarker(metricKey, metricKeys = []) {
  const keys = Array.isArray(metricKeys) ? metricKeys : [];
  const idx = keys.indexOf(metricKey);
  return METRIC_DEFAULT_SHAPES[(idx >= 0 ? idx : 0) % METRIC_DEFAULT_SHAPES.length];
}

export function resolveSeriesMarker(def, metricKeys = []) {
  return normalizeSeriesMarker(def?.marker) ?? defaultSeriesMarker(def?.metricKey, metricKeys);
}

export function rechartsLegendType(shape) {
  const s = normalizeSeriesMarker(shape) ?? "circle";
  if (s === "none") return "line";
  if (s === "cross") return "cross";
  if (s === "triangle") return "triangle";
  if (s === "diamond") return "diamond";
  if (s === "square") return "square";
  return "circle";
}

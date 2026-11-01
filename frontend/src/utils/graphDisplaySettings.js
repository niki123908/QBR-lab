/** Default Tableau-like palette for timeslot / hop coloring. */
export const DEFAULT_TIMESLOT_COLORS = [
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

export const INITIAL_GRAPH_DISPLAY_SETTINGS = {
  node_size: 2,
  label_size: 2.4,
  edge_width: 0.45,
  /** Offset from node center; labels use text-anchor=middle so (0,0) is truly centered. */
  label_offset_x: 0,
  label_offset_y: 0,
  edge_opacity: 1,
  timeslot_colors: [...DEFAULT_TIMESLOT_COLORS]
};

function normalizeColor(value, fallback) {
  const raw = String(value ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const [r, g, b] = raw.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeGraphDisplaySettings(input = {}) {
  const defaults = INITIAL_GRAPH_DISPLAY_SETTINGS;
  const colorsIn = Array.isArray(input.timeslot_colors) ? input.timeslot_colors : defaults.timeslot_colors;
  const timeslot_colors = DEFAULT_TIMESLOT_COLORS.map((fallback, idx) =>
    normalizeColor(colorsIn[idx], fallback)
  );
  return {
    node_size: clampNum(input.node_size, 0.5, 8, defaults.node_size),
    label_size: clampNum(input.label_size, 0.5, 12, defaults.label_size),
    edge_width: clampNum(input.edge_width, 0.05, 5, defaults.edge_width),
    label_offset_x: clampNum(input.label_offset_x, -20, 20, defaults.label_offset_x),
    label_offset_y: clampNum(input.label_offset_y, -20, 20, defaults.label_offset_y),
    edge_opacity: clampNum(input.edge_opacity, 0, 1, defaults.edge_opacity),
    timeslot_colors
  };
}

export function colorForTimeslot(timeslot, colors = DEFAULT_TIMESLOT_COLORS) {
  if (!Number.isFinite(timeslot) || timeslot <= 0) return "#9da5bf";
  const palette = Array.isArray(colors) && colors.length ? colors : DEFAULT_TIMESLOT_COLORS;
  return palette[(timeslot - 1) % palette.length] ?? "#9da5bf";
}

export const GRAPH_DISPLAY_SETTINGS_STORAGE_KEY = "qbr.graph-display-settings-v1";

export function readGraphDisplaySettings() {
  try {
    const raw = localStorage.getItem(GRAPH_DISPLAY_SETTINGS_STORAGE_KEY);
    if (!raw) return normalizeGraphDisplaySettings(INITIAL_GRAPH_DISPLAY_SETTINGS);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return normalizeGraphDisplaySettings(INITIAL_GRAPH_DISPLAY_SETTINGS);
    }
    return normalizeGraphDisplaySettings(parsed);
  } catch {
    return normalizeGraphDisplaySettings(INITIAL_GRAPH_DISPLAY_SETTINGS);
  }
}

export function writeGraphDisplaySettings(settings) {
  const next = normalizeGraphDisplaySettings(settings);
  try {
    localStorage.setItem(GRAPH_DISPLAY_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode
  }
  return next;
}

export const BEST_DELAY_OVERLAY_OPACITY_STORAGE_KEY = "qbr.best-delay-overlay-opacity-v1";

export function readBestDelayOverlayOpacity() {
  try {
    const raw = localStorage.getItem(BEST_DELAY_OVERLAY_OPACITY_STORAGE_KEY);
    if (raw == null || raw === "") return 1;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
  } catch {
    return 1;
  }
}

export function writeBestDelayOverlayOpacity(value) {
  const n = Number(value);
  const next = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  try {
    localStorage.setItem(BEST_DELAY_OVERLAY_OPACITY_STORAGE_KEY, String(next));
  } catch {
    // ignore
  }
  return next;
}

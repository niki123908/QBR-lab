import {
  DEFAULT_DECISION_TREE_EDGE_OPACITY,
  DEFAULT_DECISION_TREE_EDGE_SCALE,
  DEFAULT_DECISION_TREE_FONT_SCALE,
  DEFAULT_DECISION_TREE_NODE_SCALE,
  DEFAULT_DECISION_TREE_ROW_SPREAD
} from "../components/PlaygroundStateTree";

export const DECISION_TREE_LAYOUT_STORAGE_KEY = "qbr.decision-tree-layout";

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function readStoredDecisionTreeLayout() {
  try {
    const raw = localStorage.getItem(DECISION_TREE_LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      rowSpread: clampNum(parsed.rowSpread, 0.5, 2.5, DEFAULT_DECISION_TREE_ROW_SPREAD),
      fontScale: clampNum(parsed.fontScale, 0.5, 3, DEFAULT_DECISION_TREE_FONT_SCALE),
      edgeScale: clampNum(parsed.edgeScale, 0.4, 3, DEFAULT_DECISION_TREE_EDGE_SCALE),
      nodeScale: clampNum(parsed.nodeScale, 0.4, 3, DEFAULT_DECISION_TREE_NODE_SCALE),
      edgeOpacity: clampNum(parsed.edgeOpacity, 0.15, 1, DEFAULT_DECISION_TREE_EDGE_OPACITY)
    };
  } catch {
    return null;
  }
}

export function saveDecisionTreeLayoutAsDefault(layout) {
  const payload = {
    rowSpread: clampNum(layout.rowSpread, 0.5, 2.5, DEFAULT_DECISION_TREE_ROW_SPREAD),
    fontScale: clampNum(layout.fontScale, 0.5, 3, DEFAULT_DECISION_TREE_FONT_SCALE),
    edgeScale: clampNum(layout.edgeScale, 0.4, 3, DEFAULT_DECISION_TREE_EDGE_SCALE),
    nodeScale: clampNum(layout.nodeScale, 0.4, 3, DEFAULT_DECISION_TREE_NODE_SCALE),
    edgeOpacity: clampNum(layout.edgeOpacity, 0.15, 1, DEFAULT_DECISION_TREE_EDGE_OPACITY),
    savedAt: new Date().toISOString()
  };
  localStorage.setItem(DECISION_TREE_LAYOUT_STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

let cachedInitialLayout = null;

export function getInitialDecisionTreeLayout() {
  if (cachedInitialLayout) return cachedInitialLayout;
  const stored = readStoredDecisionTreeLayout();
  cachedInitialLayout = {
    rowSpread: stored?.rowSpread ?? DEFAULT_DECISION_TREE_ROW_SPREAD,
    fontScale: stored?.fontScale ?? DEFAULT_DECISION_TREE_FONT_SCALE,
    edgeScale: stored?.edgeScale ?? DEFAULT_DECISION_TREE_EDGE_SCALE,
    nodeScale: stored?.nodeScale ?? DEFAULT_DECISION_TREE_NODE_SCALE,
    edgeOpacity: stored?.edgeOpacity ?? DEFAULT_DECISION_TREE_EDGE_OPACITY
  };
  return cachedInitialLayout;
}

export function refreshInitialDecisionTreeLayoutCache(layout) {
  cachedInitialLayout = {
    rowSpread: clampNum(layout.rowSpread, 0.5, 2.5, DEFAULT_DECISION_TREE_ROW_SPREAD),
    fontScale: clampNum(layout.fontScale, 0.5, 3, DEFAULT_DECISION_TREE_FONT_SCALE),
    edgeScale: clampNum(layout.edgeScale, 0.4, 3, DEFAULT_DECISION_TREE_EDGE_SCALE),
    nodeScale: clampNum(layout.nodeScale, 0.4, 3, DEFAULT_DECISION_TREE_NODE_SCALE),
    edgeOpacity: clampNum(layout.edgeOpacity, 0.15, 1, DEFAULT_DECISION_TREE_EDGE_OPACITY)
  };
  return cachedInitialLayout;
}

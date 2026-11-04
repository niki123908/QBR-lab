import { modeStorage, IS_ENERGY_MODE } from "../appMode.js";
export const SOURCE_NODE_APPEARANCE_STORAGE_KEY = "qbr.source-node-appearance";

export const DEFAULT_SOURCE_NODE_COLOR = IS_ENERGY_MODE ? "#ff0000" : "#ec5bb8";
export const DEFAULT_SOURCE_NODE_RADIUS = IS_ENERGY_MODE ? 2.5 : 1.6;

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeColor(value, fallback = DEFAULT_SOURCE_NODE_COLOR) {
  const raw = String(value ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const [r, g, b] = raw.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

export function normalizeSourceNodeAppearance(input = {}) {
  return {
    color: normalizeColor(input.color, DEFAULT_SOURCE_NODE_COLOR),
    radius: clampNum(input.radius, 0.6, 5, DEFAULT_SOURCE_NODE_RADIUS)
  };
}

export function readSourceNodeAppearance() {
  try {
    const raw = modeStorage.getItem(SOURCE_NODE_APPEARANCE_STORAGE_KEY);
    if (!raw) return normalizeSourceNodeAppearance();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return normalizeSourceNodeAppearance();
    return normalizeSourceNodeAppearance(parsed);
  } catch {
    return normalizeSourceNodeAppearance();
  }
}

export function writeSourceNodeAppearance(appearance) {
  const next = normalizeSourceNodeAppearance(appearance);
  try {
    modeStorage.setItem(SOURCE_NODE_APPEARANCE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode
  }
  return next;
}

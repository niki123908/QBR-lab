import { normalizeCompareChartInput } from "./compareChartSides.js";

/** @deprecated Prefer per-side `${sideId}__lower_bound` series. Kept for saved styles. */
export const LOWER_BOUND_DATA_KEY = "LB__lower_bound";
export const LOWER_BOUND_SERIES_LABEL = "lower bound";

export function isQbrBatchResult(result) {
  return String(result?.algorithm_id ?? "").trim().toLowerCase() === "qbr";
}

export function listQbrSidesForLowerBound(compareChartInput) {
  const normalized = normalizeCompareChartInput(compareChartInput);
  return (normalized.sides ?? [])
    .filter((side) => isQbrBatchResult(side.result))
    .map((side) => side.sideId);
}

export function findQbrSideForLowerBound(compareChartInput) {
  return listQbrSidesForLowerBound(compareChartInput)[0] ?? null;
}

export function hasQbrLowerBoundSource(compareChartInput) {
  return listQbrSidesForLowerBound(compareChartInput).length > 0;
}

export function filterMetricKeysWithLowerBound(metricKeys, compareChartInput) {
  const keys = Array.isArray(metricKeys) ? metricKeys : [];
  if (hasQbrLowerBoundSource(compareChartInput)) return keys;
  return keys.filter((key) => key !== "lower_bound");
}

export function lowerBoundDataKey(sideId) {
  return `${sideId}__lower_bound`;
}

export function lowerBoundSeriesLabel(sideLabel) {
  const label = String(sideLabel ?? "").trim();
  return label ? `${label} · lower bound` : LOWER_BOUND_SERIES_LABEL;
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ensure each plotted lower-bound series has values on every X where possible.
 * Fills gaps within each `${side}__lower_bound` / legacy LB key (episodes mode).
 */
export function materializeLowerBoundRows(rows, defs, qbrSideIdOrSides) {
  if (!rows?.length) return rows ?? [];
  const lbDefs = (defs ?? []).filter(
    (def) =>
      def?.metricKey === "lower_bound" ||
      def?.dataKey === LOWER_BOUND_DATA_KEY ||
      String(def?.dataKey ?? "").endsWith("__lower_bound")
  );
  if (!lbDefs.length) return rows;

  const sideIds = Array.isArray(qbrSideIdOrSides)
    ? qbrSideIdOrSides
    : qbrSideIdOrSides
      ? [qbrSideIdOrSides]
      : [];

  let mapped = rows.map((row) => ({ ...row }));

  // Legacy single LB key: copy from preferred/first available side.
  if (lbDefs.some((def) => def.dataKey === LOWER_BOUND_DATA_KEY)) {
    const preferred = sideIds[0] ?? null;
    mapped = mapped.map((row) => {
      let value = preferred != null ? finiteOrNull(row[lowerBoundDataKey(preferred)]) : null;
      if (value == null) {
        for (const [key, raw] of Object.entries(row)) {
          if (key === LOWER_BOUND_DATA_KEY || !String(key).endsWith("__lower_bound")) continue;
          value = finiteOrNull(raw);
          if (value != null) break;
        }
      }
      return { ...row, [LOWER_BOUND_DATA_KEY]: value };
    });
  }

  const keysToFill = [
    ...new Set([
      ...lbDefs.map((def) => def.dataKey).filter(Boolean),
      ...sideIds.map((sideId) => lowerBoundDataKey(sideId))
    ])
  ];

  // Only invent missing points for episode-style rows (one batch per X).
  // Density charts should keep null where a side has no topologies at that density.
  const episodeStyle = mapped.every((row) => row?.densityLabel == null);
  if (!episodeStyle) return mapped;

  keysToFill.forEach((dataKey) => {
    const known = mapped.map((row) => finiteOrNull(row[dataKey])).filter((n) => n != null);
    if (!known.length) return;
    const fill = known.reduce((sum, n) => sum + n, 0) / known.length;
    mapped = mapped.map((row) => {
      const current = finiteOrNull(row[dataKey]);
      if (current != null) return row;
      return { ...row, [dataKey]: fill };
    });
  });

  return mapped;
}

import { normalizeCompareChartInput } from "./compareChartSides.js";

export const LOWER_BOUND_DATA_KEY = "LB__lower_bound";
export const LOWER_BOUND_SERIES_LABEL = "lower bound";

export function isQbrBatchResult(result) {
  return String(result?.algorithm_id ?? "").trim().toLowerCase() === "qbr";
}

export function findQbrSideForLowerBound(compareChartInput) {
  const normalized = normalizeCompareChartInput(compareChartInput);
  const match = (normalized.sides ?? []).find((side) => isQbrBatchResult(side.result));
  return match?.sideId ?? null;
}

export function hasQbrLowerBoundSource(compareChartInput) {
  return findQbrSideForLowerBound(compareChartInput) != null;
}

export function filterMetricKeysWithLowerBound(metricKeys, compareChartInput) {
  const keys = Array.isArray(metricKeys) ? metricKeys : [];
  if (hasQbrLowerBoundSource(compareChartInput)) return keys;
  return keys.filter((key) => key !== "lower_bound");
}

export function materializeLowerBoundRows(rows, defs, qbrSideId) {
  if (!rows?.length) return rows ?? [];
  if (!qbrSideId) return rows;
  if (!defs?.some((def) => def.dataKey === LOWER_BOUND_DATA_KEY)) return rows;
  return rows.map((row) => ({
    ...row,
    [LOWER_BOUND_DATA_KEY]: row[`${qbrSideId}__lower_bound`] ?? null
  }));
}

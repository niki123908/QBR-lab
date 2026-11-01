export const COMPARE_SIDE_IDS = ["A", "B", "C", "D", "E", "F", "G", "H"];
export const DUAL_COMPARE_SIDES = ["A", "B"];
/** All chart batch slots (kept name for call-site compatibility). */
export const QUAD_COMPARE_SIDES = COMPARE_SIDE_IDS;
export const MAX_COMPARE_CHART_BATCHES = 8;

export const SIDE_COLORS = {
  A: { main: "#2563EB", light: "#60A5FA", dark: "#1D4ED8" },
  B: { main: "#DC2626", light: "#F87171", dark: "#B91C1C" },
  C: { main: "#16A34A", light: "#4ADE80", dark: "#15803D" },
  D: { main: "#9333EA", light: "#C084FC", dark: "#7E22CE" },
  E: { main: "#D97706", light: "#FBBF24", dark: "#B45309" },
  F: { main: "#0891B2", light: "#22D3EE", dark: "#0E7490" },
  G: { main: "#DB2777", light: "#F472B6", dark: "#BE185D" },
  H: { main: "#4B5563", light: "#9CA3AF", dark: "#1F2937" }
};

export function normalizeCompareChartMode(mode) {
  if (mode === "densityMean") return "densityMean";
  if (mode === "episodes") return "episodes";
  return "density";
}

/** Modes that plot mean metrics (vs per-topology index). */
export function chartModeUsesMeanMetrics(mode) {
  const m = normalizeCompareChartMode(mode);
  return m === "densityMean" || m === "episodes";
}

/** Normalize legacy A/B input or multi-side chart input. */
export function normalizeCompareChartInput(input) {
  if (input?.sides?.length) {
    const sides = input.sides
      .filter((row) => row?.sideId && row?.result)
      .map((row) => ({
        sideId: String(row.sideId),
        batchRunId: row.batchRunId ?? "",
        label: row.label ?? "",
        result: row.result
      }));
    return {
      ready: Boolean(input.ready) && sides.length >= 1,
      sideCount: sides.length,
      sides
    };
  }

  if (input?.resultA && input?.resultB) {
    return {
      ready: Boolean(input.ready),
      sideCount: 2,
      sides: [
        { sideId: "A", batchRunId: input.batchIdA ?? "", label: "", result: input.resultA },
        { sideId: "B", batchRunId: input.batchIdB ?? "", label: "", result: input.resultB }
      ]
    };
  }

  return { ready: false, sideCount: 0, sides: [] };
}

export function activeSideIds(normalized) {
  return (normalized?.sides ?? []).map((row) => row.sideId);
}

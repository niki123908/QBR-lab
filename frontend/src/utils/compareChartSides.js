export const COMPARE_SIDE_IDS = ["A", "B", "C", "D"];
export const DUAL_COMPARE_SIDES = ["A", "B"];
export const QUAD_COMPARE_SIDES = ["A", "B", "C", "D"];

export const SIDE_COLORS = {
  A: { main: "#2563EB", light: "#60A5FA", dark: "#1D4ED8" },
  B: { main: "#DC2626", light: "#F87171", dark: "#B91C1C" },
  C: { main: "#16A34A", light: "#4ADE80", dark: "#15803D" },
  D: { main: "#9333EA", light: "#C084FC", dark: "#7E22CE" }
};

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

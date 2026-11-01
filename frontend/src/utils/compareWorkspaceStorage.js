const STORAGE_KEY = "qbr.compare-workspace";

const COMPARE_KINDS = new Set(["batch", "single", "repeat", "chart"]);

function normalizeCompareKind(value) {
  return COMPARE_KINDS.has(value) ? value : "batch";
}

export function readCompareWorkspaceSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      compareKind: normalizeCompareKind(parsed.compareKind),
      batchIdA: typeof parsed.batchIdA === "string" ? parsed.batchIdA : "",
      batchIdB: typeof parsed.batchIdB === "string" ? parsed.batchIdB : "",
      filterA: parsed.filterA === "converged" || parsed.filterA === "not_converged" ? parsed.filterA : "all",
      filterB: parsed.filterB === "converged" || parsed.filterB === "not_converged" ? parsed.filterB : "all"
    };
  } catch {
    return null;
  }
}

export function writeCompareWorkspaceSession(session) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        compareKind: normalizeCompareKind(session?.compareKind),
        batchIdA: typeof session?.batchIdA === "string" ? session.batchIdA : "",
        batchIdB: typeof session?.batchIdB === "string" ? session.batchIdB : "",
        filterA: session?.filterA ?? "all",
        filterB: session?.filterB ?? "all"
      })
    );
  } catch {
    /* ignore */
  }
}

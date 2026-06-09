const STORAGE_KEY = "qbr.compare-workspace";

export function readCompareWorkspaceSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const compareKind = parsed.compareKind === "chart" ? "chart" : "batch";
    return {
      compareKind,
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
        version: 1,
        savedAt: new Date().toISOString(),
        compareKind: session?.compareKind === "chart" ? "chart" : "batch",
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

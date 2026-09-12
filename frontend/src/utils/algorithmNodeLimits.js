/** MILP may only run when node_count < this value. */
export const MILP_MAX_NODE_COUNT_EXCLUSIVE = 100;

export function getAlgorithmMaxNodeCountExclusive(algorithmMeta) {
  const raw = algorithmMeta?.limits?.max_node_count_exclusive;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isAlgorithmDisabledForNodeCount(algorithmId, nodeCount, algorithmMeta) {
  if (String(algorithmId) !== "milp") return false;
  const limit =
    getAlgorithmMaxNodeCountExclusive(algorithmMeta) ?? MILP_MAX_NODE_COUNT_EXCLUSIVE;
  const n = Number(nodeCount);
  if (!Number.isFinite(n)) return false;
  return n >= limit;
}

export function milpDisabledReason(nodeCount, algorithmMeta) {
  const limit =
    getAlgorithmMaxNodeCountExclusive(algorithmMeta) ?? MILP_MAX_NODE_COUNT_EXCLUSIVE;
  return `MILP chỉ chạy với topology dưới ${limit} nodes (hiện tại: ${nodeCount ?? "—"}).`;
}

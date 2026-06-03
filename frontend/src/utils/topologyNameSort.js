/**
 * Natural sort for topology names (tp_250_00, tp_250_01, … tp_250_200).
 */
export function compareTopologyNames(a, b) {
  const nameA = String(typeof a === "string" ? a : a?.topology_name ?? "");
  const nameB = String(typeof b === "string" ? b : b?.topology_name ?? "");
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
}

export function sortTopologiesByName(topologies) {
  if (!Array.isArray(topologies)) {
    return [];
  }
  return [...topologies].sort(compareTopologyNames);
}

export function sortBatchesWithTopologies(batches) {
  if (!Array.isArray(batches)) {
    return [];
  }
  return batches.map((batch) => ({
    ...batch,
    topologies: sortTopologiesByName(batch.topologies ?? [])
  }));
}

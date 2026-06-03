export function buildDefaultBatchRunResultLabel(batchName, presetName) {
  const batch = String(batchName ?? "batch").trim() || "batch";
  const preset = String(presetName ?? "default").trim() || "default";
  return `${batch} -- ${preset}`;
}

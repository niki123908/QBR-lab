/**
 * @param {{ episode?: string | number, path_signature?: string }[]} pathRows
 * @returns {{ episode: number, unique_paths_so_far: number, path_signature: string }[]}
 */
export function buildCumulativeUniquePathRows(pathRows) {
  const sorted = (Array.isArray(pathRows) ? pathRows : [])
    .map((row) => ({
      episode: Number(row?.episode),
      path_signature: String(row?.path_signature ?? "").trim()
    }))
    .filter((row) => Number.isFinite(row.episode) && row.path_signature)
    .sort((a, b) => a.episode - b.episode);

  const seen = new Set();
  const out = [];
  for (const row of sorted) {
    seen.add(row.path_signature);
    out.push({
      episode: row.episode,
      unique_paths_so_far: seen.size,
      path_signature: row.path_signature
    });
  }
  return out;
}

export function buildCumulativeUniquePathCsv(rows) {
  const data = Array.isArray(rows) ? rows : [];
  const lines = [
    "episode,unique_paths_so_far,path_signature",
    ...data.map(
      (row) => `${String(row.episode)},${String(row.unique_paths_so_far)},${String(row.path_signature ?? "")}`
    )
  ];
  return `${lines.join("\n")}\n`;
}

export function downloadCumulativeUniquePathCsv(rows) {
  const csv = buildCumulativeUniquePathCsv(rows);
  if (!csv.trim()) return false;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "unique_paths_cumulative_by_episode.csv";
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

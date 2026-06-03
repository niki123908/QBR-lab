import { buildCsv, escapeCsvCell, safeFilename, downloadCsv } from "./csvUtils.js";

export function densityAxisLabel(group) {
  const n = Number(group?.node_count);
  return Number.isFinite(n) && n > 0 ? n : "?";
}

export function iterBatchTopologyRows(result) {
  const groups = result?.density_groups ?? [];
  if (groups.length) {
    return groups.flatMap((group) => {
      const densityNodeCount = densityAxisLabel(group);
      return (group.topologies ?? []).map((topo, idx) => ({
        densityNodeCount,
        topo,
        fallbackIndex: idx
      }));
    });
  }
  return (result?.topologies ?? []).map((topo, idx) => ({
    densityNodeCount: Number.isFinite(Number(topo.node_count)) ? topo.node_count : "",
    topo,
    fallbackIndex: idx
  }));
}

export function batchHasPathMetricsData(result) {
  return iterBatchTopologyRows(result).some(({ topo }) => Number.isFinite(Number(topo.unique_path_count)));
}

export const BATCH_SUMMARY_COLUMN_DEFS = [
  { key: "density_node_count", label: "density_node_count", group: "Identity", default: true },
  { key: "topology_index", label: "topology_index", group: "Identity", default: true },
  { key: "topology_id", label: "topology_id", group: "Identity", default: false },
  { key: "topology_name", label: "topology_name", group: "Identity", default: true },
  { key: "run_status", label: "run_status", group: "Identity", default: false },
  { key: "last_delay", label: "last_delay", group: "Delay", default: true },
  { key: "best_delay", label: "best_delay", group: "Delay", default: true },
  { key: "lower_bound", label: "lower_bound", group: "Delay", default: false },
  { key: "unique_path_count", label: "unique_path_count", group: "Path", default: false },
  { key: "best_delay_unique_path_count", label: "best_delay_unique_path_count", group: "Path", default: true }
];

export const BATCH_EPISODE_COLUMN_DEFS = [
  { key: "density_node_count", label: "density_node_count", group: "Identity", default: true },
  { key: "topology_index", label: "topology_index", group: "Identity", default: true },
  { key: "topology_id", label: "topology_id", group: "Identity", default: true },
  { key: "topology_name", label: "topology_name", group: "Identity", default: true },
  { key: "episode", label: "episode", group: "Episode", default: true },
  { key: "delay", label: "delay", group: "Episode", default: true }
];

function topologyIndexForRow(topo, fallbackIndex) {
  return Number.isFinite(Number(topo.topology_index)) ? topo.topology_index : fallbackIndex;
}

function summaryRowFromTopo({ densityNodeCount, topo, fallbackIndex }) {
  const idx = topologyIndexForRow(topo, fallbackIndex);
  return {
    density_node_count: densityNodeCount,
    topology_index: idx,
    topology_id: topo.topology_id ?? "",
    topology_name: topo.topology_name ?? "",
    run_status: topo.status ?? "",
    last_delay: topo.last_delay ?? "",
    best_delay: topo.best_delay ?? "",
    lower_bound: topo.lower_bound ?? "",
    unique_path_count: topo.unique_path_count ?? "",
    best_delay_unique_path_count: topo.best_delay_unique_path_count ?? ""
  };
}

export function buildBatchSummaryRows(result, selectedKeys) {
  const keys = selectedKeys?.length ? selectedKeys : BATCH_SUMMARY_COLUMN_DEFS.filter((c) => c.default).map((c) => c.key);
  return iterBatchTopologyRows(result).map((item) => {
    const full = summaryRowFromTopo(item);
    const row = {};
    keys.forEach((key) => {
      row[key] = full[key] ?? "";
    });
    return row;
  });
}

export function buildBatchEpisodeRows(result, selectedKeys) {
  const keys = selectedKeys?.length ? selectedKeys : BATCH_EPISODE_COLUMN_DEFS.map((c) => c.key);
  const rows = [];
  iterBatchTopologyRows(result).forEach(({ densityNodeCount, topo, fallbackIndex }) => {
    const idx = topologyIndexForRow(topo, fallbackIndex);
    const episodes = topo.delay_per_episode ?? [];
    episodes.forEach((delay, epIdx) => {
      const full = {
        density_node_count: densityNodeCount,
        topology_index: idx,
        topology_id: topo.topology_id ?? "",
        topology_name: topo.topology_name ?? "",
        episode: epIdx + 1,
        delay: delay ?? ""
      };
      const row = {};
      keys.forEach((key) => {
        row[key] = full[key] ?? "";
      });
      rows.push(row);
    });
  });
  return rows;
}

export function buildBatchPathMetricsCsv(result) {
  const columns = [
    { key: "density_node_count", label: "density_node_count" },
    { key: "topology_index", label: "topology_index" },
    { key: "topology_id", label: "topology_id" },
    { key: "topology_name", label: "topology_name" },
    { key: "run_status", label: "run_status" },
    { key: "unique_path_count", label: "unique_path_count" },
    { key: "best_delay_unique_path_count", label: "best_delay_unique_path_count" }
  ];
  const rows = iterBatchTopologyRows(result).map(({ densityNodeCount, topo, fallbackIndex }) => ({
    density_node_count: densityNodeCount,
    topology_index: topologyIndexForRow(topo, fallbackIndex),
    topology_id: topo.topology_id ?? "",
    topology_name: topo.topology_name ?? "",
    run_status: topo.status ?? "",
    unique_path_count: topo.unique_path_count ?? "",
    best_delay_unique_path_count: topo.best_delay_unique_path_count ?? ""
  }));
  return buildCsv(columns, rows);
}

export function buildBatchDelayScatterCsv(points) {
  const columns = [
    { key: "topology_index", label: "topology_index" },
    { key: "topology_id", label: "topology_id" },
    { key: "last_delay", label: "last_delay" },
    { key: "best_delay", label: "best_delay" },
    { key: "lower_bound", label: "lower_bound" }
  ];
  const rows = (points ?? []).map((p, idx) => ({
    topology_index: Number.isFinite(Number(p.topology_index)) ? p.topology_index : idx,
    topology_id: p.topology_id ?? "",
    last_delay: p.last_delay ?? "",
    best_delay: p.best_delay ?? "",
    lower_bound: p.lower_bound ?? ""
  }));
  return buildCsv(columns, rows);
}

export function buildBatchPathMetricsCsvForDensity(group) {
  const densityNodeCount = densityAxisLabel(group);
  const columns = [
    { key: "density_node_count", label: "density_node_count" },
    { key: "topology_index", label: "topology_index" },
    { key: "topology_id", label: "topology_id" },
    { key: "topology_name", label: "topology_name" },
    { key: "run_status", label: "run_status" },
    { key: "unique_path_count", label: "unique_path_count" },
    { key: "best_delay_unique_path_count", label: "best_delay_unique_path_count" }
  ];
  const rows = (group.topologies ?? []).map((p, idx) => ({
    density_node_count: densityNodeCount,
    topology_index: Number.isFinite(Number(p.topology_index)) ? p.topology_index : idx,
    topology_id: p.topology_id ?? "",
    topology_name: p.topology_name ?? "",
    run_status: p.status ?? "",
    unique_path_count: p.unique_path_count ?? "",
    best_delay_unique_path_count: p.best_delay_unique_path_count ?? ""
  }));
  return buildCsv(columns, rows);
}

export function downloadBatchPathMetricsCsv(result) {
  const csv = buildBatchPathMetricsCsv(result);
  const label = safeFilename(result?.result_label ?? result?.batch_name ?? "batch");
  downloadCsv(csv, `path_metrics_${label}.csv`);
}

export function downloadCsvText(csvText, filename) {
  downloadCsv(csvText, filename);
}

/** Legacy helper for inline string building */
export { escapeCsvCell };

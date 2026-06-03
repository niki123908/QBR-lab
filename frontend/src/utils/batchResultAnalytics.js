import { buildPolicyTraceFromConfig } from "./policyTrace.js";
import { densityAxisLabel } from "../export/batchRunBuilders.js";
import { buildCsv, downloadCsv, safeFilename } from "../export/csvUtils.js";

function finiteMean(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

export function buildBatchPolicyTrace(result) {
  if (!result) return null;
  const resolved = result.resolved_run_config;
  const summary = {
    episodes: Number(result.run_config?.episodes) || undefined,
    policy_type: result.run_config?.policy_type
  };
  const built = buildPolicyTraceFromConfig(resolved ?? { run_config: result.run_config }, summary);
  return built?.rows ?? null;
}

export function densityLearningMeans(group) {
  const topologies = group?.topologies ?? [];
  const states = topologies.map((t) => Number(t.total_states));
  const actions = topologies.map((t) => Number(t.total_state_actions));
  const stateSamples = states.filter((n) => Number.isFinite(n));
  const actionSamples = actions.filter((n) => Number.isFinite(n));
  return {
    topologyCount: topologies.length,
    meanStates: finiteMean(stateSamples),
    meanStateActions: finiteMean(actionSamples),
    stateSampleCount: stateSamples.length,
    actionSampleCount: actionSamples.length
  };
}

function collectDelayKeysForDensity(group) {
  const delays = new Set();
  (group?.topologies ?? []).forEach((topo) => {
    const map = topo.paths_count_by_delay;
    if (map && typeof map === "object") {
      Object.keys(map).forEach((key) => {
        const d = Number(key);
        if (Number.isFinite(d)) delays.add(d);
      });
    }
    (topo.delay_per_episode ?? []).forEach((value) => {
      const d = Number(value);
      if (Number.isFinite(d)) delays.add(d);
    });
  });
  return Array.from(delays).sort((a, b) => a - b);
}

export function densityDelayRangeLabel(group) {
  const delays = collectDelayKeysForDensity(group);
  if (!delays.length) return "—";
  if (delays.length === 1) return String(delays[0]);
  return `${delays[0]}–${delays[delays.length - 1]}`;
}

function buildDelayColumns(group, sharedAxis = null) {
  const minShared = Number(sharedAxis?.min);
  const maxShared = Number(sharedAxis?.max);
  if (Number.isFinite(minShared) && Number.isFinite(maxShared) && maxShared >= minShared) {
    const lo = Math.floor(minShared);
    const hi = Math.ceil(maxShared);
    return Array.from({ length: hi - lo + 1 }, (_, idx) => lo + idx);
  }
  return collectDelayKeysForDensity(group);
}

function delayRangeFromColumns(delayColumns) {
  if (!delayColumns.length) return "—";
  if (delayColumns.length === 1) return String(delayColumns[0]);
  return `${delayColumns[0]}–${delayColumns[delayColumns.length - 1]}`;
}

export function buildDensityDelayPathMatrix(group, sharedAxis = null) {
  const delayColumns = buildDelayColumns(group, sharedAxis);
  const delayRange = delayRangeFromColumns(delayColumns);
  const topologies = (group?.topologies ?? []).map((topo, idx) => {
    const map = topo.paths_count_by_delay && typeof topo.paths_count_by_delay === "object" ? topo.paths_count_by_delay : {};
    const byDelay = {};
    delayColumns.forEach((delay) => {
      const raw = map[delay] ?? map[String(delay)];
      const count = Number(raw);
      byDelay[delay] = Number.isFinite(count) ? count : 0;
    });
    const lowerBound = Number(topo.lower_bound);
    const lower_bound = Number.isFinite(lowerBound) ? lowerBound : null;
    const pathCounts = Object.values(byDelay);
    const maxPathCount = pathCounts.length ? Math.max(...pathCounts) : 0;
    return {
      topology_index: Number.isFinite(Number(topo.topology_index)) ? topo.topology_index : idx,
      topology_name: topo.topology_name ?? "",
      topology_id: topo.topology_id ?? "",
      lower_bound,
      maxDistFromLowerBound: maxDelayDistanceFromLowerBound(lower_bound, delayColumns),
      maxPathCount,
      byDelay
    };
  });
  const rows = delayColumns.map((delay) => ({
    delay,
    cells: Object.fromEntries(topologies.map((t) => [t.topology_index, t.byDelay[delay] ?? 0]))
  }));
  return { delayRange, delayColumns, topologies, rows };
}

const DELAY_HEAT_RED = [242, 196, 197];
const DELAY_HEAT_BLUE = [198, 216, 230];
const DELAY_HEAT_PEAK = [205, 118, 122];

function maxDelayDistanceFromLowerBound(lowerBound, delayColumns) {
  if (!Number.isFinite(lowerBound)) return 1;
  let max = 0;
  delayColumns.forEach((delay) => {
    max = Math.max(max, Math.abs(delay - lowerBound));
  });
  return max || 1;
}

function mixDelayHeatColor(t, { isPeak = false } = {}) {
  const clamped = Math.max(0, Math.min(1, t));
  const effectiveT = isPeak ? clamped * 0.2 : clamped;
  let rgb = DELAY_HEAT_RED.map((start, i) => Math.round(start + effectiveT * (DELAY_HEAT_BLUE[i] - start)));
  if (isPeak) {
    const boost = 0.72;
    rgb = rgb.map((value, i) => Math.round(value * (1 - boost) + DELAY_HEAT_PEAK[i] * boost));
  }
  return {
    backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
    color: "#3a4058"
  };
}

export function delayPathMatrixCellStyle({ delay, lowerBound, maxDist, count, maxPathCount }) {
  const value = Number(count);
  if (!Number.isFinite(value) || value === 0) {
    return { className: "batch-delay-path-cell--zero", showValue: false, isPeak: false };
  }
  const isPeak = Number(maxPathCount) > 0 && value === maxPathCount;
  if (!Number.isFinite(lowerBound)) {
    return {
      className: "batch-delay-path-cell-num batch-delay-path-cell--heat",
      showValue: true,
      isPeak,
      ...(isPeak ? mixDelayHeatColor(0, { isPeak: true }) : {})
    };
  }
  const dist = Math.abs(delay - lowerBound);
  const span = Number.isFinite(maxDist) && maxDist > 0 ? maxDist : 1;
  return {
    className: "batch-delay-path-cell-num batch-delay-path-cell--heat",
    showValue: true,
    isPeak,
    ...mixDelayHeatColor(dist / span, { isPeak })
  };
}

export function buildBatchLearningStatsCsv(result) {
  const columns = [
    { key: "density_node_count", label: "density_node_count" },
    { key: "topology_count", label: "topology_count" },
    { key: "mean_states", label: "mean_states" },
    { key: "mean_state_actions", label: "mean_state_actions" },
    { key: "state_sample_count", label: "state_sample_count" },
    { key: "action_sample_count", label: "action_sample_count" }
  ];
  const rows = (result?.density_groups ?? []).map((group) => {
    const means = densityLearningMeans(group);
    return {
      density_node_count: densityAxisLabel(group),
      topology_count: means.topologyCount,
      mean_states: means.meanStates ?? "",
      mean_state_actions: means.meanStateActions ?? "",
      state_sample_count: means.stateSampleCount,
      action_sample_count: means.actionSampleCount
    };
  });
  return buildCsv(columns, rows);
}

export function buildDensityDelayPathMatrixCsv(group) {
  const matrix = buildDensityDelayPathMatrix(group);
  const columns = [
    { key: "delay", label: "delay" },
    ...matrix.topologies.map((topo) => ({
      key: `topo_${topo.topology_index}`,
      label: String(topo.topology_index)
    }))
  ];
  const rows = matrix.rows.map((row) => {
    const out = { delay: row.delay };
    matrix.topologies.forEach((topo) => {
      out[`topo_${topo.topology_index}`] = row.cells[topo.topology_index] ?? 0;
    });
    return out;
  });
  return buildCsv(columns, rows);
}

export function buildAllDensityDelayPathMatrixCsv(result) {
  const groups = result?.density_groups ?? [];
  if (!groups.length) return "";
  const parts = groups.map((group) => {
    const label = densityAxisLabel(group);
    const header = `# density_node_count=${label}`;
    return `${header}\n${buildDensityDelayPathMatrixCsv(group)}`;
  });
  return `${parts.join("\n\n")}\n`;
}

export function downloadBatchLearningStatsCsv(result) {
  const csv = buildBatchLearningStatsCsv(result);
  if (!csv) return;
  downloadCsv(csv, `batch_learning_stats_${safeFilename(result?.result_label)}.csv`);
}

export function downloadAllDensityDelayPathMatrixCsv(result) {
  const csv = buildAllDensityDelayPathMatrixCsv(result);
  if (!csv.trim()) return;
  downloadCsv(csv, `batch_delay_path_matrix_${safeFilename(result?.result_label)}.csv`);
}

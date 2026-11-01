import { normalizeCompareChartInput } from "./compareChartSides.js";

function densityLabel(group) {
  const nodeCount = Number(group?.node_count);
  return Number.isFinite(nodeCount) ? String(nodeCount) : String(group?.density_key ?? "?");
}

function groupByDensity(result) {
  const out = new Map();
  (result?.density_groups ?? []).forEach((group) => {
    out.set(densityLabel(group), group);
  });
  return out;
}

function topologyByIndex(group) {
  const out = new Map();
  (group?.topologies ?? []).forEach((topo, idx) => {
    const index = Number.isFinite(Number(topo?.topology_index)) ? Number(topo.topology_index) : idx;
    out.set(index, topo);
  });
  return out;
}

function numericOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function convergenceFlag(topo) {
  const best = numericOrNull(topo?.best_delay);
  const last = numericOrNull(topo?.last_delay);
  if (!Number.isFinite(best) || !Number.isFinite(last)) return null;
  return best === last ? 1 : 0;
}

export function buildDensityPairs(compareChartInput) {
  const normalized = normalizeCompareChartInput(compareChartInput);
  const sideMaps = (normalized.sides ?? []).map((side) => ({
    sideId: side.sideId,
    map: groupByDensity(side.result)
  }));

  const labels = new Set();
  sideMaps.forEach((entry) => {
    entry.map.forEach((_, label) => labels.add(label));
  });

  return Array.from(labels)
    .sort((a, b) => Number(a) - Number(b))
    .map((label) => {
      const groupsBySide = {};
      sideMaps.forEach((entry) => {
        groupsBySide[entry.sideId] = entry.map.get(label) ?? null;
      });
      return {
        densityLabel: label,
        densityValue: Number(label),
        groupsBySide,
        groupA: groupsBySide.A ?? null,
        groupB: groupsBySide.B ?? null
      };
    });
}

export function buildPerDensityChartRows(densityPair, selectedMetricKeys, sideIds) {
  const ids = sideIds?.length ? sideIds : ["A", "B"];
  const bySide = {};
  ids.forEach((sideId) => {
    bySide[sideId] = topologyByIndex(densityPair?.groupsBySide?.[sideId] ?? densityPair?.[`group${sideId}`]);
  });

  const indices = new Set();
  ids.forEach((sideId) => {
    bySide[sideId]?.forEach((_, index) => indices.add(index));
  });

  return Array.from(indices)
    .sort((a, b) => a - b)
    .map((index) => {
      const row = { x: index };
      selectedMetricKeys.forEach((metricKey) => {
        ids.forEach((sideId) => {
          const topo = bySide[sideId]?.get(index);
          if (metricKey === "convergence_count") {
            row[`${sideId}__${metricKey}`] = convergenceFlag(topo);
          } else {
            row[`${sideId}__${metricKey}`] = numericOrNull(topo?.[metricKey]);
          }
        });
      });

      ids.forEach((sideId) => {
        const conv = numericOrNull(row[`${sideId}__convergence_count`]);
        row[`__convergence_bg_${sideId.toLowerCase()}`] = Number.isFinite(conv) ? conv : null;
      });

      row.__convergence_bg_a = row.__convergence_bg_a ?? null;
      row.__convergence_bg_b = row.__convergence_bg_b ?? null;

      return row;
    });
}

function meanOfMetric(topologies, metricKey) {
  if (metricKey === "convergence_count") {
    const flags = (topologies ?? []).map((topo) => convergenceFlag(topo)).filter((n) => Number.isFinite(n));
    if (!flags.length) return null;
    const ratio = flags.reduce((sum, n) => sum + n, 0) / flags.length;
    return ratio * 100;
  }
  const values = (topologies ?? [])
    .map((topo) => numericOrNull(topo?.[metricKey]))
    .filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

export function buildDensityMeanRows(compareChartInput, selectedMetricKeys, densityMetricKeys) {
  const normalized = normalizeCompareChartInput(compareChartInput);
  const sideIds = normalized.sides.map((side) => side.sideId);
  const densityPairs = buildDensityPairs(compareChartInput);

  return densityPairs.map((pair) => {
    const row = {
      x: pair.densityValue,
      densityLabel: pair.densityLabel
    };

    selectedMetricKeys.forEach((metricKey) => {
      sideIds.forEach((sideId) => {
        row[`${sideId}__${metricKey}`] = meanOfMetric(pair.groupsBySide?.[sideId]?.topologies, metricKey);
      });
    });

    densityMetricKeys.forEach((metricKey) => {
      sideIds.forEach((sideId) => {
        row[`${sideId}__${metricKey}`] = numericOrNull(pair.groupsBySide?.[sideId]?.[metricKey]);
      });
    });

    sideIds.forEach((sideId) => {
      const conv = numericOrNull(row[`${sideId}__convergence_count`]);
      row[`__convergence_bg_${sideId.toLowerCase()}`] = Number.isFinite(conv) ? conv / 100 : null;
    });

    row.__convergence_bg_a = row.__convergence_bg_a ?? null;
    row.__convergence_bg_b = row.__convergence_bg_b ?? null;

    return row;
  });
}

/** Training episode count from batch result run_config / resolved_run_config. */
export function trainingEpisodesFromResult(result) {
  const fromRun = Number(result?.run_config?.episodes);
  if (Number.isFinite(fromRun) && fromRun > 0) return Math.trunc(fromRun);
  const wrapper = result?.resolved_run_config;
  const resolved =
    wrapper && typeof wrapper === "object" && wrapper.resolved_run_config != null
      ? wrapper.resolved_run_config
      : wrapper;
  const fromResolved = Number(resolved?.episodes);
  if (Number.isFinite(fromResolved) && fromResolved > 0) return Math.trunc(fromResolved);
  return null;
}

/**
 * Compare batches by training episode count on X.
 * Y = mean of selected metrics over topologies in selected densities.
 * One row per distinct episode value across loaded sides.
 */
export function buildEpisodeMeanRows(
  compareChartInput,
  selectedMetricKeys,
  densityMetricKeys,
  selectedDensityLabels
) {
  const normalized = normalizeCompareChartInput(compareChartInput);
  const densityPairs = buildDensityPairs(compareChartInput);
  const selected =
    selectedDensityLabels?.length > 0
      ? new Set(selectedDensityLabels.map(String))
      : new Set(densityPairs.map((pair) => pair.densityLabel));

  const byEpisodes = new Map();

  (normalized.sides ?? []).forEach((side) => {
    const episodes = trainingEpisodesFromResult(side.result);
    if (!Number.isFinite(episodes)) return;

    const topologies = [];
    densityPairs.forEach((pair) => {
      if (!selected.has(pair.densityLabel)) return;
      const group = pair.groupsBySide?.[side.sideId];
      (group?.topologies ?? []).forEach((topo) => topologies.push(topo));
    });

    if (!byEpisodes.has(episodes)) {
      byEpisodes.set(episodes, { x: episodes, episodes });
    }
    const row = byEpisodes.get(episodes);

    selectedMetricKeys.forEach((metricKey) => {
      row[`${side.sideId}__${metricKey}`] = meanOfMetric(topologies, metricKey);
    });

    densityMetricKeys.forEach((metricKey) => {
      const values = densityPairs
        .filter((pair) => selected.has(pair.densityLabel))
        .map((pair) => numericOrNull(pair.groupsBySide?.[side.sideId]?.[metricKey]))
        .filter((n) => Number.isFinite(n));
      row[`${side.sideId}__${metricKey}`] = values.length
        ? values.reduce((sum, n) => sum + n, 0) / values.length
        : null;
    });

    const conv = numericOrNull(row[`${side.sideId}__convergence_count`]);
    row[`__convergence_bg_${side.sideId.toLowerCase()}`] = Number.isFinite(conv) ? conv / 100 : null;
  });

  return Array.from(byEpisodes.values())
    .map((row) => ({
      ...row,
      __convergence_bg_a: row.__convergence_bg_a ?? null,
      __convergence_bg_b: row.__convergence_bg_b ?? null
    }))
    .sort((a, b) => a.x - b.x);
}

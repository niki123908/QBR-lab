const TOPOLOGY_EXCLUDED_KEYS = new Set([
  "topology_id",
  "topology_name",
  "topology_index",
  "node_count",
  "delay_per_episode",
  "paths_count_by_delay"
]);

const DENSITY_EXCLUDED_KEYS = new Set(["topologies", "node_count", "density_key"]);

const METRIC_DISPLAY_LABELS = {
  total_state_actions: "total actions",
  lower_bound: "lower bound"
};

function titleize(raw) {
  return String(raw)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metricDisplayLabel(key) {
  return METRIC_DISPLAY_LABELS[key] ?? titleize(key);
}

function inferMetricGroup(metricKey) {
  const key = String(metricKey || "").toLowerCase();
  if (key.includes("delay") || key.includes("bound")) return "Delay";
  if (key.includes("state") || key.includes("action") || key.includes("q")) return "Learning";
  if (key.includes("path")) return "Path";
  if (key.includes("reward")) return "Reward";
  return "Other";
}

function inferDefaultAxis(metricKey) {
  const key = String(metricKey || "").toLowerCase();
  if (key.includes("state_action") || key.includes("states") || key.includes("actions")) return "right";
  return "left";
}

function pushMetric(catalogMap, metric) {
  if (!metric?.key || catalogMap.has(metric.key)) return;
  catalogMap.set(metric.key, metric);
}

import { findQbrSideForLowerBound } from "./compareChartLowerBound.js";
import { normalizeCompareChartInput } from "./compareChartSides.js";

export function buildCompareMetricCatalog(compareChartInput) {
  const normalized = normalizeCompareChartInput(compareChartInput);
  const groups = (normalized.sides ?? []).flatMap((side) => side.result?.density_groups ?? []);
  const topologyMetrics = new Map();
  const densityMetrics = new Map();

  groups.forEach((group) => {
    (group?.topologies ?? []).forEach((topo) => {
      Object.entries(topo ?? {}).forEach(([key, value]) => {
        if (TOPOLOGY_EXCLUDED_KEYS.has(key)) return;
        if (!Number.isFinite(Number(value))) return;
        pushMetric(topologyMetrics, {
          key,
          label: metricDisplayLabel(key),
          scope: "topology",
          group: inferMetricGroup(key),
          defaultAxis: inferDefaultAxis(key)
        });
      });
    });

    Object.entries(group ?? {}).forEach(([key, value]) => {
      if (DENSITY_EXCLUDED_KEYS.has(key)) return;
      if (!Number.isFinite(Number(value))) return;
      pushMetric(densityMetrics, {
        key,
        label: metricDisplayLabel(key),
        scope: "density",
        group: inferMetricGroup(key),
        defaultAxis: inferDefaultAxis(key)
      });
    });
  });

  if (groups.length > 0) {
    pushMetric(topologyMetrics, {
      key: "convergence_count",
      label: "convergence count",
      scope: "topology",
      group: "Delay",
      defaultAxis: "left"
    });
  }

  const qbrSideId = findQbrSideForLowerBound(normalized);
  if (!qbrSideId) {
    topologyMetrics.delete("lower_bound");
  } else if (topologyMetrics.has("lower_bound")) {
    const existing = topologyMetrics.get("lower_bound");
    topologyMetrics.set("lower_bound", {
      ...existing,
      label: METRIC_DISPLAY_LABELS.lower_bound
    });
  } else {
    pushMetric(topologyMetrics, {
      key: "lower_bound",
      label: METRIC_DISPLAY_LABELS.lower_bound,
      scope: "topology",
      group: "Delay",
      defaultAxis: "left"
    });
  }

  const topologyList = Array.from(topologyMetrics.values()).sort((a, b) => a.label.localeCompare(b.label));
  const densityList = Array.from(densityMetrics.values()).sort((a, b) => a.label.localeCompare(b.label));

  return {
    topologyMetrics: topologyList,
    densityMetrics: densityList,
    allMetrics: [...topologyList, ...densityList]
  };
}


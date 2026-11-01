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
  lower_bound: "lower bound",
  runtime_sec: "training time",
  rollout_runtime_ms: "deploy time"
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

function isFiniteMetricValue(value) {
  if (value == null || value === "") return false;
  return Number.isFinite(Number(value));
}

function inferMetricGroup(metricKey) {
  const key = String(metricKey || "").toLowerCase();
  if (key.includes("runtime") || key === "runtime_sec" || key === "rollout_runtime_ms") return "Runtime";
  if (key.includes("delay") || key.includes("bound") || key.includes("convergence")) return "Delay";
  if (key.includes("state") || key.includes("action") || key.includes("q")) return "Learning";
  if (key.includes("path")) return "Path";
  if (key.includes("reward")) return "Reward";
  return "Other";
}

function inferDefaultAxis(metricKey) {
  const key = String(metricKey || "").toLowerCase();
  if (key.includes("state_action") || key.includes("states") || key.includes("actions")) return "right";
  if (key.includes("runtime") || key === "runtime_sec" || key === "rollout_runtime_ms") return "right";
  return "left";
}

function pushMetric(catalogMap, metric) {
  if (!metric?.key || catalogMap.has(metric.key)) return;
  catalogMap.set(metric.key, metric);
}

function topologyHasFiniteMetric(groups, metricKey) {
  return (groups ?? []).some((group) =>
    (group?.topologies ?? []).some((topo) => isFiniteMetricValue(topo?.[metricKey]))
  );
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
        if (!isFiniteMetricValue(value)) return;
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
      if (!isFiniteMetricValue(value)) return;
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
    if (topologyHasFiniteMetric(groups, "runtime_sec")) {
      pushMetric(topologyMetrics, {
        key: "runtime_sec",
        label: METRIC_DISPLAY_LABELS.runtime_sec,
        scope: "topology",
        group: "Runtime",
        defaultAxis: "right"
      });
    }
    if (topologyHasFiniteMetric(groups, "rollout_runtime_ms")) {
      pushMetric(topologyMetrics, {
        key: "rollout_runtime_ms",
        label: METRIC_DISPLAY_LABELS.rollout_runtime_ms,
        scope: "topology",
        group: "Runtime",
        defaultAxis: "right"
      });
    }
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

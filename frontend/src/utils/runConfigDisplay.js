/** Shared run-config labels and grouping for run forms and batch result panels. */

export const CONFIG_FIELD_BLOCKS = [
  { id: "core", title: "Core parameters", fields: ["core_parameters"] },
  { id: "policy", title: "Preset & policy", fields: ["action_axis", "spread_mode"] },
  { id: "epsilon", title: "ε-greedy parameters", fields: ["epsilon_start", "epsilon_end", "epsilon_decay"] },
  { id: "ucb", title: "UCB parameters", fields: ["ucb_c"] },
  { id: "decay", title: "Decay schedule", fields: ["temperature_decay_mode"] },
  {
    id: "temperature",
    title: "Softmax temperature",
    fields: [
      "temperature_start_mode",
      "temperature_start_multiplier",
      "temperature_start",
      "temperature_end",
      "temperature_decay"
    ]
  },
  {
    id: "reward",
    title: "Reward & trace",
    fields: ["coverage_reward_enabled", "completion_bonus_multiplier", "lambda_param", "trace_threshold", "action_aggregation_mode"]
  },
  { id: "artifacts", title: "Artifacts", fields: ["export_q_table_all_epoch"] },
  { id: "runtime", title: "Runtime", fields: ["run_seed"] }
];

const POLICY_BLOCK_BY_TYPE = {
  epsilon_greedy: "epsilon",
  softmax: "temperature",
  ucb: "ucb"
};

export function formatConfigLabel(fieldName) {
  if (fieldName === "core_parameters") return "Core parameters";
  if (fieldName === "export_q_table_all_epoch") return "Export q table of all epoch";
  if (fieldName === "action_axis") return "Action axis";
  if (fieldName === "spread_mode") return "Spread mode";
  if (fieldName === "policy_type") return "Policy type";
  if (fieldName === "lambda_param") return "Lambda (λ)";
  if (fieldName === "trace_threshold") return "Trace threshold";
  if (fieldName === "coverage_reward_enabled") return "Enable coverage reward (nodes covered / timeslot)";
  if (fieldName === "completion_bonus_multiplier") return "Completion bonus multiplier";
  if (fieldName === "temperature_decay_mode") return "Temperature decay mode";
  if (fieldName === "epsilon_start") return "Epsilon start";
  if (fieldName === "epsilon_end") return "Epsilon end";
  if (fieldName === "epsilon_decay") return "Epsilon decay";
  if (fieldName === "ucb_c") return "UCB exploration constant (c)";
  if (fieldName === "run_seed") return "Run seed";
  if (fieldName === "action_aggregation_mode") return "Action aggregation";
  if (fieldName === "preset_name") return "Preset";
  if (fieldName === "algorithm_id") return "Algorithm";
  if (fieldName === "batch_name") return "Batch";
  return fieldName;
}

export function formatEnumOptionLabel(fieldName, option) {
  if (fieldName === "action_axis") {
    if (option === "broadcaster") return "Broadcaster";
    if (option === "receiver") return "Receiver";
  }
  if (fieldName === "spread_mode") {
    if (option === "normal") return "Normal";
    if (option === "la") return "Latency ahead";
  }
  if (fieldName === "policy_type") {
    if (option === "epsilon_greedy") return "ε-greedy";
    if (option === "softmax") return "Softmax";
    if (option === "ucb") return "UCB";
  }
  if (fieldName === "action_aggregation_mode") {
    if (option === "off") return "Off";
    if (option === "exact_next_state") return "Exact next state";
    if (option === "incremental_merge") return "Incremental merge";
  }
  return String(option ?? "");
}

export function formatConfigValue(fieldName, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (fieldName === "core_parameters" && typeof value === "object") {
    const parts = [
      `episodes=${value.episodes ?? "-"}`,
      `alpha=${value.alpha ?? "-"}`,
      `gamma=${value.gamma ?? "-"}`
    ];
    return parts.join(" | ");
  }
  if (
    fieldName === "policy_type" ||
    fieldName === "action_axis" ||
    fieldName === "spread_mode" ||
    fieldName === "action_aggregation_mode"
  ) {
    return formatEnumOptionLabel(fieldName, value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return String(value);
}

export function groupConfigFieldNames(fieldNames) {
  const nameSet = new Set(fieldNames);
  const used = new Set();
  const blocks = [];
  CONFIG_FIELD_BLOCKS.forEach((def) => {
    const fields = def.fields.filter((f) => nameSet.has(f));
    if (!fields.length) return;
    fields.forEach((f) => used.add(f));
    blocks.push({ id: def.id, title: def.title, fields });
  });
  const other = fieldNames.filter((f) => !used.has(f));
  if (other.length) {
    blocks.push({ id: "other", title: "Other parameters", fields: other });
  }
  return blocks;
}

export function mergeDisplayConfig(result) {
  const runConfig = result?.run_config && typeof result.run_config === "object" ? result.run_config : {};
  const resolvedWrapper = result?.resolved_run_config;
  const resolved =
    resolvedWrapper && typeof resolvedWrapper === "object" && resolvedWrapper.resolved_run_config != null
      ? resolvedWrapper.resolved_run_config
      : resolvedWrapper && typeof resolvedWrapper === "object" && !("resolved_run_config" in resolvedWrapper)
        ? resolvedWrapper
        : {};
  const merged = { ...runConfig, ...(resolved && typeof resolved === "object" ? resolved : {}) };
  if (merged.action_aggregation_mode == null || merged.action_aggregation_mode === "") {
    merged.action_aggregation_mode = "off";
  }
  return { merged, runConfig, resolved };
}

/** Build a batch-style result object for RunConfigVisibilityTable from a single-run artifact. */
export function buildRunConfigResultFromResolved(resolvedPayload, meta = null) {
  const wrapper = resolvedPayload && typeof resolvedPayload === "object" ? resolvedPayload : null;
  if (!wrapper && !meta) return null;
  return {
    run_id: wrapper?.run_id ?? meta?.run_id ?? "",
    algorithm_id: wrapper?.algorithm_id ?? meta?.algorithm_id ?? "",
    preset_id: wrapper?.preset_id ?? meta?.preset_id ?? "",
    preset_name: wrapper?.preset_name ?? meta?.preset_name ?? "",
    run_config: {},
    resolved_run_config: wrapper
  };
}

/** Fields visible by default: preset label + policy identity + active policy hyperparameters only. */
export function inferDefaultVisibleKeys(config) {
  const policyType = String(config?.policy_type ?? "epsilon_greedy");
  const keys = new Set(["action_axis", "spread_mode", "action_aggregation_mode"]);
  const activeBlockId = POLICY_BLOCK_BY_TYPE[policyType];
  if (activeBlockId) {
    const block = CONFIG_FIELD_BLOCKS.find((b) => b.id === activeBlockId);
    block?.fields.forEach((f) => keys.add(f));
    if (policyType === "softmax") {
      keys.add("temperature_decay_mode");
    }
  }
  return keys;
}

export function isPolicyRelevantField(fieldName, policyType) {
  const pt = String(policyType ?? "epsilon_greedy");
  if (fieldName === "policy_type") return false;
  if (fieldName === "temperature_end") return false;
  const isEpsilonField = ["epsilon_start", "epsilon_end", "epsilon_decay"].includes(fieldName);
  const isTemperatureField = [
    "temperature_start",
    "temperature_start_mode",
    "temperature_start_multiplier",
    "temperature_end",
    "temperature_decay",
    "temperature_decay_mode"
  ].includes(fieldName);
  const isUcbField = fieldName === "ucb_c";
  if (pt === "softmax" && (isEpsilonField || isUcbField)) return false;
  if (pt === "epsilon_greedy" && (isTemperatureField || isUcbField)) return false;
  if (pt === "ucb" && (isEpsilonField || isTemperatureField)) return false;
  return true;
}

export function buildConfigRowGroups(result) {
  const { merged } = mergeDisplayConfig(result);
  const policyType = String(merged.policy_type ?? "epsilon_greedy");
  const mergedWithCore = { ...merged };
  mergedWithCore.core_parameters = {
    episodes: merged.episodes,
    alpha: merged.alpha,
    gamma: merged.gamma
  };
  delete mergedWithCore.episodes;
  delete mergedWithCore.alpha;
  delete mergedWithCore.gamma;

  const fieldNames = Object.keys(mergedWithCore)
    .filter((key) => isPolicyRelevantField(key, policyType))
    .sort();
  const blocks = groupConfigFieldNames(fieldNames);
  return { merged: mergedWithCore, policyType, blocks };
}

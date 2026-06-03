/**
 * Reconstruct policy trace rows (epsilon-greedy / softmax) from resolved run config.
 * UCB is not supported (no stored trace).
 */

function episodeCountFromConfig(config, fallbackRows = 0) {
  const episodes = Number(config?.episodes);
  if (Number.isFinite(episodes) && episodes > 0) {
    return Math.trunc(episodes);
  }
  return Math.max(0, Math.trunc(fallbackRows));
}

function buildEpsilonGreedyTrace(config) {
  const episodes = episodeCountFromConfig(config);
  const start = Number(config.epsilon_start ?? config.epsilon ?? 1);
  const end = Number(config.epsilon_end ?? 0.01);
  const decay = Number(config.epsilon_decay ?? 0);
  const rows = [];
  for (let episode = 1; episode <= episodes; episode += 1) {
    const before = Math.max(end, start - decay * Math.max(episode - 1, 0));
    const after = Math.max(end, start - decay * Math.max(episode, 0));
    rows.push({
      episode: String(episode),
      epsilon_before: String(before),
      epsilon_after: String(after)
    });
  }
  return rows;
}

function buildSoftmaxTrace(config) {
  const episodes = episodeCountFromConfig(config);
  const start = Number(config.temperature_start ?? 1);
  const end = Number(config.temperature_end ?? 0.1);
  const decay = Number(config.temperature_decay ?? 0);
  const mode = String(config.temperature_decay_mode ?? "linear");
  const rows = [];
  for (let episode = 1; episode <= episodes; episode += 1) {
    const beforeIdx = Math.max(episode - 1, 0);
    const afterIdx = Math.max(episode, 0);
    let before;
    let after;
    if (mode === "multiplicative") {
      before = Math.max(end, start * decay ** beforeIdx);
      after = Math.max(end, start * decay ** afterIdx);
    } else {
      before = Math.max(end, start - decay * beforeIdx);
      after = Math.max(end, start - decay * afterIdx);
    }
    rows.push({
      episode: String(episode),
      temperature_before: String(before),
      temperature_after: String(after)
    });
  }
  return rows;
}

/**
 * @param {Record<string, unknown> | null | undefined} resolvedConfigPayload
 * @param {Record<string, unknown> | null | undefined} runSummaryPayload
 * @returns {{ rows: Record<string, string>[], csvText: string } | null}
 */
export function buildPolicyTraceFromConfig(resolvedConfigPayload, runSummaryPayload) {
  const config =
    resolvedConfigPayload?.resolved_run_config ??
    resolvedConfigPayload?.run_config ??
    runSummaryPayload ??
    null;
  if (!config || typeof config !== "object") {
    return null;
  }
  const policyType = String(config.policy_type ?? "");
  if (policyType === "ucb") {
    return null;
  }
  let rows = [];
  if (policyType === "epsilon_greedy") {
    rows = buildEpsilonGreedyTrace(config);
  } else if (policyType === "softmax") {
    rows = buildSoftmaxTrace(config);
  } else {
    return null;
  }
  if (!rows.length) {
    return null;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => row[key] ?? "").join(","));
  }
  return { rows, csvText: `${lines.join("\n")}\n` };
}

/**
 * @param {Record<string, unknown> | null | undefined} policySection from run_bundle.policy
 */
export function buildPolicyTraceFromBundlePolicy(policySection, episodeCount) {
  if (!policySection || typeof policySection !== "object") {
    return null;
  }
  const config = { ...policySection, episodes: episodeCount };
  return buildPolicyTraceFromConfig({ resolved_run_config: config }, null);
}

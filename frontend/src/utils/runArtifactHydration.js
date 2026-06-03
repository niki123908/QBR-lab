import { buildPolicyTraceFromBundlePolicy, buildPolicyTraceFromConfig } from "./policyTrace.js";

function csvPayloadFromEpisodes(episodes, columns) {
  const header = columns.join(",");
  const lines = episodes.map((row) => columns.map((col) => String(row[col] ?? "")).join(","));
  return { text: `${[header, ...lines].join("\n")}\n` };
}

/**
 * Map consolidated API artifacts into legacy UI state shapes.
 * @param {{
 *   runBundle: object | null,
 *   traceEpochs: object | null,
 *   qTable: object | null,
 *   resolvedRunConfig: object | null,
 * }} artifacts
 */
export function hydrateLegacyRunArtifactState(artifacts) {
  const bundle = artifacts.runBundle;
  const metrics = bundle?.metrics ?? bundle ?? null;
  const episodes = Array.isArray(bundle?.episodes) ? bundle.episodes : [];
  const transmission = bundle?.transmission ?? {};

  const runSummaryPayload = metrics && typeof metrics === "object" ? { ...metrics } : null;

  const transmissionLastPayload = transmission.last ?? null;
  const transmissionBestPayload = transmission.best ?? null;

  const trace = artifacts.traceEpochs;
  const stateActionLastPayload = trace?.last ?? null;
  const stateActionBestPayload = trace?.best ?? null;

  const delayPerEpisodePayload =
    episodes.length > 0
      ? csvPayloadFromEpisodes(episodes, ["episode", "delay", "total_reward"])
      : null;
  const pathSignaturesPayload =
    episodes.length > 0 ? csvPayloadFromEpisodes(episodes, ["episode", "path_signature"]) : null;

  const episodeCount = episodes.length || Number(runSummaryPayload?.episodes) || 0;
  const policyFromBundle = bundle?.policy
    ? buildPolicyTraceFromBundlePolicy(bundle.policy, episodeCount)
    : null;
  const policyFromConfig =
    policyFromBundle ?? buildPolicyTraceFromConfig(artifacts.resolvedRunConfig, runSummaryPayload);
  const policyTracePayload = policyFromConfig ? { text: policyFromConfig.csvText } : null;

  return {
    runSummaryPayload,
    transmissionLastPayload,
    transmissionBestPayload,
    stateActionLastPayload,
    stateActionBestPayload,
    qTablePayload: artifacts.qTable ?? null,
    delayPerEpisodePayload,
    policyTracePayload,
    pathSignaturesPayload,
    resolvedRunConfigPayload: artifacts.resolvedRunConfig ?? null,
    stateActionAllPayload: null,
    transmissionAllPayload: null,
    qTableAllEpochsPayload: null
  };
}

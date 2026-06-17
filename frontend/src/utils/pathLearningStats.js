function episodeSteps(episodePayload) {
  return Array.isArray(episodePayload?.steps) ? episodePayload.steps : [];
}

function resolveStepActionKey(step) {
  if (!step || typeof step !== "object") return null;
  if (step.action_aggregated && step.action_group_id !== undefined && step.action_group_id !== null) {
    const groupId = Number(step.action_group_id);
    if (Number.isFinite(groupId)) return groupId;
  }
  const action = Number(step.action);
  return Number.isFinite(action) ? action : null;
}

function lookupQValue(qTable, stateHash, actionKey) {
  if (!qTable || typeof qTable !== "object" || !stateHash) return null;
  const stateQ = qTable[stateHash];
  if (!stateQ || typeof stateQ !== "object") return null;
  const raw = stateQ[actionKey] ?? stateQ[String(actionKey)];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function mapPathStepRow(step, index, qTablePayload) {
  const stateHash = String(step?.state_hash ?? "").trim();
  const action = resolveStepActionKey(step);
  const qValue = lookupQValue(qTablePayload, stateHash, action);
  return {
    timeslot: step?.time ?? step?.timeslot ?? index + 1,
    action,
    qValue,
    actionAggregated: Boolean(step?.action_aggregated)
  };
}

/** One row per step: timeslot, action, learned Q(s,a) from final Q-table. */
export function buildPathQRows(episodePayload, qTablePayload) {
  return episodeSteps(episodePayload)
    .map((step, index) => mapPathStepRow(step, index, qTablePayload))
    .filter((row) => row.action !== null);
}

export function formatPathLearningStat(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000 || Number.isInteger(n)) return String(Math.round(n));
  return n.toFixed(4);
}

export function buildPathLearningSummary({
  stateActionBestPayload,
  stateActionLastPayload,
  qTablePayload
}) {
  const bestRows = buildPathQRows(stateActionBestPayload, qTablePayload);
  const lastRows = buildPathQRows(stateActionLastPayload, qTablePayload);
  if (!bestRows.length && !lastRows.length) return null;
  return { bestRows, lastRows };
}

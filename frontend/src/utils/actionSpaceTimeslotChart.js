export const ACTION_SPACE_CANDIDATE_COLOR = "#377eb8";
export const ACTION_SPACE_GROUP_COLOR = "#e41a1c";

export function pickActionSpaceSummary(payload, groupKeys, candidateKeys) {
  for (const key of groupKeys) {
    const summary = payload?.[key];
    if (Array.isArray(summary?.timeslots) && summary.timeslots.length > 0) {
      return { summary, source: "group" };
    }
  }
  for (const key of candidateKeys) {
    const summary = payload?.[key];
    if (Array.isArray(summary?.timeslots) && summary.timeslots.length > 0) {
      return { summary, source: "candidate_fallback" };
    }
  }
  return { summary: null, source: "none" };
}

export function buildActionSpaceCompareRows(candidateSummary, groupSummary) {
  const bySlot = new Map();
  const ingest = (summary, field) => {
    (summary?.timeslots ?? []).forEach((row) => {
      const slot = row?.timeslot;
      if (slot === undefined || slot === null) return;
      const key = String(slot);
      const existing = bySlot.get(key) ?? { timeslot: slot };
      const mean = Number(row?.mean_candidate_count);
      if (Number.isFinite(mean)) {
        existing[field] = mean;
      }
      const nPaths = Number(row?.n_unique_paths);
      if (Number.isFinite(nPaths)) {
        existing.n_unique_paths = nPaths;
      }
      bySlot.set(key, existing);
    });
  };
  ingest(candidateSummary, "mean_candidate_count");
  ingest(groupSummary, "mean_group_count");
  return [...bySlot.values()].sort((a, b) => Number(a.timeslot) - Number(b.timeslot));
}

export function resolveRunActionAxis(payload) {
  const raw = String(payload?.action_axis ?? "")
    .trim()
    .toLowerCase();
  if (raw === "receiver" || raw === "rcv") return "receiver";
  if (raw === "broadcaster" || raw === "br") return "broadcaster";

  const primaryAxis = String(payload?.action_space_by_timeslot?.action_axis ?? "");
  if (primaryAxis === "rcv_cands") return "receiver";
  if (primaryAxis === "br_cands") return "broadcaster";

  const rcvLen = payload?.action_space_by_timeslot_rcv?.timeslots?.length ?? 0;
  const brLen = payload?.action_space_by_timeslot_br?.timeslots?.length ?? 0;
  if (rcvLen && !brLen) return "receiver";
  if (brLen && !rcvLen) return "broadcaster";
  return "broadcaster";
}

export function buildActiveActionSpacePanel(payload) {
  const actionAxis = resolveRunActionAxis(payload);
  const isReceiver = actionAxis === "receiver";
  const axisText = isReceiver ? "receive" : "broadcast";

  const candidateKeys = isReceiver
    ? ["action_space_by_timeslot_rcv", "action_space_by_timeslot"]
    : ["action_space_by_timeslot_br", "action_space_by_timeslot"];
  const groupKeys = isReceiver
    ? ["action_space_by_timeslot_group_rcv", "action_space_by_timeslot_group"]
    : ["action_space_by_timeslot_group_br", "action_space_by_timeslot_group"];

  const candidatePick = pickActionSpaceSummary(payload, [], candidateKeys);
  const groupPick = pickActionSpaceSummary(payload, groupKeys, candidateKeys);
  const compareRows = buildActionSpaceCompareRows(candidatePick.summary, groupPick.summary);

  return {
    actionAxis,
    axisText,
    axisLabel: isReceiver ? "Receive" : "Broadcast",
    candidateSummary: candidatePick.summary,
    groupSummary: groupPick.summary,
    compareRows,
    hasData: compareRows.length > 0
  };
}

export function dualChartYMax(compareRows) {
  const vals = (compareRows ?? [])
    .flatMap((row) => [Number(row.mean_candidate_count), Number(row.mean_group_count)])
    .filter((n) => Number.isFinite(n));
  return vals.length ? Math.max(...vals, 1e-6) : 1;
}

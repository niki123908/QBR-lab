/** Compact learning-size suffix for run history labels (S=states, A=state-action pairs, E=graph edges). */
export function formatRunLearningStatsSuffix(run) {
  if (!run || typeof run !== "object") return "";
  const hasAny =
    Number.isFinite(Number(run.total_states)) ||
    Number.isFinite(Number(run.total_state_actions)) ||
    Number.isFinite(Number(run.decision_graph_edges));
  if (!hasAny) return "";
  const states = Number.isFinite(Number(run.total_states)) ? Number(run.total_states) : "—";
  const actions = Number.isFinite(Number(run.total_state_actions)) ? Number(run.total_state_actions) : "—";
  const edges = Number.isFinite(Number(run.decision_graph_edges)) ? Number(run.decision_graph_edges) : "—";
  return ` · S:${states} A:${actions} E:${edges}`;
}

export function hasRunLearningStats(run) {
  return Boolean(formatRunLearningStatsSuffix(run));
}

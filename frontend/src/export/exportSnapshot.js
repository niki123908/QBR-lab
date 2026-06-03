/** @typedef {import('./exportContexts.js').ExportSnapshot} ExportSnapshot */

export function createExportSnapshot(state) {
  return {
    activeMenu: state.activeMenu ?? "home",
    homeToolTab: state.homeToolTab ?? "softmax",
    activePanel2Tab: state.activePanel2Tab ?? "detail",
    focusedBatchId: state.focusedBatchId ?? null,
    focusedTopologyId: state.focusedTopologyId ?? null,
    focusedBatchRunId: state.focusedBatchRunId ?? null,
    temperatureRows: state.temperatureRows ?? [],
    ucbRows: state.ucbRows ?? [],
    compareExport: state.compareExport ?? null,
    focusedBatchRunResult: state.focusedBatchRunResult ?? null,
    batchRunProgress: state.batchRunProgress ?? null,
    qTableRows: state.qTableRows ?? [],
    qTableRowCount: state.qTableRowCount ?? 0,
    actionSpaceRows: state.actionSpaceRows ?? [],
    actionSpaceProfile: state.actionSpaceProfile ?? "rcv",
    resultsSingleFocusedBatch: state.resultsSingleFocusedBatch ?? null,
    batchRunResults: state.batchRunResults ?? [],
    batchResultAliasMap: state.batchResultAliasMap ?? {},
    batches: state.batches ?? [],
    filteredBatches: state.filteredBatches ?? [],
    focusedBatchTopologies: state.focusedBatchTopologies ?? [],
    topologyNodes: state.topologyNodes ?? [],
    playgroundTree: state.playgroundTree ?? null,
    runMultiForm: state.runMultiForm ?? {},
    runBatchTopologies: state.runBatchTopologies ?? [],
    delayPerEpisodePayload: state.delayPerEpisodePayload ?? null,
    policyTracePayload: state.policyTracePayload ?? null,
    pathSignaturesPayload: state.pathSignaturesPayload ?? null,
    runHistoryItems: state.runHistoryItems ?? [],
    selectedTopology: state.selectedTopology ?? null
  };
}

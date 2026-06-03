import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DashboardSidebar from "./components/DashboardSidebar";
import MainTopologyPanel from "./components/MainTopologyPanel";
import PanelResizer from "./components/PanelResizer";
import RightControlPanel from "./components/RightControlPanel";
import CsvExportModal from "./components/CsvExportModal";
import RunBatchNameModal from "./components/RunBatchNameModal";
import { buildDefaultBatchRunResultLabel } from "./utils/batchRunLabel.js";
import {
  DEFAULT_DECISION_TREE_EDGE_OPACITY,
  DEFAULT_DECISION_TREE_EDGE_SCALE,
  DEFAULT_DECISION_TREE_FONT_SCALE,
  DEFAULT_DECISION_TREE_NODE_SCALE,
  DEFAULT_DECISION_TREE_ROW_SPREAD,
  EMPTY_PLAYGROUND_TREE
} from "./components/PlaygroundStateTree";
import { createExportSnapshot } from "./export/exportSnapshot.js";
import { resolveExportContext } from "./export/exportContexts.js";
import { getInitialDecisionTreeLayout, saveDecisionTreeLayoutAsDefault, refreshInitialDecisionTreeLayoutCache } from "./utils/decisionTreeLayoutStorage.js";
import { hydrateLegacyRunArtifactState } from "./utils/runArtifactHydration.js";
import { buildPolicyTraceFromConfig } from "./utils/policyTrace.js";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000/api";

const PANEL_LAYOUT_STORAGE_KEY = "qbr.panel-layout";
const SIDEBAR_WIDTH_DEFAULT = 280;
const RIGHT_PANEL_WIDTH_DEFAULT = 420;
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 360;
const RIGHT_PANEL_WIDTH_MIN = 280;
const RIGHT_PANEL_WIDTH_MAX = 560;
const PANEL_RESIZER_WIDTH = 6;

function clampPanelWidth(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredPanelLayout() {
  try {
    const raw = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return { sidebarWidth: SIDEBAR_WIDTH_DEFAULT, rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT };
    }
    const parsed = JSON.parse(raw);
    return {
      sidebarWidth: clampPanelWidth(parsed.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX),
      rightPanelWidth: clampPanelWidth(
        parsed.rightPanelWidth ?? RIGHT_PANEL_WIDTH_DEFAULT,
        RIGHT_PANEL_WIDTH_MIN,
        RIGHT_PANEL_WIDTH_MAX
      )
    };
  } catch {
    return { sidebarWidth: SIDEBAR_WIDTH_DEFAULT, rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT };
  }
}
const NODE_OPTIONS = [
  50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750,
  800, 850, 900, 950, 1000
];
const GRID_PREVIEW_FETCH_LIMIT = 12;
const LARGE_TOPO_THRESHOLD = 500;
const LIST_CACHE_TTL_MS = 10_000;
const LARGE_TOPO_CONFIRM_MESSAGE =
  "topo nặng, nếu render thì tốn thời gian, xác nhận render";

function resolveBackboneId(algorithmId) {
  if (algorithmId === "qbr") return "qbr";
  if (algorithmId === "greedy") return "greedy";
  return String(algorithmId || "");
}

const INITIAL_GENERATE_FORM = {
  num_nodes: 50,
  space_width: 100,
  space_height: 100,
  tx_range: 20,
  sink_mode: "manual",
  sink_x: 50,
  sink_y: 50,
  use_seed: true,
  seed: 2026,
  max_retry: 200
};
const INITIAL_MULTI_GENERATE_FORM = {
  node_counts: [50, 100],
  count_per_node_count: 2,
  space_width: 100,
  space_height: 100,
  tx_range: 20,
  sink_mode: "manual",
  sink_x: 50,
  sink_y: 50,
  max_retry: 200
};
const INITIAL_RUN_TOPO_FORM = {
  algorithm_id: "greedy",
  preset_id: "default_v1",
  preset_name: "default_v1",
  use_run_seed: false,
  run_seed: 2026
};
const INITIAL_RUN_MULTI_FORM = {
  batch_id: "",
  batch_selected: false,
  algorithm_id: "greedy",
  preset_id: "default_v1",
  preset_name: "default_v1",
  selected_topology_ids: [],
  use_run_seed: false,
  run_seed: 2026,
  artifact_flags: {
    path_signature: false,
    delay_per_episode: false
  }
};

function buildRunConfigPayload(configForm, runForm) {
  const base = { ...(configForm ?? {}) };
  if (runForm?.use_run_seed) {
    const seed = Math.trunc(Number(runForm.run_seed));
    if (!Number.isFinite(seed) || seed < 0) {
      return { ...base, run_seed: null };
    }
    return { ...base, run_seed: seed };
  }
  return { ...base, run_seed: null };
}
const INITIAL_GRAPH_DISPLAY_SETTINGS = {
  node_size: 2,
  label_size: 2.4,
  edge_width: 0.45
};
const INITIAL_PLAYGROUND_STATE = {
  mode: "broadcaster",
  timeslots: [],
  currentSlot: 0,
  viewSlot: 0,
  coveredNodeIds: [0],
  hoverPreview: null,
  isComplete: false
};
const INITIAL_TEMPERATURE_TOOL = {
  actionCount: 5,
  tauMin: 0.001,
  tauMax: 5,
  tau: 1,
  qMin: -5,
  qMax: 5,
  qValues: [0, 1, 2, 3, 4],
  fontScale: 1
};
const INITIAL_UCB_TOOL = {
  actionCount: 5,
  ucbC: 1.414,
  ucbCMin: 0.1,
  ucbCMax: 5,
  globalT: 10,
  globalTMin: 1,
  globalTMax: 1000,
  qMin: -5,
  qMax: 5,
  qValues: [0, 1, 2, 3, 4],
  visitCounts: [1, 2, 1, 0, 0],
  visitMax: 100,
  fontScale: 1
};

const IDLE_PRESET_WIZARD = { phase: "idle", draftClientId: "", snapshot: null };

/** Removed: presets now live in API/DB only. */
const LEGACY_PRESET_LOCAL_STORAGE_KEYS = [
  "qbr_run_presets_v2",
  "qbr_run_topo_presets_v1",
  "qbr_run_topo_preset_wizard_v1",
  "qbr_run_multi_preset_wizard_v1"
];

function buildAdjacencyFromGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return new Map();
  const adjacency = new Map(graph.nodes.map((node) => [node.node_id, new Set()]));
  const txRange = Number(graph.tx_range) || 0;
  const txRangeSq = txRange * txRange;
  const nodes = graph.nodes;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy <= txRangeSq) {
        adjacency.get(a.node_id)?.add(b.node_id);
        adjacency.get(b.node_id)?.add(a.node_id);
      }
    }
  }
  return adjacency;
}

function derivePlaygroundCandidates(graph, coveredNodeIds) {
  const covered = new Set(coveredNodeIds ?? []);
  const adjacency = buildAdjacencyFromGraph(graph);
  const broadcasterCandidates = [];
  const receiverCandidatesSet = new Set();

  covered.forEach((nodeId) => {
    const neighbors = adjacency.get(nodeId) ?? new Set();
    const canReachUncovered = Array.from(neighbors).some((neighborId) => !covered.has(neighborId));
    if (canReachUncovered) {
      broadcasterCandidates.push(nodeId);
      neighbors.forEach((neighborId) => {
        if (!covered.has(neighborId)) {
          receiverCandidatesSet.add(neighborId);
        }
      });
    }
  });

  return {
    adjacency,
    broadcasterCandidates: broadcasterCandidates.sort((a, b) => a - b),
    receiverCandidates: Array.from(receiverCandidatesSet).sort((a, b) => a - b)
  };
}

function mapReceiverToBroadcaster(receiverId, broadcasterCandidates, receiverCandidates, adjacency) {
  const receiverCandidateSet = new Set(receiverCandidates);
  const broadcasters = broadcasterCandidates.filter((nodeId) => adjacency.get(nodeId)?.has(receiverId));
  if (!broadcasters.length) return null;
  return [...broadcasters].sort((a, b) => {
    const aCover = Array.from(adjacency.get(a) ?? []).filter((nodeId) => receiverCandidateSet.has(nodeId)).length;
    const bCover = Array.from(adjacency.get(b) ?? []).filter((nodeId) => receiverCandidateSet.has(nodeId)).length;
    if (bCover !== aCover) return bCover - aCover;
    return a - b;
  })[0];
}

function simulatePlaygroundSlot(graph, coveredNodeIds, mode, selectedNodeId) {
  const covered = new Set(coveredNodeIds ?? []);
  const { adjacency, broadcasterCandidates, receiverCandidates } = derivePlaygroundCandidates(graph, coveredNodeIds);
  const receiverCandidateSet = new Set(receiverCandidates);
  let firstPick = null;

  if (mode === "receiver") {
    firstPick = mapReceiverToBroadcaster(selectedNodeId, broadcasterCandidates, receiverCandidates, adjacency);
  } else if (broadcasterCandidates.includes(selectedNodeId)) {
    firstPick = selectedNodeId;
  }

  if (firstPick === null || firstPick === undefined) {
    return null;
  }

  const broadcastersRemaining = [...broadcasterCandidates];
  const transmitters = [];
  const receivers = [];

  function collectReceiversFor(nodeId) {
    return Array.from(adjacency.get(nodeId) ?? [])
      .filter((neighborId) => !covered.has(neighborId) && receiverCandidateSet.has(neighborId))
      .sort((a, b) => a - b);
  }

  const firstIndex = broadcastersRemaining.indexOf(firstPick);
  if (firstIndex >= 0) {
    const coveredByFirst = collectReceiversFor(firstPick);
    transmitters.push(firstPick);
    receivers.push(...coveredByFirst);
    broadcastersRemaining.splice(firstIndex, 1);
  }

  broadcastersRemaining.sort((a, b) => collectReceiversFor(b).length - collectReceiversFor(a).length || a - b);

  let idx = 0;
  while (idx < broadcastersRemaining.length) {
    const broadcasterId = broadcastersRemaining[idx];
    const candidateReceivers = collectReceiversFor(broadcasterId);
    if (candidateReceivers.some((nodeId) => receivers.includes(nodeId))) {
      broadcastersRemaining.splice(idx, 1);
      continue;
    }
    if (candidateReceivers.length > 0) {
      transmitters.push(broadcasterId);
      receivers.push(...candidateReceivers);
    }
    broadcastersRemaining.splice(idx, 1);
  }

  const uniqueReceivers = Array.from(new Set(receivers)).sort((a, b) => a - b);
  if (uniqueReceivers.length === 0) {
    return null;
  }

  return {
    firstPick,
    mode,
    transmitters: Array.from(new Set(transmitters)).sort((a, b) => a - b),
    receivers: uniqueReceivers
  };
}

export function playgroundStateHash(coveredNodeIds) {
  const sorted = [...(coveredNodeIds ?? [])].sort((a, b) => a - b);
  if (sorted.length === 1 && sorted[0] === 0) return "0";
  return sorted.join("/");
}

function countUniqueNextPlaygroundStates(graph, coveredNodeIds, mode) {
  if (!graph) return 0;
  const { broadcasterCandidates, receiverCandidates } = derivePlaygroundCandidates(graph, coveredNodeIds);
  const actions = mode === "receiver" ? receiverCandidates : broadcasterCandidates;
  const uniqueStateHashes = new Set();
  actions.forEach((nodeId) => {
    const nextSlot = simulatePlaygroundSlot(graph, coveredNodeIds, mode, nodeId);
    if (!nextSlot) return;
    const nextCovered = Array.from(new Set([...(coveredNodeIds ?? []), ...(nextSlot.receivers ?? [])])).sort((a, b) => a - b);
    uniqueStateHashes.add(nextCovered.join("/"));
  });
  return uniqueStateHashes.size;
}

function normalizeRange(minValue, maxValue, fallback = { min: 0, max: 1 }, minGap = 0.001) {
  const fallbackMin = Number(fallback?.min ?? 0);
  const fallbackMax = Number(fallback?.max ?? 1);
  let min = Number(minValue);
  let max = Number(maxValue);
  if (!Number.isFinite(min)) min = fallbackMin;
  if (!Number.isFinite(max)) max = fallbackMax;
  if (min > max) {
    [min, max] = [max, min];
  }
  if (max - min < minGap) {
    max = min + minGap;
  }
  return { min, max };
}

function resizeQValues(qValues, nextCount, defaultValue = 0) {
  const target = Math.max(1, Math.min(10, Number(nextCount) || 1));
  const current = Array.isArray(qValues) ? qValues.slice(0, target) : [];
  while (current.length < target) current.push(defaultValue);
  return current;
}

function resizeVisitCounts(visitCounts, nextCount, defaultValue = 0) {
  const target = Math.max(1, Math.min(10, Number(nextCount) || 1));
  const current = Array.isArray(visitCounts) ? visitCounts.slice(0, target) : [];
  while (current.length < target) current.push(defaultValue);
  return current.map((value) => Math.max(0, Math.trunc(Number(value) || 0)));
}

function clampValue(value, minValue, maxValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minValue;
  return Math.min(maxValue, Math.max(minValue, numeric));
}

function computeSoftmaxProbabilities(qValues, tau) {
  const safeTau = Number(tau);
  const epsilon = 1e-6;
  const values = (qValues ?? []).map((value) => Number(value) || 0);
  if (values.length === 0) return [];
  if (!Number.isFinite(safeTau) || safeTau <= epsilon) {
    const maxQ = Math.max(...values);
    const winners = values.map((value, index) => ({ value, index })).filter((item) => item.value === maxQ);
    const probability = winners.length > 0 ? 1 / winners.length : 0;
    return values.map((value, index) => ({
      action: `A${index + 1}`,
      qValue: value,
      logit: Number.isFinite(safeTau) ? value / Math.max(safeTau, epsilon) : null,
      probability: winners.some((item) => item.index === index) ? probability : 0
    }));
  }
  const logits = values.map((value) => value / safeTau);
  const maxLogit = Math.max(...logits);
  const expValues = logits.map((logit) => Math.exp(logit - maxLogit));
  const expSum = expValues.reduce((sum, value) => sum + value, 0);
  return values.map((value, index) => ({
    action: `A${index + 1}`,
    qValue: value,
    logit: logits[index],
    probability: expSum > 0 ? expValues[index] / expSum : 0
  }));
}

export default function App() {
  const [activeMenu, setActiveMenu] = useState("home");
  const [activePanel2Tab, setActivePanel2Tab] = useState("detail");
  const [statusFilter, setStatusFilter] = useState("");
  const [nodeFilter, setNodeFilter] = useState("");
  const [topologies, setTopologies] = useState([]);
  const [batches, setBatches] = useState([]);
  const [sidebarBatches, setSidebarBatches] = useState([]);
  const [selectedTopology, setSelectedTopology] = useState(null);
  const [focusedBatchId, setFocusedBatchId] = useState(null);
  const [focusedTopologyId, setFocusedTopologyId] = useState(null);
  const [graphByTopologyId, setGraphByTopologyId] = useState({});
  const [heavyRenderApprovedIds, setHeavyRenderApprovedIds] = useState([]);
  const [generateMode, setGenerateMode] = useState("single");
  const [message, setMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateForm, setGenerateForm] = useState(INITIAL_GENERATE_FORM);
  const [multiGenerateForm, setMultiGenerateForm] = useState(INITIAL_MULTI_GENERATE_FORM);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [runTopoForm, setRunTopoForm] = useState(INITIAL_RUN_TOPO_FORM);
  const [runMultiForm, setRunMultiForm] = useState(INITIAL_RUN_MULTI_FORM);
  const [runMultiSubMode, setRunMultiSubMode] = useState("multi");
  const [repeatTopologyId, setRepeatTopologyId] = useState("");
  const [repeatRunCount, setRepeatRunCount] = useState(5);
  const [algorithmOptions, setAlgorithmOptions] = useState([]);
  const [runPresets, setRunPresets] = useState([]);
  const [runTopoWizard, setRunTopoWizard] = useState(IDLE_PRESET_WIZARD);
  const [runMultiWizard, setRunMultiWizard] = useState(IDLE_PRESET_WIZARD);
  const [sharedRunConfigByBackbone, setSharedRunConfigByBackbone] = useState({});
  const [isRunningSingle, setIsRunningSingle] = useState(false);
  const [pendingSingleRunId, setPendingSingleRunId] = useState(null);
  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [runBatchNameModalOpen, setRunBatchNameModalOpen] = useState(false);
  const [runBatchNameDraft, setRunBatchNameDraft] = useState("");
  const [runBatchDefaultLabel, setRunBatchDefaultLabel] = useState("");
  const [lastSingleRun, setLastSingleRun] = useState(null);
  const [runHistoryItems, setRunHistoryItems] = useState([]);
  const [runSummaryPayload, setRunSummaryPayload] = useState(null);
  const [transmissionLastPayload, setTransmissionLastPayload] = useState(null);
  const [transmissionBestPayload, setTransmissionBestPayload] = useState(null);
  const [stateActionLastPayload, setStateActionLastPayload] = useState(null);
  const [stateActionBestPayload, setStateActionBestPayload] = useState(null);
  const [qTablePayload, setQTablePayload] = useState(null);
  const [delayPerEpisodePayload, setDelayPerEpisodePayload] = useState(null);
  const [policyTracePayload, setPolicyTracePayload] = useState(null);
  const [pathSignaturesPayload, setPathSignaturesPayload] = useState(null);
  const [resolvedRunConfigPayload, setResolvedRunConfigPayload] = useState(null);
  const [stateActionAllPayload, setStateActionAllPayload] = useState(null);
  const [transmissionAllPayload, setTransmissionAllPayload] = useState(null);
  const [qTableAllEpochsPayload, setQTableAllEpochsPayload] = useState(null);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [resultsViewMode, setResultsViewMode] = useState("timeslot");
  const [resultsEpochMode, setResultsEpochMode] = useState("last");
  const [selectedEpisode, setSelectedEpisode] = useState("");
  const [replaySlot, setReplaySlot] = useState(0);
  const [graphDisplaySettings, setGraphDisplaySettings] = useState(INITIAL_GRAPH_DISPLAY_SETTINGS);
  const [bestDelayOverlayOpacity, setBestDelayOverlayOpacity] = useState(1);
  const [previewMaxNodesPercent, setPreviewMaxNodesPercent] = useState(80);
  const [previewShowEdges, setPreviewShowEdges] = useState(true);
  const [playgroundState, setPlaygroundState] = useState(INITIAL_PLAYGROUND_STATE);
  const [playgroundTree, setPlaygroundTree] = useState(null);
  const [playgroundTreeLoading, setPlaygroundTreeLoading] = useState(false);
  const [playgroundTreeLoadError, setPlaygroundTreeLoadError] = useState(null);
  const [playgroundTreeExpanding, setPlaygroundTreeExpanding] = useState(false);
  const [playgroundTreeExpandStats, setPlaygroundTreeExpandStats] = useState(null);
  const [playgroundTreeMode, setPlaygroundTreeMode] = useState("manual");
  const [runDerivedTree, setRunDerivedTree] = useState(null);
  const [runDerivedTreeLoading, setRunDerivedTreeLoading] = useState(false);
  const [runDerivedTreeLoadError, setRunDerivedTreeLoadError] = useState(null);
  const [runDerivedTreeMessage, setRunDerivedTreeMessage] = useState(null);
  const [runDerivedTreeSourceArtifact, setRunDerivedTreeSourceArtifact] = useState(null);
  const [playgroundRunSourceId, setPlaygroundRunSourceId] = useState(null);
  const [decisionTreeRowSpread, setDecisionTreeRowSpread] = useState(() => getInitialDecisionTreeLayout().rowSpread);
  const [decisionTreeFontScale, setDecisionTreeFontScale] = useState(() => getInitialDecisionTreeLayout().fontScale);
  const [decisionTreeEdgeScale, setDecisionTreeEdgeScale] = useState(() => getInitialDecisionTreeLayout().edgeScale);
  const [decisionTreeNodeScale, setDecisionTreeNodeScale] = useState(() => getInitialDecisionTreeLayout().nodeScale);
  const [decisionTreeEdgeOpacity, setDecisionTreeEdgeOpacity] = useState(() => getInitialDecisionTreeLayout().edgeOpacity);

  const handleSaveDecisionTreeLayoutDefaults = useCallback(() => {
    const layout = {
      rowSpread: decisionTreeRowSpread,
      fontScale: decisionTreeFontScale,
      edgeScale: decisionTreeEdgeScale,
      nodeScale: decisionTreeNodeScale,
      edgeOpacity: decisionTreeEdgeOpacity
    };
    saveDecisionTreeLayoutAsDefault(layout);
    refreshInitialDecisionTreeLayoutCache(layout);
    setMessage("Decision tree layout saved as default.");
  }, [
    decisionTreeRowSpread,
    decisionTreeFontScale,
    decisionTreeEdgeScale,
    decisionTreeNodeScale,
    decisionTreeEdgeOpacity
  ]);

  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredPanelLayout().sidebarWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(() => readStoredPanelLayout().rightPanelWidth);
  const [isNarrowLayout, setIsNarrowLayout] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 1280px)").matches : false
  );
  const [temperatureTool, setTemperatureTool] = useState(INITIAL_TEMPERATURE_TOOL);
  const [ucbTool, setUcbTool] = useState(INITIAL_UCB_TOOL);
  const [homeToolTab, setHomeToolTab] = useState("softmax");
  const [batchRunResults, setBatchRunResults] = useState([]);
  const [focusedBatchRunId, setFocusedBatchRunId] = useState(null);
  const [focusedBatchRunResult, setFocusedBatchRunResult] = useState(null);
  const [isLoadingBatchRunResult, setIsLoadingBatchRunResult] = useState(false);
  const [batchRunResultDetailError, setBatchRunResultDetailError] = useState(null);
  const [isLoadingBatchRunResults, setIsLoadingBatchRunResults] = useState(false);
  const [batchRunResultsError, setBatchRunResultsError] = useState(null);
  const [batchRunProgress, setBatchRunProgress] = useState(null);
  const [queueSnapshot, setQueueSnapshot] = useState(null);
  const [workersExpanded, setWorkersExpanded] = useState(false);
  const [managedWorkers, setManagedWorkers] = useState([]);
  const [isSpawningWorker, setIsSpawningWorker] = useState(false);
  const [killingWorkerId, setKillingWorkerId] = useState("");
  const [singleRunTopologyIds, setSingleRunTopologyIds] = useState([]);
  const batchDetailRefreshKeyRef = useRef("");
  /** If user returns to Run multi while this batch is still running/completing, snap to Results when it finishes. */
  const pendingNavigateFromRunMultiBatchIdRef = useRef(null);

  function resetGraphDisplaySettings() {
    setGraphDisplaySettings(INITIAL_GRAPH_DISPLAY_SETTINGS);
  }

  function resetPlaygroundState() {
    setPlaygroundState(INITIAL_PLAYGROUND_STATE);
  }

  async function fetchPlaygroundTree(topologyId) {
    if (!topologyId) {
      setPlaygroundTree(null);
      setPlaygroundTreeLoadError(null);
      return;
    }
    setPlaygroundTreeLoading(true);
    try {
      const response = await fetch(`${API_BASE}/topologies/${topologyId}/playground-tree`);
      const data = await response.json();
      if (!response.ok) {
        setPlaygroundTree(EMPTY_PLAYGROUND_TREE);
        setPlaygroundTreeLoadError(
          response.status === 404
            ? "State tree API not found — restart the backend, then reload this page."
            : data?.message || "Could not load state tree from server."
        );
        return;
      }
      setPlaygroundTree(data);
      setPlaygroundTreeLoadError(null);
    } catch {
      setPlaygroundTree(EMPTY_PLAYGROUND_TREE);
      setPlaygroundTreeLoadError("Could not reach the API — check that the backend is running.");
    } finally {
      setPlaygroundTreeLoading(false);
    }
  }

  async function appendPlaygroundTreeTransition(topologyId, payload) {
    if (!topologyId) return;
    try {
      const response = await fetch(`${API_BASE}/topologies/${topologyId}/playground-tree/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (response.ok) {
        setPlaygroundTree(data);
      }
    } catch {
      // Keep existing tree on network failure.
    }
  }

  async function resetPlaygroundTreeData(topologyId) {
    if (!topologyId) return;
    setPlaygroundTreeLoading(true);
    try {
      const response = await fetch(`${API_BASE}/topologies/${topologyId}/playground-tree`, {
        method: "DELETE"
      });
      const data = await response.json();
      if (response.ok) {
        setPlaygroundTree(data);
        setPlaygroundTreeExpandStats(null);
        setMessage("Success.");
      } else {
        setMessage(data?.message || "Failed.");
      }
    } catch {
      setMessage("Failed.");
    } finally {
      setPlaygroundTreeLoading(false);
    }
  }

  async function expandPlaygroundTreeAll(topologyId) {
    if (!topologyId) return;
    setPlaygroundTreeExpanding(true);
    setPlaygroundTreeLoadError(null);
    try {
      const response = await fetch(`${API_BASE}/topologies/${topologyId}/playground-tree/expand`, {
        method: "POST"
      });
      const data = await response.json();
      if (response.ok) {
        setPlaygroundTree(data);
        const stats = data.expand_stats ?? null;
        setPlaygroundTreeExpandStats(stats);
        const paths = Number(stats?.unique_paths ?? 0).toLocaleString();
        const transitions = Number(stats?.transitions_applied ?? 0).toLocaleString();
        const suffix = stats?.truncated ? " (10k transition cap reached)" : "";
        setMessage(
          `Expand done${suffix}: ${paths} unique paths after ${transitions} transitions; +${stats?.nodes_added ?? 0} states, +${stats?.edges_added ?? 0} edges (${stats?.edges_to_existing_states ?? 0} to existing states).`
        );
      } else {
        setMessage(data?.message || "Failed.");
      }
    } catch {
      setMessage("Failed.");
      setPlaygroundTreeLoadError("Could not reach the API — check that the backend is running.");
    } finally {
      setPlaygroundTreeExpanding(false);
    }
  }

  async function fetchRunDerivedPlaygroundTree(topologyId, runId) {
    if (!topologyId || !runId) {
      setRunDerivedTree(null);
      setRunDerivedTreeLoadError(null);
      setRunDerivedTreeMessage(null);
      setRunDerivedTreeSourceArtifact(null);
      return;
    }
    setRunDerivedTreeLoading(true);
    setRunDerivedTreeLoadError(null);
    try {
      const response = await fetch(
        `${API_BASE}/topologies/${topologyId}/playground-tree/run-derived?run_id=${encodeURIComponent(runId)}`
      );
      const data = await response.json();
      if (!response.ok) {
        setRunDerivedTree(EMPTY_PLAYGROUND_TREE);
        setRunDerivedTreeLoadError(
          response.status === 404
            ? "Run-derived tree API not found or run/topology mismatch."
            : data?.message || "Could not load run-derived tree."
        );
        setRunDerivedTreeMessage(null);
        setRunDerivedTreeSourceArtifact(null);
        return;
      }
      setRunDerivedTree(data);
      setRunDerivedTreeMessage(data?.message ?? null);
      setRunDerivedTreeSourceArtifact(data?.source_artifact ?? null);
    } catch {
      setRunDerivedTree(EMPTY_PLAYGROUND_TREE);
      setRunDerivedTreeLoadError("Could not reach the API — check that the backend is running.");
      setRunDerivedTreeMessage(null);
      setRunDerivedTreeSourceArtifact(null);
    } finally {
      setRunDerivedTreeLoading(false);
    }
  }

  function resetTemperatureTool() {
    setTemperatureTool(INITIAL_TEMPERATURE_TOOL);
  }

  function resetUcbTool() {
    setUcbTool(INITIAL_UCB_TOOL);
  }
  const [topologyNodes, setTopologyNodes] = useState([]);
  const [topologyDetail, setTopologyDetail] = useState(null);
  const [isLoadingNodes, setIsLoadingNodes] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isSavingTopology, setIsSavingTopology] = useState(false);
  const topologyListCacheRef = useRef(new Map());
  const batchListCacheRef = useRef(new Map());
  const graphCacheRef = useRef(new Map());
  const graphInFlightRef = useRef(new Map());
  const pendingNodePatchPromisesRef = useRef(new Set());
  const selectedBatch = useMemo(
    () =>
      sidebarBatches.find((item) => item.batch_id === selectedBatchId) ??
      batches.find((item) => item.batch_id === selectedBatchId) ??
      null,
    [sidebarBatches, batches, selectedBatchId]
  );

  const focusedBatchForPanel = useMemo(
    () => (focusedBatchId ? sidebarBatches.find((b) => b.batch_id === focusedBatchId) ?? null : null),
    [sidebarBatches, focusedBatchId]
  );
  const algorithmDefaultConfigById = useMemo(
    () =>
      Object.fromEntries((algorithmOptions ?? []).map((item) => [item.algorithm_id, { ...(item.default_config ?? {}) }])),
    [algorithmOptions]
  );
  const runTopoBackbone = resolveBackboneId(runTopoForm.algorithm_id);
  const runMultiBackbone = resolveBackboneId(runMultiForm.algorithm_id);
  const runTopoConfigForm = sharedRunConfigByBackbone[runTopoBackbone] ?? algorithmDefaultConfigById[runTopoForm.algorithm_id] ?? {};
  const runMultiConfigForm =
    sharedRunConfigByBackbone[runMultiBackbone] ?? algorithmDefaultConfigById[runMultiForm.algorithm_id] ?? {};

  function setSharedRunConfigForBackbone(backboneId, updater) {
    setSharedRunConfigByBackbone((prev) => {
      const current = prev[backboneId] ?? {};
      const nextValue = typeof updater === "function" ? updater(current) : updater;
      return { ...prev, [backboneId]: nextValue ?? {} };
    });
  }
  const setRunTopoConfigForm = (updater) => setSharedRunConfigForBackbone(runTopoBackbone, updater);
  const setRunMultiConfigForm = (updater) => setSharedRunConfigForBackbone(runMultiBackbone, updater);
  const singleRunTopologyIdSet = useMemo(() => new Set(singleRunTopologyIds), [singleRunTopologyIds]);
  const topologyNameById = useCallback(
    (topologyId) => topologies.find((item) => item.topology_id === topologyId)?.topology_name ?? null,
    [topologies]
  );
  const runBatchesForSingleResults = useMemo(
    () =>
      (sidebarBatches ?? [])
        .map((batch) => ({
          ...batch,
          topologies: (batch.topologies ?? []).filter((topo) => singleRunTopologyIdSet.has(topo.topology_id)),
        }))
        .filter((batch) => (batch.topologies ?? []).length > 0),
    [sidebarBatches, singleRunTopologyIdSet]
  );

  function clearListCaches() {
    topologyListCacheRef.current.clear();
    batchListCacheRef.current.clear();
  }

  function parseApiError(data, fallback = "Failed.") {
    if (!data) return fallback;
    if (typeof data.message === "string" && data.message.trim()) return data.message;
    if (Array.isArray(data.detail) && data.detail.length > 0) {
      const first = data.detail[0];
      if (typeof first === "string") return first;
      if (first && typeof first.msg === "string") return first.msg;
    }
    if (typeof data.detail === "string" && data.detail.trim()) return data.detail;
    return fallback;
  }

  async function loadRunPresets() {
    try {
      const response = await fetch(`${API_BASE}/presets`);
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Could not load presets."));
        setRunPresets([]);
        return [];
      }
      const list = Array.isArray(data) ? data : [];
      setRunPresets(list);
      return list;
    } catch {
      setMessage("Could not load presets.");
      setRunPresets([]);
      return [];
    }
  }

  async function fetchTopologies() {
    const params = new URLSearchParams();
    if (statusFilter) {
      params.set("status", statusFilter);
    }
    if (nodeFilter) {
      params.set("nodes", nodeFilter);
    }
    const cacheKey = params.toString();
    const cached = topologyListCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.ts < LIST_CACHE_TTL_MS) {
      const ids = new Set(cached.data.map((item) => item.topology_id));
      setTopologies(cached.data);
      if (cached.data.length === 0) {
        setSelectedTopology(null);
        setFocusedTopologyId(null);
      } else if (!selectedTopology || !ids.has(selectedTopology.topology_id)) {
        setSelectedTopology(cached.data[0]);
      }
      if (focusedTopologyId && !ids.has(focusedTopologyId)) {
        setFocusedTopologyId(null);
      }
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/topologies?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        return;
      }
      topologyListCacheRef.current.set(cacheKey, { ts: Date.now(), data });
      const ids = new Set(data.map((item) => item.topology_id));
      setTopologies(data);
      if (data.length === 0) {
        setSelectedTopology(null);
        setFocusedTopologyId(null);
      } else if (!selectedTopology || !ids.has(selectedTopology.topology_id)) {
        setSelectedTopology(data[0]);
      }
      if (focusedTopologyId && !ids.has(focusedTopologyId)) {
        setFocusedTopologyId(null);
      }
    } catch {
      setMessage("Failed.");
    }
  }

  async function fetchBatches() {
    const params = new URLSearchParams();
    if (statusFilter) {
      params.set("status", statusFilter);
    }
    if (nodeFilter) {
      params.set("nodes", nodeFilter);
    }
    const cacheKey = params.toString();
    const cached = batchListCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.ts < LIST_CACHE_TTL_MS) {
      setBatches(cached.data);
      if (focusedBatchId && !cached.data.some((item) => item.batch_id === focusedBatchId)) {
        setFocusedBatchId(null);
      }
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/batches?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        return;
      }
      batchListCacheRef.current.set(cacheKey, { ts: Date.now(), data });
      setBatches(data);
      if (focusedBatchId && !data.some((item) => item.batch_id === focusedBatchId)) {
        setFocusedBatchId(null);
      }
    } catch {
      setMessage("Failed.");
    }
  }

  async function fetchSidebarBatches() {
    try {
      const response = await fetch(`${API_BASE}/batches`);
      const data = await response.json();
      if (!response.ok) {
        return;
      }
      setSidebarBatches(data);
    } catch {
      // Keep silent. Sidebar can still render old data.
    }
  }

  async function fetchAlgorithms() {
    try {
      const response = await fetch(`${API_BASE}/algorithms`);
      const data = await response.json();
      if (!response.ok || !Array.isArray(data)) return;
      setAlgorithmOptions(data);
      const hasCurrent = data.some((item) => item.algorithm_id === runTopoForm.algorithm_id);
      const defaultAlgorithm = hasCurrent ? data.find((item) => item.algorithm_id === runTopoForm.algorithm_id) : data[0];
      if (defaultAlgorithm && !hasCurrent) {
        setRunTopoForm((prev) => ({ ...prev, algorithm_id: defaultAlgorithm.algorithm_id }));
      }
    } catch {
      // Keep silent; fallback to local default algorithm id.
    }
  }

  async function fetchBatchRunResults() {
    setIsLoadingBatchRunResults(true);
    setBatchRunResultsError(null);
    try {
      const response = await fetch(`${API_BASE}/runs/batch/results`);
      const data = await response.json();
      if (!response.ok) {
        setBatchRunResults([]);
        setBatchRunResultsError(parseApiError(data, "Could not load batch results."));
        return;
      }
      if (!Array.isArray(data)) {
        setBatchRunResults([]);
        setBatchRunResultsError("Invalid response.");
        return;
      }
      setBatchRunResults(data);
    } catch {
      setBatchRunResults([]);
      setBatchRunResultsError("Network error while loading batch results.");
    } finally {
      setIsLoadingBatchRunResults(false);
    }
  }

  async function fetchQueueSnapshot() {
    try {
      const response = await fetch(`${API_BASE}/runs/queue`);
      const data = await response.json();
      if (!response.ok || !data || !Array.isArray(data.lanes)) {
        setQueueSnapshot({ total_queued: 0, total_running: 0, lane_count: 0, lanes: [] });
        return;
      }
      setQueueSnapshot(data);
    } catch {
      setQueueSnapshot({ total_queued: 0, total_running: 0, lane_count: 0, lanes: [] });
    }
  }

  async function fetchManagedWorkers() {
    try {
      const response = await fetch(`${API_BASE}/workers`);
      const data = await response.json();
      if (!response.ok || !Array.isArray(data)) {
        setManagedWorkers([]);
        return;
      }
      setManagedWorkers(data);
    } catch {
      setManagedWorkers([]);
    }
  }

  async function handleSpawnWorker() {
    setIsSpawningWorker(true);
    try {
      const response = await fetch(`${API_BASE}/workers`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Failed to start worker."));
        return;
      }
      setMessage(`Worker started (${data?.worker_id ?? "ok"}).`);
      await Promise.all([fetchManagedWorkers(), fetchQueueSnapshot()]);
    } catch {
      setMessage("Failed to start worker.");
    } finally {
      setIsSpawningWorker(false);
    }
  }

  async function handleKillWorker(workerId) {
    if (!workerId) return;
    const confirmed = window.confirm(`Kill worker ${workerId}? Running jobs will return to the queue.`);
    if (!confirmed) return;
    setKillingWorkerId(workerId);
    try {
      const response = await fetch(`${API_BASE}/workers/${encodeURIComponent(workerId)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Failed to kill worker."));
        return;
      }
      setMessage(data?.message || "Worker stopped.");
      await Promise.all([fetchManagedWorkers(), fetchQueueSnapshot()]);
    } catch {
      setMessage("Failed to kill worker.");
    } finally {
      setKillingWorkerId("");
    }
  }

  async function fetchSingleRunTopologyIds() {
    try {
      const response = await fetch(`${API_BASE}/runs/history/single/topology-ids`);
      const data = await response.json();
      if (!response.ok || !Array.isArray(data)) {
        setSingleRunTopologyIds([]);
        return;
      }
      setSingleRunTopologyIds(data);
    } catch {
      setSingleRunTopologyIds([]);
    }
  }

  async function fetchBatchRunResultDetail(batchRunId, options = {}) {
    const silent = options.silent === true;
    if (!batchRunId) {
      setFocusedBatchRunResult(null);
      setBatchRunResultDetailError(null);
      return;
    }
    if (!silent) {
      setIsLoadingBatchRunResult(true);
      setBatchRunResultDetailError(null);
    }
    try {
      const response = await fetch(`${API_BASE}/runs/batch/${batchRunId}/result`);
      const data = await response.json();
      if (!response.ok) {
        if (!silent) {
          setFocusedBatchRunResult(null);
          setBatchRunResultDetailError(parseApiError(data, "Could not load this batch result."));
        }
        return;
      }
      setFocusedBatchRunResult(data);
      if (!silent) {
        setBatchRunResultDetailError(null);
      }
    } catch (err) {
      if (!silent) {
        setFocusedBatchRunResult(null);
        const detail = err instanceof Error ? err.message : "";
        setBatchRunResultDetailError(
          detail ? `Network error while loading batch result (${detail}).` : "Network error while loading batch result."
        );
      }
    } finally {
      if (!silent) {
        setIsLoadingBatchRunResult(false);
      }
    }
  }

  useEffect(() => {
    try {
      LEGACY_PRESET_LOCAL_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchTopologies();
    fetchBatches();
    fetchSidebarBatches();
    fetchAlgorithms();
    void loadRunPresets();
    fetchBatchRunResults();
    fetchSingleRunTopologyIds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, nodeFilter]);

  useEffect(() => {
    if (activeMenu !== "results" && !workersExpanded) return;
    if (activeMenu === "results") fetchBatchRunResults();
    fetchQueueSnapshot();
    if (workersExpanded) fetchManagedWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMenu, workersExpanded]);

  useEffect(() => {
    if (activeMenu !== "compare") return;
    fetchBatchRunResults();
    fetchSingleRunTopologyIds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMenu]);

  useEffect(() => {
    if (activeMenu !== "results" && !workersExpanded) return undefined;
    let cancelled = false;
    async function poll() {
      try {
        const requests = [fetch(`${API_BASE}/runs/queue`)];
        if (workersExpanded) {
          requests.push(fetch(`${API_BASE}/workers`));
        }
        if (activeMenu === "results") {
          requests.unshift(fetch(`${API_BASE}/runs/batch/results`));
        }
        const responses = await Promise.all(requests);
        if (cancelled) return;
        let batchResp = null;
        let queueResp = null;
        let workersResp = null;
        if (activeMenu === "results" && workersExpanded) {
          [batchResp, queueResp, workersResp] = responses;
        } else if (activeMenu === "results") {
          [batchResp, queueResp] = responses;
        } else if (workersExpanded) {
          [queueResp, workersResp] = responses;
        } else {
          [queueResp] = responses;
        }
        if (batchResp) {
          const batchData = await batchResp.json();
          if (batchResp.ok && Array.isArray(batchData)) {
            setBatchRunResults(batchData);
            setBatchRunResultsError(null);
          }
        }
        if (queueResp) {
          const queueData = await queueResp.json();
          if (queueResp.ok && queueData && Array.isArray(queueData.lanes)) {
            setQueueSnapshot(queueData);
          }
        }
        if (workersResp) {
          const workersData = await workersResp.json();
          if (workersResp.ok && Array.isArray(workersData)) {
            setManagedWorkers(workersData);
          }
        }
      } catch {
        // ignore transient polling failures
      }
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeMenu, workersExpanded]);

  useEffect(() => {
    batchDetailRefreshKeyRef.current = "";
    if (!focusedBatchRunId) {
      setFocusedBatchRunResult(null);
      setBatchRunResultDetailError(null);
      return;
    }
    setFocusedBatchRunResult(null);
    setBatchRunResultDetailError(null);
    fetchBatchRunResultDetail(focusedBatchRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedBatchRunId]);

  useEffect(() => {
    if (!focusedBatchRunId) {
      setBatchRunProgress(null);
      return undefined;
    }
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch(`${API_BASE}/runs/batch/${focusedBatchRunId}/progress`);
        const data = await response.json();
        if (!cancelled && response.ok) {
          setBatchRunProgress(data);
        }
      } catch {
        // ignore transient errors while polling
      }
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [focusedBatchRunId]);

  useEffect(() => {
    if (!batchRunProgress || !focusedBatchRunId) return;
    const st = batchRunProgress.batch_status;
    const terminal = st === "completed" || st === "failed" || st === "stopped";
    if (!terminal) return;
    if (pendingNavigateFromRunMultiBatchIdRef.current === focusedBatchRunId) {
      pendingNavigateFromRunMultiBatchIdRef.current = null;
    }
    const key = `${focusedBatchRunId}-${st}-${batchRunProgress.done}-${batchRunProgress.failed}-${batchRunProgress.stopped}`;
    if (batchDetailRefreshKeyRef.current === key) return;
    batchDetailRefreshKeyRef.current = key;
    fetchBatchRunResultDetail(focusedBatchRunId, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    focusedBatchRunId,
    batchRunProgress?.batch_status,
    batchRunProgress?.done,
    batchRunProgress?.failed,
    batchRunProgress?.stopped
  ]);

  useEffect(() => {
    if (activeMenu !== "run_multi") return undefined;
    const id = pendingNavigateFromRunMultiBatchIdRef.current;
    if (!id) return undefined;
    let cancelled = false;
    async function tick() {
      try {
        const response = await fetch(`${API_BASE}/runs/batch/${id}/progress`);
        const data = await response.json();
        if (cancelled || !response.ok) return;
        const st = data.batch_status;
        if (st === "completed" || st === "failed" || st === "stopped") {
          pendingNavigateFromRunMultiBatchIdRef.current = null;
          setActiveMenu("results");
          setActivePanel2Tab("results");
          setFocusedBatchRunId(id);
          fetchBatchRunResults();
        }
      } catch {
        // ignore
      }
    }
    tick();
    const interval = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMenu]);

  const selectedAlgorithmMeta = useMemo(
    () => algorithmOptions.find((item) => item.algorithm_id === runTopoForm.algorithm_id) ?? null,
    [algorithmOptions, runTopoForm.algorithm_id]
  );

  useEffect(() => {
    if (!algorithmOptions.length) return;
    setRunMultiForm((prev) => {
      const hasCurrent = algorithmOptions.some((item) => item.algorithm_id === prev.algorithm_id);
      const nextAlgorithmId = hasCurrent ? prev.algorithm_id : algorithmOptions[0].algorithm_id;
      if (nextAlgorithmId === prev.algorithm_id) return prev;
      return { ...prev, algorithm_id: nextAlgorithmId };
    });
  }, [algorithmOptions]);

  useEffect(() => {
    if (activeMenu === "topologies") {
      setActivePanel2Tab("detail");
    } else if (activeMenu === "run_topo") {
      setActivePanel2Tab("run");
    } else if (activeMenu === "run_multi") {
      setActivePanel2Tab("run");
    } else if (activeMenu === "results") {
      setActivePanel2Tab("results");
    }
  }, [activeMenu]);

  useEffect(() => {
    resetPlaygroundState();
  }, [selectedTopology?.topology_id]);

  useEffect(() => {
    setPlaygroundTreeMode("manual");
    setRunDerivedTree(null);
    setRunDerivedTreeLoadError(null);
    setRunDerivedTreeMessage(null);
    setRunDerivedTreeSourceArtifact(null);
    setPlaygroundRunSourceId(null);
  }, [selectedTopology?.topology_id, focusedTopologyId]);

  useEffect(() => {
    const doneRuns = (runHistoryItems ?? []).filter((item) => item.status === "done");
    setPlaygroundRunSourceId((prev) => {
      if (prev && doneRuns.some((item) => item.run_id === prev)) {
        return prev;
      }
      return doneRuns[0]?.run_id ?? null;
    });
  }, [runHistoryItems]);

  useEffect(() => {
    const topologyId = selectedTopology?.topology_id ?? focusedTopologyId;
    if (activeMenu !== "topologies" || activePanel2Tab !== "playground" || !topologyId) {
      return;
    }
    fetchPlaygroundTree(topologyId);
  }, [selectedTopology?.topology_id, focusedTopologyId, activeMenu, activePanel2Tab]);

  useEffect(() => {
    const topologyId = selectedTopology?.topology_id ?? focusedTopologyId;
    if (
      activeMenu !== "topologies" ||
      activePanel2Tab !== "playground" ||
      playgroundTreeMode !== "run" ||
      !topologyId ||
      !playgroundRunSourceId
    ) {
      return;
    }
    fetchRunDerivedPlaygroundTree(topologyId, playgroundRunSourceId);
  }, [
    selectedTopology?.topology_id,
    focusedTopologyId,
    activeMenu,
    activePanel2Tab,
    playgroundTreeMode,
    playgroundRunSourceId,
  ]);

  useEffect(() => {
    if (activeMenu !== "topologies" || activePanel2Tab !== "playground") {
      setPlaygroundState((prev) =>
        prev.timeslots.length > 0 ||
        prev.currentSlot !== 0 ||
        prev.viewSlot !== 0 ||
        prev.coveredNodeIds.length !== 1 ||
        prev.coveredNodeIds[0] !== 0 ||
        prev.hoverPreview !== null ||
        prev.isComplete ||
        prev.mode !== "broadcaster"
          ? INITIAL_PLAYGROUND_STATE
          : prev
      );
    }
  }, [activeMenu, activePanel2Tab]);

  useEffect(() => {
    if (!selectedTopology) {
      setTopologyNodes([]);
      setTopologyDetail(null);
      setRunHistoryItems([]);
      setRunSummaryPayload(null);
      setTransmissionLastPayload(null);
      setTransmissionBestPayload(null);
      setStateActionLastPayload(null);
      setStateActionBestPayload(null);
      setQTablePayload(null);
      setDelayPerEpisodePayload(null);
      setPolicyTracePayload(null);
      setPathSignaturesPayload(null);
      setResolvedRunConfigPayload(null);
      setStateActionAllPayload(null);
      setTransmissionAllPayload(null);
      setQTableAllEpochsPayload(null);
      setSelectedEpisode("");
      setSelectedRunId(null);
      return;
    }
    fetchTopologyNodes(selectedTopology.topology_id);
    fetchTopologyDetail(selectedTopology.topology_id);
    fetchRunHistory(selectedTopology.topology_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTopology?.topology_id]);

  const latestCompletedRun = useMemo(() => {
    const completedRuns = runHistoryItems.filter((item) => item.status === "done");
    if (completedRuns.length === 0) return null;
    if (selectedRunId) {
      return completedRuns.find((item) => item.run_id === selectedRunId) ?? completedRuns[0];
    }
    const singleRun = completedRuns.find((item) => item.mode === "single");
    return singleRun ?? completedRuns[0] ?? null;
  }, [runHistoryItems, selectedRunId]);

  const latestRunAlgorithmMeta = useMemo(
    () => algorithmOptions.find((item) => item.algorithm_id === latestCompletedRun?.algorithm_id) ?? null,
    [algorithmOptions, latestCompletedRun?.algorithm_id]
  );

  useEffect(() => {
    if (!latestCompletedRun) {
      setRunSummaryPayload(null);
      setTransmissionLastPayload(null);
      setTransmissionBestPayload(null);
      setStateActionLastPayload(null);
      setStateActionBestPayload(null);
      setQTablePayload(null);
      setDelayPerEpisodePayload(null);
      setPolicyTracePayload(null);
      setPathSignaturesPayload(null);
      setResolvedRunConfigPayload(null);
      setStateActionAllPayload(null);
      setTransmissionAllPayload(null);
      setQTableAllEpochsPayload(null);
      setSelectedEpisode("");
      return;
    }
    setSelectedEpisode("");
    fetchRunArtifacts(latestCompletedRun.run_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestCompletedRun?.run_id]);

  useEffect(() => {
    setReplaySlot(0);
  }, [resultsEpochMode, selectedEpisode, selectedTopology?.topology_id]);

  useEffect(() => {
    if (topologies.length === 0) return;
    topologies.slice(0, GRID_PREVIEW_FETCH_LIMIT).forEach((topo) => {
      if (topo.node_count < LARGE_TOPO_THRESHOLD && !graphByTopologyId[topo.topology_id]) {
        fetchTopologyGraph(topo.topology_id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologies]);

  useEffect(() => {
    if (!focusedTopologyId) return;
    const focusedTopo =
      (selectedTopology?.topology_id === focusedTopologyId ? selectedTopology : null) ??
      topologies.find((item) => item.topology_id === focusedTopologyId);
    const shouldRenderHeavy =
      focusedTopo && focusedTopo.node_count >= LARGE_TOPO_THRESHOLD
        ? heavyRenderApprovedIds.includes(focusedTopologyId)
        : true;
    if (shouldRenderHeavy && !graphByTopologyId[focusedTopologyId]) {
      fetchTopologyGraph(focusedTopologyId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedTopologyId, topologies, heavyRenderApprovedIds]);

  const mainTitle = useMemo(() => {
    if (activeMenu === "home") return "Overview";
    if (activeMenu === "topologies") return "Batches and Topologies";
    if (activeMenu === "generate") return "Generate Topology";
    if (activeMenu === "run_topo") return "Run Topology";
    if (activeMenu === "results") return "Results";
    if (activeMenu === "run_multi") return "Run Multi-topologies";
    if (activeMenu === "compare") return "Compare A/B";
    return "Topologies";
  }, [activeMenu]);

  function goHome() {
    setActiveMenu("home");
    setFocusedBatchId(null);
    setFocusedTopologyId(null);
  }

  async function handleGenerate(event) {
    event.preventDefault();
    setIsGenerating(true);
    setMessage("");
    if (selectedBatch?.is_locked) {
      setMessage("Selected batch is locked.");
      setIsGenerating(false);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/topologies/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...generateForm,
          seed: generateForm.use_seed ? Number(generateForm.seed) : null,
          batch_id: selectedBatchId || null
        })
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Generate topology failed."));
        return;
      }
      setMessage(`Success. Created ${data.topology_name}`);
      clearListCaches();
      await fetchTopologies();
      await fetchBatches();
      await fetchSidebarBatches();
    } catch {
      setMessage("Generate topology failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleGenerateMulti(event) {
    event.preventDefault();
    if (!multiGenerateForm.node_counts.length) {
      setMessage("Select at least one node count.");
      return;
    }
    setIsGenerating(true);
    setMessage("");
    if (selectedBatch?.is_locked) {
      setMessage("Selected batch is locked.");
      setIsGenerating(false);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/topologies/generate/multi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_counts: multiGenerateForm.node_counts,
          count_per_node_count: Number(multiGenerateForm.count_per_node_count),
          space_width: Number(multiGenerateForm.space_width),
          space_height: Number(multiGenerateForm.space_height),
          tx_range: Number(multiGenerateForm.tx_range),
          sink_mode: multiGenerateForm.sink_mode,
          sink_x: Number(multiGenerateForm.sink_x),
          sink_y: Number(multiGenerateForm.sink_y),
          seed: null,
          max_retry: Number(multiGenerateForm.max_retry),
          batch_id: selectedBatchId || null
        })
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Generate failed."));
        return;
      }
      setMessage(`Success. Created ${data.created_count} topologies`);
      clearListCaches();
      await fetchTopologies();
      await fetchBatches();
      await fetchSidebarBatches();
    } catch {
      setMessage("Generate failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function fetchTopologyNodes(topologyId) {
    setIsLoadingNodes(true);
    try {
      const response = await fetch(`${API_BASE}/topologies/${topologyId}/nodes`);
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        setTopologyNodes([]);
        return;
      }
      setTopologyNodes(data);
    } catch {
      setMessage("Failed.");
      setTopologyNodes([]);
    } finally {
      setIsLoadingNodes(false);
    }
  }

  async function fetchTopologyDetail(topologyId) {
    setIsLoadingDetail(true);
    try {
      const response = await fetch(`${API_BASE}/topologies/${topologyId}/detail`);
      const data = await response.json();
      if (!response.ok) {
        setTopologyDetail(null);
        setMessage(data?.message || "Failed.");
        return;
      }
      setTopologyDetail(data);
    } catch {
      setTopologyDetail(null);
      setMessage("Failed.");
    } finally {
      setIsLoadingDetail(false);
    }
  }

  async function fetchRunHistory(topologyId) {
    try {
      const response = await fetch(`${API_BASE}/runs/history?topology_id=${topologyId}`);
      const data = await response.json();
      if (!response.ok) {
        setRunHistoryItems([]);
        setSelectedRunId(null);
        return;
      }
      setRunHistoryItems(data);
      const doneRuns = data.filter((item) => item.status === "done");
      const doneSingleRuns = doneRuns.filter((item) => item.mode === "single");
      setSelectedRunId((prevRunId) => {
        if (prevRunId && doneRuns.some((item) => item.run_id === prevRunId)) {
          return prevRunId;
        }
        return doneSingleRuns[0]?.run_id ?? doneRuns[0]?.run_id ?? null;
      });
    } catch {
      setRunHistoryItems([]);
      setSelectedRunId(null);
    }
  }

  async function fetchRunArtifact(runId, artifactType) {
    const response = await fetch(`${API_BASE}/runs/${runId}/artifacts/${artifactType}`);
    const data = await response.json();
    if (!response.ok) {
      return null;
    }
    return data.payload ?? null;
  }

  async function fetchRunArtifacts(runId) {
    try {
      const [runBundle, traceEpochs, resolvedRunConfig] = await Promise.all([
        fetchRunArtifact(runId, "run_bundle"),
        fetchRunArtifact(runId, "trace_epochs"),
        fetchRunArtifact(runId, "resolved_run_config")
      ]);
      let hydrated = hydrateLegacyRunArtifactState({
        runBundle,
        traceEpochs,
        qTable: null,
        resolvedRunConfig
      });
      setRunSummaryPayload(hydrated.runSummaryPayload);
      setTransmissionLastPayload(hydrated.transmissionLastPayload);
      setTransmissionBestPayload(hydrated.transmissionBestPayload);
      setStateActionLastPayload(hydrated.stateActionLastPayload);
      setStateActionBestPayload(hydrated.stateActionBestPayload);
      setDelayPerEpisodePayload(hydrated.delayPerEpisodePayload);
      setPolicyTracePayload(hydrated.policyTracePayload);
      setPathSignaturesPayload(hydrated.pathSignaturesPayload);
      setResolvedRunConfigPayload(hydrated.resolvedRunConfigPayload);
      setStateActionAllPayload(hydrated.stateActionAllPayload);
      setTransmissionAllPayload(hydrated.transmissionAllPayload);
      setQTableAllEpochsPayload(hydrated.qTableAllEpochsPayload);
      setQTablePayload(null);
      fetchRunArtifact(runId, "q_table").then((qTable) => {
        if (qTable) setQTablePayload(qTable);
      });
      if (!runBundle) {
        const [
          legacySummary,
          transmissionLast,
          transmissionBest,
          stateActionLast,
          stateActionBest,
          delayPerEpisode,
          pathSignatures
        ] = await Promise.all([
          fetchRunArtifact(runId, "run_summary"),
          fetchRunArtifact(runId, "transmission_last_epoch"),
          fetchRunArtifact(runId, "transmission_best_epoch"),
          fetchRunArtifact(runId, "state_action_last_epoch"),
          fetchRunArtifact(runId, "state_action_best_epoch"),
          fetchRunArtifact(runId, "delay_per_episode"),
          fetchRunArtifact(runId, "path_signatures")
        ]);
        hydrated = {
          ...hydrated,
          runSummaryPayload: legacySummary ?? hydrated.runSummaryPayload,
          transmissionLastPayload: transmissionLast ?? hydrated.transmissionLastPayload,
          transmissionBestPayload: transmissionBest ?? hydrated.transmissionBestPayload,
          stateActionLastPayload: stateActionLast ?? hydrated.stateActionLastPayload,
          stateActionBestPayload: stateActionBest ?? hydrated.stateActionBestPayload,
          delayPerEpisodePayload: delayPerEpisode ?? hydrated.delayPerEpisodePayload,
          pathSignaturesPayload: pathSignatures ?? hydrated.pathSignaturesPayload,
        };
        const policyComputed = buildPolicyTraceFromConfig(resolvedRunConfig, legacySummary ?? hydrated.runSummaryPayload);
        if (policyComputed) {
          hydrated.policyTracePayload = { text: policyComputed.csvText };
        }
        setRunSummaryPayload(hydrated.runSummaryPayload);
        setTransmissionLastPayload(hydrated.transmissionLastPayload);
        setTransmissionBestPayload(hydrated.transmissionBestPayload);
        setStateActionLastPayload(hydrated.stateActionLastPayload);
        setStateActionBestPayload(hydrated.stateActionBestPayload);
        setDelayPerEpisodePayload(hydrated.delayPerEpisodePayload);
        setPolicyTracePayload(hydrated.policyTracePayload);
        setPathSignaturesPayload(hydrated.pathSignaturesPayload);
        fetchRunArtifact(runId, "q_table").then((qTable) => {
          if (qTable) setQTablePayload(qTable);
        });
      }
    } catch {
      setRunSummaryPayload(null);
      setTransmissionLastPayload(null);
      setTransmissionBestPayload(null);
      setStateActionLastPayload(null);
      setStateActionBestPayload(null);
      setQTablePayload(null);
      setDelayPerEpisodePayload(null);
      setPolicyTracePayload(null);
      setPathSignaturesPayload(null);
      setResolvedRunConfigPayload(null);
      setStateActionAllPayload(null);
      setTransmissionAllPayload(null);
      setQTableAllEpochsPayload(null);
    }
  }

  async function fetchTopologyGraph(topologyId) {
    if (graphByTopologyId[topologyId]) return;
    const cached = graphCacheRef.current.get(topologyId);
    if (cached) {
      setGraphByTopologyId((prev) => ({
        ...prev,
        [topologyId]: cached
      }));
      return;
    }
    const inFlight = graphInFlightRef.current.get(topologyId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const request = (async () => {
      try {
        const response = await fetch(`${API_BASE}/topologies/${topologyId}/graph`);
        const data = await response.json();
        if (!response.ok) {
          return;
        }
        graphCacheRef.current.set(topologyId, data);
        setGraphByTopologyId((prev) => ({
          ...prev,
          [topologyId]: data
        }));
      } catch {
        // Keep silent for card preview fetch failures.
      } finally {
        graphInFlightRef.current.delete(topologyId);
      }
    })();
    graphInFlightRef.current.set(topologyId, request);
    await request;
  }

  function setPlaygroundMode(mode) {
    setPlaygroundState((prev) => ({
      ...prev,
      mode,
      hoverPreview: null
    }));
  }

  function setPlaygroundViewSlot(slot) {
    setPlaygroundState((prev) => ({
      ...prev,
      viewSlot: Math.max(0, Math.min(Number(slot) || 0, prev.timeslots.length)),
      hoverPreview: null
    }));
  }

  function setPlaygroundHoverNode(nodeId) {
    const topologyId = selectedTopology?.topology_id;
    if (!topologyId) return;
    const graph = graphByTopologyId[topologyId] ?? graphByTopologyId[focusedTopologyId];
    if (!graph) return;
    setPlaygroundState((prev) => {
      const latestSlot = prev.timeslots.length;
      if (prev.isComplete || prev.viewSlot !== latestSlot) {
        if (prev.hoverPreview === null) return prev;
        return { ...prev, hoverPreview: null };
      }
      const preview = simulatePlaygroundSlot(graph, prev.coveredNodeIds, prev.mode, nodeId);
      if (!preview) {
        if (prev.hoverPreview === null) return prev;
        return { ...prev, hoverPreview: null };
      }
      return {
        ...prev,
        hoverPreview: {
          nodeId,
          ...preview
        }
      };
    });
  }

  function clearPlaygroundHoverPreview() {
    setPlaygroundState((prev) => (prev.hoverPreview === null ? prev : { ...prev, hoverPreview: null }));
  }

  function commitPlaygroundNode(nodeId) {
    const topologyId = selectedTopology?.topology_id;
    if (!topologyId) return;
    const graph = graphByTopologyId[topologyId] ?? graphByTopologyId[focusedTopologyId];
    if (!graph) return;
    setPlaygroundState((prev) => {
      const latestSlot = prev.timeslots.length;
      if (prev.isComplete || prev.viewSlot !== latestSlot) return prev;
      const nextSlot = simulatePlaygroundSlot(graph, prev.coveredNodeIds, prev.mode, nodeId);
      if (!nextSlot) return prev;
      const fromHash = playgroundStateHash(prev.coveredNodeIds);
      const nextCovered = Array.from(new Set([...prev.coveredNodeIds, ...nextSlot.receivers])).sort((a, b) => a - b);
      const toHash = playgroundStateHash(nextCovered);
      void appendPlaygroundTreeTransition(topologyId, {
        from_state_hash: fromHash,
        to_state_hash: toHash,
        action: Number(nodeId),
        mode: prev.mode,
        to_covered_node_ids: nextCovered
      });
      const totalNodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
      const timeslot = prev.timeslots.length + 1;
      return {
        ...prev,
        timeslots: [
          ...prev.timeslots,
          {
            timeslot,
            transmitters: nextSlot.transmitters,
            receivers: nextSlot.receivers,
            firstPick: nextSlot.firstPick,
            mode: prev.mode
          }
        ],
        currentSlot: timeslot,
        viewSlot: timeslot,
        coveredNodeIds: nextCovered,
        hoverPreview: null,
        isComplete: totalNodes > 0 && nextCovered.length >= totalNodes
      };
    });
  }

  function updateTemperatureActionCount(nextCount) {
    setTemperatureTool((prev) => {
      const target = Math.max(1, Math.min(10, Number(nextCount) || 1));
      return {
        ...prev,
        actionCount: target,
        qValues: resizeQValues(prev.qValues, target, 0).map((value) => clampValue(value, prev.qMin, prev.qMax))
      };
    });
  }

  function updateTemperatureTauRange(minValue, maxValue, preferredTau = null) {
    setTemperatureTool((prev) => {
      const range = normalizeRange(minValue, maxValue, { min: prev.tauMin, max: prev.tauMax }, 0.001);
      const tau = clampValue(preferredTau ?? prev.tau, range.min, range.max);
      return { ...prev, tauMin: range.min, tauMax: range.max, tau };
    });
  }

  function updateTemperatureQRange(minValue, maxValue) {
    setTemperatureTool((prev) => {
      const range = normalizeRange(minValue, maxValue, { min: prev.qMin, max: prev.qMax }, 0.001);
      return {
        ...prev,
        qMin: range.min,
        qMax: range.max,
        qValues: prev.qValues.map((value) => clampValue(value, range.min, range.max))
      };
    });
  }

  function updateTemperatureTau(value) {
    setTemperatureTool((prev) => ({
      ...prev,
      tau: clampValue(value, prev.tauMin, prev.tauMax)
    }));
  }

  function updateTemperatureQValue(index, value) {
    setTemperatureTool((prev) => ({
      ...prev,
      qValues: prev.qValues.map((item, itemIndex) =>
        itemIndex === index ? clampValue(value, prev.qMin, prev.qMax) : item
      )
    }));
  }

  function updateTemperatureFontScale(value) {
    setTemperatureTool((prev) => ({
      ...prev,
      fontScale: clampValue(value, 0.8, 1.8)
    }));
  }

  function updateUcbActionCount(nextCount) {
    setUcbTool((prev) => {
      const target = Math.max(1, Math.min(10, Number(nextCount) || 1));
      return {
        ...prev,
        actionCount: target,
        qValues: resizeQValues(prev.qValues, target, 0).map((value) => clampValue(value, prev.qMin, prev.qMax)),
        visitCounts: resizeVisitCounts(prev.visitCounts, target, 0)
      };
    });
  }

  function updateUcbGlobalTRange(minValue, maxValue, preferredT = null) {
    setUcbTool((prev) => {
      const range = normalizeRange(minValue, maxValue, { min: prev.globalTMin, max: prev.globalTMax }, 1);
      const globalT = clampValue(preferredT ?? prev.globalT, range.min, range.max);
      return { ...prev, globalTMin: range.min, globalTMax: range.max, globalT: Math.round(globalT) };
    });
  }

  function updateUcbGlobalT(value) {
    setUcbTool((prev) => ({
      ...prev,
      globalT: Math.round(clampValue(value, prev.globalTMin, prev.globalTMax))
    }));
  }

  function updateUcbCRange(minValue, maxValue, preferredC = null) {
    setUcbTool((prev) => {
      const range = normalizeRange(minValue, maxValue, { min: prev.ucbCMin, max: prev.ucbCMax }, 0.001);
      const ucbC = clampValue(preferredC ?? prev.ucbC, range.min, range.max);
      return { ...prev, ucbCMin: range.min, ucbCMax: range.max, ucbC };
    });
  }

  function updateUcbC(value) {
    setUcbTool((prev) => ({
      ...prev,
      ucbC: clampValue(value, prev.ucbCMin, prev.ucbCMax)
    }));
  }

  function updateUcbQRange(minValue, maxValue) {
    setUcbTool((prev) => {
      const range = normalizeRange(minValue, maxValue, { min: prev.qMin, max: prev.qMax }, 0.001);
      return {
        ...prev,
        qMin: range.min,
        qMax: range.max,
        qValues: prev.qValues.map((value) => clampValue(value, range.min, range.max))
      };
    });
  }

  function updateUcbQValue(index, value) {
    setUcbTool((prev) => ({
      ...prev,
      qValues: prev.qValues.map((item, itemIndex) =>
        itemIndex === index ? clampValue(value, prev.qMin, prev.qMax) : item
      )
    }));
  }

  function updateUcbVisitCount(index, value) {
    setUcbTool((prev) => ({
      ...prev,
      visitCounts: prev.visitCounts.map((item, itemIndex) =>
        itemIndex === index
          ? Math.max(0, Math.min(prev.visitMax, Math.trunc(Number(value) || 0)))
          : item
      )
    }));
  }

  function updateUcbFontScale(value) {
    setUcbTool((prev) => ({
      ...prev,
      fontScale: clampValue(value, 0.8, 1.8)
    }));
  }

  async function patchNodeCoordinate(nodeId, x, y) {
    if (!selectedTopology) return false;
    try {
      const response = await fetch(`${API_BASE}/topologies/${selectedTopology.topology_id}/nodes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: nodeId,
          x,
          y,
          min_bound: 0,
          max_bound_x: topologyDetail?.space_width ?? 100,
          max_bound_y: topologyDetail?.space_height ?? 100
        })
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        return false;
      }
      setTopologyNodes((prev) =>
        prev.map((node) =>
          node.node_id === nodeId
            ? { ...node, x: data.x, y: data.y }
            : node
        )
      );
      return true;
    } catch {
      setMessage("Failed.");
      return false;
    }
  }

  async function handleNodeBlur(nodeId, key, value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      setMessage("Failed.");
      return;
    }
    const current = topologyNodes.find((item) => item.node_id === nodeId);
    if (!current) return;
    const nextX = key === "x" ? parsed : current.x;
    const nextY = key === "y" ? parsed : current.y;
    const patchTask = patchNodeCoordinate(nodeId, nextX, nextY);
    pendingNodePatchPromisesRef.current.add(patchTask);
    try {
      await patchTask;
    } finally {
      pendingNodePatchPromisesRef.current.delete(patchTask);
    }
  }

  async function handleNodeKeyDown(event, nodeId, key) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    await handleNodeBlur(nodeId, key, event.currentTarget.value);
  }

  async function saveTopology() {
    if (!selectedTopology) return;
    setIsSavingTopology(true);
    try {
      const pending = Array.from(pendingNodePatchPromisesRef.current);
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
      const response = await fetch(`${API_BASE}/topologies/${selectedTopology.topology_id}/save`, {
        method: "POST"
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        return;
      }
      setMessage("Success.");
      clearListCaches();
      await fetchTopologies();
      await fetchBatches();
      await fetchSidebarBatches();
      await fetchTopologyNodes(selectedTopology.topology_id);
      await fetchTopologyDetail(selectedTopology.topology_id);
      graphCacheRef.current.delete(selectedTopology.topology_id);
      graphInFlightRef.current.delete(selectedTopology.topology_id);
      setGraphByTopologyId((prev) => {
        const next = { ...prev };
        delete next[selectedTopology.topology_id];
        return next;
      });
      await fetchTopologyGraph(selectedTopology.topology_id);
    } catch {
      setMessage("Failed.");
    } finally {
      setIsSavingTopology(false);
    }
  }

  function updateGenerateField(field, value) {
    setGenerateForm((prev) => ({
      ...prev,
      [field]: value
    }));
  }

  function updateMultiGenerateField(field, value) {
    setMultiGenerateForm((prev) => ({
      ...prev,
      [field]: value
    }));
  }

  function toggleMultiNodeCount(nodeCount) {
    setMultiGenerateForm((prev) => {
      const exists = prev.node_counts.includes(nodeCount);
      return {
        ...prev,
        node_counts: exists
          ? prev.node_counts.filter((item) => item !== nodeCount)
          : [...prev.node_counts, nodeCount].sort((a, b) => a - b)
      };
    });
  }

  async function handleDeleteTopology(topo) {
    try {
      const response = await fetch(`${API_BASE}/topologies/${topo.topology_id}`, {
        method: "DELETE"
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        return;
      }
      setGraphByTopologyId((prev) => {
        const next = { ...prev };
        delete next[topo.topology_id];
        return next;
      });
      graphCacheRef.current.delete(topo.topology_id);
      graphInFlightRef.current.delete(topo.topology_id);
      if (selectedTopology?.topology_id === topo.topology_id) {
        setSelectedTopology(null);
      }
      if (focusedTopologyId === topo.topology_id) {
        setFocusedTopologyId(null);
      }
      setMessage("Success.");
      clearListCaches();
      await fetchTopologies();
      await fetchBatches();
      await fetchSidebarBatches();
    } catch {
      setMessage("Failed.");
    }
  }

  function maybeApproveHeavyRender(topo) {
    if (topo.node_count <= LARGE_TOPO_THRESHOLD) return true;
    if (heavyRenderApprovedIds.includes(topo.topology_id)) return true;
    const ok = window.confirm(LARGE_TOPO_CONFIRM_MESSAGE);
    if (!ok) return false;
    setHeavyRenderApprovedIds((prev) => [...prev, topo.topology_id]);
    return true;
  }

  function handleOpenTopology(topo) {
    const stayOnResults = activeMenu === "results";
    setSelectedTopology(topo);
    const ownerBatch = sidebarBatches.find((batch) =>
      batch.topologies.some((item) => item.topology_id === topo.topology_id)
    );
    if (ownerBatch) {
      setFocusedBatchId(ownerBatch.batch_id);
    }
    if (!maybeApproveHeavyRender(topo)) return;
    setFocusedTopologyId(topo.topology_id);
    if (stayOnResults) {
      setActiveMenu("results");
      setFocusedBatchRunId(null);
      setActivePanel2Tab("results");
      return;
    }
    setActiveMenu("topologies");
  }

  function handleRunTopoPick(topo) {
    if (!maybeApproveHeavyRender(topo)) return;
    setSelectedTopology(topo);
    setFocusedTopologyId(topo.topology_id);
  }

  function handleRepeatTopologyPick(topo) {
    if (!maybeApproveHeavyRender(topo)) return;
    setRepeatTopologyId(topo.topology_id);
    setSelectedTopology(topo);
    setFocusedTopologyId(topo.topology_id);
  }

  async function handleRunSingleTopology() {
    if (!selectedTopology) {
      setMessage("Select a topology first.");
      return;
    }
    setIsRunningSingle(true);
    setMessage("");
    try {
      const draftPresetId =
        runTopoWizard.phase !== "idle" && runTopoWizard.draftClientId ? runTopoWizard.draftClientId : null;
      const response = await fetch(`${API_BASE}/runs/single`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topology_id: selectedTopology.topology_id,
          algorithm_id: runTopoForm.algorithm_id,
          preset_id: runTopoForm.preset_id,
          preset_name: runTopoForm.preset_name || runTopoForm.preset_id,
          run_config: buildRunConfigPayload(runTopoConfigForm, runTopoForm),
          draft_preset_id: draftPresetId
        })
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      setLastSingleRun({
        run_id: data.run_id,
        topology_id: selectedTopology.topology_id,
        topology_name: selectedTopology.topology_name,
        algorithm_id: runTopoForm.algorithm_id,
        preset_id: runTopoForm.preset_id
      });
      setPendingSingleRunId(data.run_id);
      setMessage(`Run accepted: ${data.run_id}`);
      setFocusedTopologyId(selectedTopology.topology_id);
      setActiveMenu("results");
      setActivePanel2Tab("results");
      clearListCaches();
      await Promise.all([
        fetchTopologies(),
        fetchBatches(),
        fetchSidebarBatches(),
        fetchSingleRunTopologyIds(),
        fetchTopologyDetail(selectedTopology.topology_id),
        fetchRunHistory(selectedTopology.topology_id)
      ]);
      const ownerBatch = (sidebarBatches ?? []).find((batch) =>
        batch.topologies.some((item) => item.topology_id === selectedTopology.topology_id)
      );
      if (ownerBatch) {
        setFocusedBatchId(ownerBatch.batch_id);
      }
    } catch {
      setMessage("Failed.");
    } finally {
      setIsRunningSingle(false);
    }
  }

  useEffect(() => {
    if (!pendingSingleRunId || !lastSingleRun?.topology_id) return undefined;
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(`${API_BASE}/runs/${pendingSingleRunId}`);
        const data = await response.json();
        if (cancelled || !response.ok) return;
        if (data.status === "done") {
          setPendingSingleRunId(null);
          setSelectedRunId(pendingSingleRunId);
          setMessage(`Run completed: ${pendingSingleRunId}`);
          clearListCaches();
          await Promise.all([
            fetchTopologies(),
            fetchBatches(),
            fetchSidebarBatches(),
            fetchSingleRunTopologyIds(),
            fetchTopologyDetail(lastSingleRun.topology_id),
            fetchRunHistory(lastSingleRun.topology_id)
          ]);
          return;
        }
        if (data.status === "failed" || data.status === "stopped") {
          setPendingSingleRunId(null);
          setMessage("Failed.");
          clearListCaches();
          await Promise.all([
            fetchTopologies(),
            fetchBatches(),
            fetchSidebarBatches(),
            fetchSingleRunTopologyIds(),
            fetchTopologyDetail(lastSingleRun.topology_id),
            fetchRunHistory(lastSingleRun.topology_id)
          ]);
        }
      } catch {
        // ignore transient polling failures
      }
    }

    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSingleRunId, lastSingleRun?.topology_id]);

  function handleRunMultiTopologies() {
    const isRepeatMode = runMultiSubMode === "repeat";
    if (!runMultiForm.batch_id) {
      setMessage("Select a batch first.");
      return;
    }
    if (isRepeatMode) {
      if (!repeatTopologyId) {
        setMessage("Select one topology to repeat.");
        return;
      }
      const runCount = Math.max(1, Math.min(100, Math.trunc(Number(repeatRunCount) || 0)));
      if (runCount < 1) {
        setMessage("Run count must be at least 1.");
        return;
      }
    } else if (!runMultiForm.selected_topology_ids.length) {
      setMessage("Select at least one topology.");
      return;
    }
    const ownerBatch =
      sidebarBatches.find((item) => item.batch_id === runMultiForm.batch_id) ??
      batches.find((item) => item.batch_id === runMultiForm.batch_id) ??
      null;
    const presetName = runMultiForm.preset_name || runMultiForm.preset_id;
    setRunBatchDefaultLabel(buildDefaultBatchRunResultLabel(ownerBatch?.batch_name, presetName));
    setRunBatchNameDraft("");
    setRunBatchNameModalOpen(true);
  }

  async function submitRunMultiTopologies() {
    const isRepeatMode = runMultiSubMode === "repeat";
    const customLabel = runBatchNameDraft.trim();
    setIsRunningBatch(true);
    setMessage("");
    try {
      const selectedArtifactTypes = [
        ...(runMultiForm.artifact_flags?.path_signature ? ["path_signature"] : []),
        ...(runMultiForm.artifact_flags?.delay_per_episode ? ["delay_per_episode"] : [])
      ];
      const draftPresetId =
        runMultiWizard.phase !== "idle" && runMultiWizard.draftClientId ? runMultiWizard.draftClientId : null;
      const topologyIds = isRepeatMode
        ? Array.from(
            { length: Math.max(1, Math.min(100, Math.trunc(Number(repeatRunCount) || 0))) },
            () => repeatTopologyId
          )
        : runMultiForm.selected_topology_ids;
      const response = await fetch(`${API_BASE}/runs/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topology_ids: topologyIds,
          algorithm_id: runMultiForm.algorithm_id,
          preset_id: runMultiForm.preset_id,
          preset_name: runMultiForm.preset_name || runMultiForm.preset_id,
          result_label: customLabel || null,
          run_config: buildRunConfigPayload(runMultiConfigForm, runMultiForm),
          draft_preset_id: draftPresetId,
          save_full_artifacts_for_selected_runs: selectedArtifactTypes.length > 0,
          selected_artifact_topology_ids: [],
          selected_artifact_types: selectedArtifactTypes
        })
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      setRunBatchNameModalOpen(false);
      setMessage(`Batch run accepted: ${data.batch_run_id}`);
      pendingNavigateFromRunMultiBatchIdRef.current = data.batch_run_id;
      await fetchBatchRunResults();
      setFocusedBatchRunId(data.batch_run_id);
      setFocusedTopologyId(null);
      setSelectedTopology(null);
      setActiveMenu("results");
      setActivePanel2Tab("results");
    } catch {
      setMessage("Failed.");
    } finally {
      setIsRunningBatch(false);
    }
  }

  async function handleBatchStop() {
    if (!focusedBatchRunId) return;
    try {
      const response = await fetch(`${API_BASE}/runs/batch/${focusedBatchRunId}/stop`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Stop request failed."));
        return;
      }
      setMessage(data?.message || "Stop requested.");
    } catch {
      setMessage("Failed.");
    }
  }

  async function handleBatchResume() {
    if (!focusedBatchRunId) return;
    try {
      const response = await fetch(`${API_BASE}/runs/batch/${focusedBatchRunId}/resume`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Resume failed."));
        return;
      }
      setMessage(data?.message || "Resumed.");
    } catch {
      setMessage("Failed.");
    }
  }

  async function handleRenameBatchRunResult(batchRunId, resultLabel) {
    if (!batchRunId) return false;
    const payload =
      resultLabel === null || resultLabel === undefined
        ? { result_label: null }
        : { result_label: String(resultLabel).trim() || null };
    try {
      const response = await fetch(`${API_BASE}/runs/batch/${batchRunId}/result-label`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Failed."));
        return false;
      }
      setBatchRunResults((prev) =>
        (prev ?? []).map((item) => (item.batch_run_id === batchRunId ? { ...item, ...data } : item))
      );
      if (focusedBatchRunId === batchRunId) {
        setFocusedBatchRunResult((prev) =>
          prev ? { ...prev, result_label: data.result_label, custom_result_label: data.custom_result_label } : prev
        );
      }
      setMessage("Success.");
      return true;
    } catch {
      setMessage("Failed.");
      return false;
    }
  }

  async function handleDeleteBatchRunResult(batchRunId) {
    if (!batchRunId) return;
    try {
      const response = await fetch(`${API_BASE}/runs/batch/${batchRunId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      setMessage(data?.message || "Success.");
      if (focusedBatchRunId === batchRunId) {
        setFocusedBatchRunId(null);
        setFocusedBatchRunResult(null);
      }
      await fetchBatchRunResults();
    } catch {
      setMessage("Failed.");
    }
  }

  async function handleDeleteRun(runId) {
    if (!selectedTopology) return;
    const confirmed = window.confirm("Delete this run?");
    if (!confirmed) return;
    try {
      const response = await fetch(`${API_BASE}/runs/${runId}`, {
        method: "DELETE"
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      if (selectedRunId === runId) {
        setSelectedRunId(null);
      }
      setMessage("Success.");
      await fetchRunHistory(selectedTopology.topology_id);
      await fetchSingleRunTopologyIds();
    } catch {
      setMessage("Failed.");
    }
  }

  async function handleCreateBatch(name) {
    const cleanName = name.trim();
    if (!cleanName) return null;
    try {
      const response = await fetch(`${API_BASE}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanName })
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        return null;
      }
      setMessage("Success.");
      clearListCaches();
      await fetchBatches();
      await fetchSidebarBatches();
      setSelectedBatchId(data.batch_id);
      return data.batch_id;
    } catch {
      setMessage("Failed.");
      return null;
    }
  }

  async function handleToggleBatchLock(batchId, isLocked) {
    if (!batchId) return;
    const endpoint = isLocked ? "unlock" : "lock";
    try {
      const response = await fetch(`${API_BASE}/batches/${batchId}/${endpoint}`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        return;
      }
      setMessage("Success.");
      clearListCaches();
      await fetchBatches();
      await fetchSidebarBatches();
    } catch {
      setMessage("Failed.");
    }
  }

  async function handleDeleteBatch(batchId) {
    if (!batchId) return;
    const confirmed = window.confirm("Delete this batch and all its topologies?");
    if (!confirmed) return;
    try {
      const response = await fetch(`${API_BASE}/batches/${batchId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data?.message || "Failed.");
        return;
      }
      setMessage("Success.");
      if (selectedBatchId === batchId) {
        setSelectedBatchId("");
      }
      setSelectedTopology(null);
      setFocusedTopologyId(null);
      setGraphByTopologyId({});
      graphCacheRef.current.clear();
      graphInFlightRef.current.clear();
      clearListCaches();
      await fetchBatches();
      await fetchSidebarBatches();
      await fetchTopologies();
    } catch {
      setMessage("Failed.");
    }
  }

  const hideRightPanel = activeMenu === "generate" || activeMenu === "compare";

  const [exportSnapshotPatch, setExportSnapshotPatch] = useState({});
  const [compareExport, setCompareExport] = useState(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportModalSurface, setExportModalSurface] = useState("main");

  const resultsSingleFocusedBatch = useMemo(
    () =>
      focusedBatchId
        ? (runBatchesForSingleResults ?? []).find((batch) => batch.batch_id === focusedBatchId) ?? null
        : null,
    [focusedBatchId, runBatchesForSingleResults]
  );

  const focusedBatchTopologies = useMemo(() => {
    if (!focusedBatchId) return [];
    const batch = batches.find((item) => item.batch_id === focusedBatchId);
    return batch?.topologies ?? [];
  }, [batches, focusedBatchId]);

  const exportSnapshot = useMemo(
    () =>
      createExportSnapshot({
        activeMenu,
        homeToolTab,
        activePanel2Tab,
        focusedBatchId,
        focusedTopologyId,
        focusedBatchRunId,
        focusedBatchRunResult,
        batchRunProgress,
        batchRunResults,
        resultsSingleFocusedBatch,
        filteredBatches: batches,
        focusedBatchTopologies,
        topologyNodes,
        playgroundTree,
        runMultiForm,
        runBatchTopologies: sidebarBatches,
        delayPerEpisodePayload,
        policyTracePayload,
        pathSignaturesPayload,
        runHistoryItems,
        selectedTopology,
        compareExport,
        ...exportSnapshotPatch
      }),
    [
      activeMenu,
      homeToolTab,
      activePanel2Tab,
      focusedBatchId,
      focusedTopologyId,
      focusedBatchRunId,
      focusedBatchRunResult,
      batchRunProgress,
      batchRunResults,
      resultsSingleFocusedBatch,
      batches,
      focusedBatchTopologies,
      topologyNodes,
      playgroundTree,
      runMultiForm,
      sidebarBatches,
      delayPerEpisodePayload,
      policyTracePayload,
      pathSignaturesPayload,
      runHistoryItems,
      selectedTopology,
      compareExport,
      exportSnapshotPatch
    ]
  );

  const mainExportContext = useMemo(() => resolveExportContext(exportSnapshot, "main"), [exportSnapshot]);
  const rightExportContext = useMemo(() => resolveExportContext(exportSnapshot, "right"), [exportSnapshot]);
  const activeExportContext = exportModalSurface === "right" ? rightExportContext : mainExportContext;

  const openExportModal = useCallback((surface = "main") => {
    setExportModalSurface(surface);
    setExportModalOpen(true);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1280px)");
    const onChange = () => setIsNarrowLayout(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    localStorage.setItem(
      PANEL_LAYOUT_STORAGE_KEY,
      JSON.stringify({ sidebarWidth, rightPanelWidth })
    );
  }, [sidebarWidth, rightPanelWidth]);

  const dashboardGridColumns = useMemo(() => {
    if (isNarrowLayout) {
      return hideRightPanel ? "260px minmax(0, 1fr)" : "260px minmax(0, 1fr)";
    }
    if (hideRightPanel) {
      return `${sidebarWidth}px ${PANEL_RESIZER_WIDTH}px minmax(400px, 1fr)`;
    }
    return `${sidebarWidth}px ${PANEL_RESIZER_WIDTH}px minmax(400px, 1fr) ${PANEL_RESIZER_WIDTH}px ${rightPanelWidth}px`;
  }, [hideRightPanel, isNarrowLayout, rightPanelWidth, sidebarWidth]);

  const resizeSidebar = useCallback((deltaPx) => {
    setSidebarWidth((prev) => clampPanelWidth(prev + deltaPx, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
  }, []);

  const resizeRightPanel = useCallback((deltaPx) => {
    setRightPanelWidth((prev) => clampPanelWidth(prev - deltaPx, RIGHT_PANEL_WIDTH_MIN, RIGHT_PANEL_WIDTH_MAX));
  }, []);

  return (
    <main
      className={`dashboard-shell${hideRightPanel ? " generate-only-layout" : ""}${isNarrowLayout ? " dashboard-shell--narrow" : ""}`}
      style={{ gridTemplateColumns: dashboardGridColumns }}
    >
      <div className="dashboard-column dashboard-column--sidebar ui-scroll">
        <DashboardSidebar
          activeMenu={activeMenu}
          setActiveMenu={setActiveMenu}
          batches={sidebarBatches}
          selectedTopologyId={selectedTopology?.topology_id ?? null}
          onGoHome={goHome}
          queueSnapshot={queueSnapshot}
          managedWorkers={managedWorkers}
          onSpawnWorker={handleSpawnWorker}
          onKillWorker={handleKillWorker}
          isSpawningWorker={isSpawningWorker}
          killingWorkerId={killingWorkerId}
          onWorkersExpandedChange={setWorkersExpanded}
          onSelectTopology={handleOpenTopology}
          onSelectBatch={(batchId) => {
            setActiveMenu("topologies");
            setFocusedBatchId(batchId);
            setFocusedTopologyId(null);
          }}
        />
      </div>

      {!isNarrowLayout ? (
        <PanelResizer onResize={resizeSidebar} disabled={isNarrowLayout} ariaLabel="Resize sidebar" />
      ) : null}

      <div className="dashboard-column dashboard-column--main">
        <MainTopologyPanel
        activeMenu={activeMenu}
        activePanel2Tab={activePanel2Tab}
        mainTitle={mainTitle}
        temperatureTool={temperatureTool}
        resetTemperatureTool={resetTemperatureTool}
        updateTemperatureActionCount={updateTemperatureActionCount}
        updateTemperatureTauRange={updateTemperatureTauRange}
        updateTemperatureQRange={updateTemperatureQRange}
        updateTemperatureTau={updateTemperatureTau}
        updateTemperatureQValue={updateTemperatureQValue}
        updateTemperatureFontScale={updateTemperatureFontScale}
        homeToolTab={homeToolTab}
        setHomeToolTab={setHomeToolTab}
        ucbTool={ucbTool}
        resetUcbTool={resetUcbTool}
        updateUcbActionCount={updateUcbActionCount}
        updateUcbGlobalTRange={updateUcbGlobalTRange}
        updateUcbGlobalT={updateUcbGlobalT}
        updateUcbCRange={updateUcbCRange}
        updateUcbC={updateUcbC}
        updateUcbQRange={updateUcbQRange}
        updateUcbQValue={updateUcbQValue}
        updateUcbVisitCount={updateUcbVisitCount}
        generateMode={generateMode}
        setGenerateMode={setGenerateMode}
        generateForm={generateForm}
        multiGenerateForm={multiGenerateForm}
        updateGenerateField={updateGenerateField}
        updateMultiGenerateField={updateMultiGenerateField}
        toggleMultiNodeCount={toggleMultiNodeCount}
        handleGenerate={handleGenerate}
        handleGenerateMulti={handleGenerateMulti}
        isGenerating={isGenerating}
        selectedBatchId={selectedBatchId}
        setSelectedBatchId={setSelectedBatchId}
        generateBatches={sidebarBatches}
        generateSelectedBatch={selectedBatch}
        onToggleBatchLock={handleToggleBatchLock}
        runMultiForm={runMultiForm}
        setRunMultiForm={setRunMultiForm}
        runMultiSubMode={runMultiSubMode}
        setRunMultiSubMode={setRunMultiSubMode}
        repeatTopologyId={repeatTopologyId}
        setRepeatTopologyId={setRepeatTopologyId}
        repeatRunCount={repeatRunCount}
        setRepeatRunCount={setRepeatRunCount}
        runBatchTopologies={sidebarBatches}
        latestCompletedRun={latestCompletedRun}
        runSummaryPayload={runSummaryPayload}
        transmissionLastPayload={transmissionLastPayload}
        transmissionBestPayload={transmissionBestPayload}
        qTablePayload={qTablePayload}
        transmissionAllPayload={transmissionAllPayload}
        qTableAllEpochsPayload={qTableAllEpochsPayload}
        resultsViewMode={resultsViewMode}
        setResultsViewMode={setResultsViewMode}
        resultsEpochMode={resultsEpochMode}
        setResultsEpochMode={setResultsEpochMode}
        selectedEpisode={selectedEpisode}
        setSelectedEpisode={setSelectedEpisode}
        replaySlot={replaySlot}
        setReplaySlot={setReplaySlot}
        latestRunCapabilities={latestRunAlgorithmMeta?.capabilities ?? {}}
        graphDisplaySettings={graphDisplaySettings}
        bestDelayOverlayOpacity={bestDelayOverlayOpacity}
        runBatches={sidebarBatches}
        resultsSingleRunBatches={runBatchesForSingleResults}
        selectedRunId={selectedRunId}
        runHistoryItems={runHistoryItems}
        onSelectRun={(runId) => setSelectedRunId(runId)}
        onDeleteRun={handleDeleteRun}
        topologies={topologies}
        selectedTopology={selectedTopology}
        setSelectedTopology={setSelectedTopology}
        focusedBatchId={focusedBatchId}
        setFocusedBatchId={setFocusedBatchId}
        batchRunResults={batchRunResults}
        isLoadingBatchRunResults={isLoadingBatchRunResults}
        batchRunResultsError={batchRunResultsError}
        onRetryBatchRunResults={fetchBatchRunResults}
        focusedBatchRunId={focusedBatchRunId}
        setFocusedBatchRunId={setFocusedBatchRunId}
        focusedBatchRunResult={focusedBatchRunResult}
        isLoadingBatchRunResult={isLoadingBatchRunResult}
        batchRunResultDetailError={batchRunResultDetailError}
        onRetryBatchRunResultDetail={() => fetchBatchRunResultDetail(focusedBatchRunId, { silent: false })}
        batchRunProgress={batchRunProgress}
        onBatchStop={handleBatchStop}
        onBatchResume={handleBatchResume}
        onDeleteBatchRunResult={handleDeleteBatchRunResult}
        onRenameBatchRunResult={handleRenameBatchRunResult}
        graphByTopologyId={graphByTopologyId}
        playgroundState={playgroundState}
        playgroundNextStateCount={
          focusedTopologyId && graphByTopologyId[focusedTopologyId]
            ? countUniqueNextPlaygroundStates(
                graphByTopologyId[focusedTopologyId],
                playgroundState.coveredNodeIds,
                playgroundState.mode
              )
            : 0
        }
        setPlaygroundMode={setPlaygroundMode}
        setPlaygroundViewSlot={setPlaygroundViewSlot}
        setPlaygroundHoverNode={setPlaygroundHoverNode}
        clearPlaygroundHoverPreview={clearPlaygroundHoverPreview}
        commitPlaygroundNode={commitPlaygroundNode}
        playgroundTree={playgroundTree}
        playgroundTreeLoading={playgroundTreeLoading}
        playgroundTreeLoadError={playgroundTreeLoadError}
        playgroundTreeMode={playgroundTreeMode}
        setPlaygroundTreeMode={setPlaygroundTreeMode}
        onResetPlaygroundTree={() =>
          resetPlaygroundTreeData(selectedTopology?.topology_id ?? focusedTopologyId)
        }
        onExpandPlaygroundTree={() =>
          expandPlaygroundTreeAll(selectedTopology?.topology_id ?? focusedTopologyId)
        }
        playgroundTreeExpanding={playgroundTreeExpanding}
        playgroundTreeExpandStats={playgroundTreeExpandStats}
        runDerivedTree={runDerivedTree}
        runDerivedTreeLoading={runDerivedTreeLoading}
        runDerivedTreeLoadError={runDerivedTreeLoadError}
        runDerivedTreeMessage={runDerivedTreeMessage}
        runDerivedTreeSourceArtifact={runDerivedTreeSourceArtifact}
        playgroundRunSourceId={playgroundRunSourceId}
        setPlaygroundRunSourceId={setPlaygroundRunSourceId}
        onRefreshRunDerivedTree={() =>
          fetchRunDerivedPlaygroundTree(
            selectedTopology?.topology_id ?? focusedTopologyId,
            playgroundRunSourceId
          )
        }
        decisionTreeRowSpread={decisionTreeRowSpread}
        decisionTreeFontScale={decisionTreeFontScale}
        decisionTreeEdgeScale={decisionTreeEdgeScale}
        decisionTreeNodeScale={decisionTreeNodeScale}
        decisionTreeEdgeOpacity={decisionTreeEdgeOpacity}
        focusedTopologyId={focusedTopologyId}
        setFocusedTopologyId={setFocusedTopologyId}
        onDeleteTopology={handleDeleteTopology}
        onOpenTopology={handleOpenTopology}
        onPickTopologyForRun={handleRunTopoPick}
        onRepeatTopologyPick={handleRepeatTopologyPick}
        batches={batches}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        nodeFilter={nodeFilter}
        setNodeFilter={setNodeFilter}
        nodeOptions={NODE_OPTIONS}
        onCreateBatch={handleCreateBatch}
        onDeleteBatch={handleDeleteBatch}
        previewMaxNodesPercent={previewMaxNodesPercent}
        previewShowEdges={previewShowEdges}
        onRenameBatch={async (batchId, name) => {
          const cleanName = name.trim();
          if (!cleanName) return false;
          try {
            const response = await fetch(`${API_BASE}/batches/${batchId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: cleanName })
            });
            const data = await response.json();
            if (!response.ok) {
              setMessage(data?.message || "Failed.");
              return false;
            }
            setMessage("Success.");
            clearListCaches();
            await fetchBatches();
            await fetchSidebarBatches();
            return true;
          } catch {
            setMessage("Failed.");
            return false;
          }
        }}
        apiBase={API_BASE}
        singleRunTopologyIds={singleRunTopologyIds}
        topologyNameById={topologyNameById}
        onExportSnapshotPatch={setExportSnapshotPatch}
        onCompareExportChange={setCompareExport}
        compareExport={compareExport}
        mainExportContext={mainExportContext}
        onOpenExportModal={() => openExportModal("main")}
        />
      </div>

      {!hideRightPanel ? (
        <>
          {!isNarrowLayout ? (
            <PanelResizer onResize={resizeRightPanel} disabled={isNarrowLayout} ariaLabel="Resize right panel" />
          ) : null}
          <div className="dashboard-column dashboard-column--right">
            <RightControlPanel
          activePanel2Tab={activePanel2Tab}
          setActivePanel2Tab={setActivePanel2Tab}
          activeMenu={activeMenu}
          focusedBatchId={focusedBatchId}
          focusedTopologyId={focusedTopologyId}
          focusedBatch={focusedBatchForPanel}
          selectedTopology={selectedTopology}
          nodeOptions={NODE_OPTIONS}
          runTopoForm={runTopoForm}
          setRunTopoForm={setRunTopoForm}
        runMultiForm={runMultiForm}
        setRunMultiForm={setRunMultiForm}
        runMultiSubMode={runMultiSubMode}
        repeatTopologyId={repeatTopologyId}
        repeatRunCount={repeatRunCount}
        setRepeatRunCount={setRepeatRunCount}
          algorithmOptions={algorithmOptions}
          selectedAlgorithmMeta={selectedAlgorithmMeta}
        runTopoConfigForm={runTopoConfigForm}
        setRunTopoConfigForm={setRunTopoConfigForm}
        runMultiConfigForm={runMultiConfigForm}
        setRunMultiConfigForm={setRunMultiConfigForm}
          algorithmDefaultConfigById={algorithmDefaultConfigById}
          runPresets={runPresets}
          loadRunPresets={loadRunPresets}
          setMessage={setMessage}
          parseApiError={parseApiError}
          runTopoWizard={runTopoWizard}
          setRunTopoWizard={setRunTopoWizard}
          runMultiWizard={runMultiWizard}
          setRunMultiWizard={setRunMultiWizard}
          setSharedRunConfigForBackbone={setSharedRunConfigForBackbone}
          runTopoBackbone={runTopoBackbone}
          runMultiBackbone={runMultiBackbone}
          latestRunCapabilities={latestRunAlgorithmMeta?.capabilities ?? {}}
          runSingleTopology={handleRunSingleTopology}
        runMultiTopologies={handleRunMultiTopologies}
          isRunningSingle={isRunningSingle}
        isRunningBatch={isRunningBatch}
          lastSingleRun={lastSingleRun}
          runHistoryItems={runHistoryItems}
          focusedBatchRunResult={focusedBatchRunResult}
          runSummaryPayload={runSummaryPayload}
          latestCompletedRun={latestCompletedRun}
          transmissionLastPayload={transmissionLastPayload}
          transmissionBestPayload={transmissionBestPayload}
          resultsViewMode={resultsViewMode}
          resultsEpochMode={resultsEpochMode}
          replaySlot={replaySlot}
          stateActionLastPayload={stateActionLastPayload}
          stateActionBestPayload={stateActionBestPayload}
          delayPerEpisodePayload={delayPerEpisodePayload}
          policyTracePayload={policyTracePayload}
          pathSignaturesPayload={pathSignaturesPayload}
          resolvedRunConfigPayload={resolvedRunConfigPayload}
          stateActionAllPayload={stateActionAllPayload}
          transmissionAllPayload={transmissionAllPayload}
          qTableAllEpochsPayload={qTableAllEpochsPayload}
          selectedEpisode={selectedEpisode}
          graphDisplaySettings={graphDisplaySettings}
          setGraphDisplaySettings={setGraphDisplaySettings}
          resetGraphDisplaySettings={resetGraphDisplaySettings}
          bestDelayOverlayOpacity={bestDelayOverlayOpacity}
          setBestDelayOverlayOpacity={setBestDelayOverlayOpacity}
          previewMaxNodesPercent={previewMaxNodesPercent}
          setPreviewMaxNodesPercent={setPreviewMaxNodesPercent}
          previewShowEdges={previewShowEdges}
          setPreviewShowEdges={setPreviewShowEdges}
          isLoadingNodes={isLoadingNodes}
          topologyNodes={topologyNodes}
          handleNodeBlur={handleNodeBlur}
          handleNodeKeyDown={handleNodeKeyDown}
          saveTopology={saveTopology}
          isSavingTopology={isSavingTopology}
          topologyDetail={topologyDetail}
          isLoadingDetail={isLoadingDetail}
          playgroundState={playgroundState}
          playgroundNextStateCount={
            focusedTopologyId && graphByTopologyId[focusedTopologyId]
              ? countUniqueNextPlaygroundStates(
                  graphByTopologyId[focusedTopologyId],
                  playgroundState.coveredNodeIds,
                  playgroundState.mode
                )
              : 0
          }
          temperatureTool={temperatureTool}
          updateTemperatureFontScale={updateTemperatureFontScale}
          homeToolTab={homeToolTab}
          ucbTool={ucbTool}
          updateUcbFontScale={updateUcbFontScale}
          setPlaygroundMode={setPlaygroundMode}
          setPlaygroundViewSlot={setPlaygroundViewSlot}
          onResetPlayground={resetPlaygroundState}
          decisionTreeRowSpread={decisionTreeRowSpread}
          setDecisionTreeRowSpread={setDecisionTreeRowSpread}
          decisionTreeFontScale={decisionTreeFontScale}
          setDecisionTreeFontScale={setDecisionTreeFontScale}
          decisionTreeEdgeScale={decisionTreeEdgeScale}
          setDecisionTreeEdgeScale={setDecisionTreeEdgeScale}
          decisionTreeNodeScale={decisionTreeNodeScale}
          setDecisionTreeNodeScale={setDecisionTreeNodeScale}
          decisionTreeEdgeOpacity={decisionTreeEdgeOpacity}
          setDecisionTreeEdgeOpacity={setDecisionTreeEdgeOpacity}
          onSaveDecisionTreeLayoutDefaults={handleSaveDecisionTreeLayoutDefaults}
          rightExportContext={rightExportContext}
          onOpenExportModal={() => openExportModal("right")}
        />
          </div>
        </>
      ) : null}

      {message && <div className="toast">{message}</div>}
      <RunBatchNameModal
        open={runBatchNameModalOpen}
        value={runBatchNameDraft}
        setValue={setRunBatchNameDraft}
        defaultLabel={runBatchDefaultLabel}
        isSubmitting={isRunningBatch}
        onCancel={() => {
          if (isRunningBatch) return;
          setRunBatchNameModalOpen(false);
        }}
        onConfirm={() => {
          if (isRunningBatch) return;
          void submitRunMultiTopologies();
        }}
      />
      <CsvExportModal
        open={exportModalOpen}
        snapshot={exportSnapshot}
        context={activeExportContext}
        surface={exportModalSurface}
        onClose={() => setExportModalOpen(false)}
      />
    </main>
  );
}

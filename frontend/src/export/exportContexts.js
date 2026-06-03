import { buildCsv, parseCsvRows, csvHeadersFromPayload, safeFilename } from "./csvUtils.js";
import {
  BATCH_SUMMARY_COLUMN_DEFS,
  BATCH_EPISODE_COLUMN_DEFS,
  buildBatchSummaryRows,
  buildBatchEpisodeRows
} from "./batchRunBuilders.js";

/**
 * @typedef {Object} ExportColumnDef
 * @property {string} key
 * @property {string} label
 * @property {string} [group]
 * @property {boolean} [default]
 */

/**
 * @typedef {Object} ExportProfile
 * @property {string} id
 * @property {string} label
 * @property {ExportColumnDef[]} columns
 * @property {boolean} [supportsRowModes]
 */

/**
 * @typedef {Object} ExportContext
 * @property {string} id
 * @property {string} title
 * @property {ExportColumnDef[]} columns
 * @property {ExportProfile[]} [profiles]
 * @property {string} [activeProfileId]
 * @property {{ id: string, label: string }[]} [rowModes]
 * @property {string} [defaultRowMode]
 * @property {{ id: string, label: string }[]} [compareSides]
 * @property {string} [defaultCompareSide]
 * @property {string} [warning]
 * @property {string} [disabledReason]
 * @property {(snapshot: ExportSnapshot, options: ExportBuildOptions) => Record<string, unknown>[]} buildRows
 * @property {(snapshot: ExportSnapshot, options: ExportBuildOptions) => string} defaultFilename
 */

/**
 * @typedef {Object} ExportBuildOptions
 * @property {string[]} selectedKeys
 * @property {string} [rowMode]
 * @property {string} [profileId]
 * @property {string} [compareSide]
 * @property {string} [datasetId]
 */

/**
 * @typedef {ReturnType<import('./exportSnapshot.js').createExportSnapshot>} ExportSnapshot
 */

function pickColumns(columnDefs, selectedKeys) {
  const keys = selectedKeys?.length ? selectedKeys : columnDefs.filter((c) => c.default !== false).map((c) => c.key);
  return columnDefs.filter((col) => keys.includes(col.key));
}

function batchResultTitle(result) {
  return result?.result_label || result?.batch_name || result?.batch_run_id?.slice(0, 8) || "batch";
}

const SOFTMAX_COLUMNS = [
  { key: "action", label: "action", group: "Softmax", default: true },
  { key: "q_value", label: "q_value", group: "Softmax", default: true },
  { key: "logit", label: "logit", group: "Softmax", default: true },
  { key: "probability", label: "probability", group: "Softmax", default: true }
];

const UCB_COLUMNS = [
  { key: "action", label: "action", group: "UCB", default: true },
  { key: "q_value", label: "q_value", group: "UCB", default: true },
  { key: "visit_count", label: "visit_count", group: "UCB", default: true },
  { key: "bonus", label: "bonus", group: "UCB", default: true },
  { key: "ucb_score", label: "ucb_score", group: "UCB", default: true },
  { key: "selected", label: "selected", group: "UCB", default: true }
];

const QTABLE_COLUMNS = [
  { key: "state_hash", label: "state_hash", group: "Q-table", default: true },
  { key: "action", label: "action", group: "Q-table", default: true },
  { key: "q_value", label: "q_value", group: "Q-table", default: true }
];

const ACTION_SPACE_COLUMNS = [
  { key: "timeslot", label: "timeslot", group: "Action space", default: true },
  { key: "mean_candidate_count", label: "mean_candidate_count", group: "Action space", default: true },
  { key: "n_unique_paths", label: "n_unique_paths", group: "Action space", default: true }
];

const TOPOLOGY_SUMMARY_COLUMNS = [
  { key: "topology_id", label: "topology_id", group: "Topology", default: true },
  { key: "topology_name", label: "topology_name", group: "Topology", default: true },
  { key: "status", label: "status", group: "Topology", default: true },
  { key: "node_count", label: "node_count", group: "Topology", default: true },
  { key: "finished_delay", label: "finished_delay", group: "Metrics", default: true },
  { key: "best_delay_explored", label: "best_delay_explored", group: "Metrics", default: true },
  { key: "lower_bound", label: "lower_bound", group: "Metrics", default: true }
];

const BATCH_LIST_COLUMNS = [
  { key: "batch_run_id", label: "batch_run_id", group: "Batch", default: true },
  { key: "result_label", label: "result_label", group: "Batch", default: true },
  { key: "batch_name", label: "batch_name", group: "Batch", default: false },
  { key: "total_topologies", label: "total_topologies", group: "Batch", default: true },
  { key: "successful", label: "successful", group: "Batch", default: true },
  { key: "failed", label: "failed", group: "Batch", default: true },
  { key: "batch_status", label: "batch_status", group: "Batch", default: true },
  { key: "created_at", label: "created_at", group: "Batch", default: false }
];

const BATCH_GRID_COLUMNS = [
  { key: "batch_id", label: "batch_id", group: "Batch", default: false },
  { key: "batch_name", label: "batch_name", group: "Batch", default: true },
  { key: "is_locked", label: "is_locked", group: "Batch", default: true },
  { key: "topology_count", label: "topology_count", group: "Batch", default: true }
];

const NODE_COLUMNS = [
  { key: "node_id", label: "node_id", group: "Nodes", default: true },
  { key: "x", label: "x", group: "Nodes", default: true },
  { key: "y", label: "y", group: "Nodes", default: true }
];

const PLAYGROUND_NODE_COLUMNS = [
  { key: "state_hash", label: "state_hash", group: "Nodes", default: true },
  { key: "state_index", label: "state_index", group: "Nodes", default: true },
  { key: "depth", label: "depth", group: "Nodes", default: true },
  { key: "covered_node_ids", label: "covered_node_ids", group: "Nodes", default: true }
];

const PLAYGROUND_EDGE_COLUMNS = [
  { key: "from_state_hash", label: "from_state_hash", group: "Edges", default: true },
  { key: "to_state_hash", label: "to_state_hash", group: "Edges", default: true },
  { key: "actions", label: "actions", group: "Edges", default: true },
  { key: "mode", label: "mode", group: "Edges", default: true }
];

const RUN_MULTI_COLUMNS = [
  { key: "topology_id", label: "topology_id", group: "Selection", default: true },
  { key: "topology_name", label: "topology_name", group: "Selection", default: true },
  { key: "node_count", label: "node_count", group: "Selection", default: true },
  { key: "selected", label: "selected", group: "Selection", default: true }
];

const BATCH_PROGRESS_COLUMNS = [
  { key: "topology_index", label: "topology_index", group: "Progress", default: true },
  { key: "topology_name", label: "topology_name", group: "Progress", default: true },
  { key: "status", label: "status", group: "Progress", default: true },
  { key: "run_id", label: "run_id", group: "Progress", default: false },
  { key: "topology_id", label: "topology_id", group: "Progress", default: false }
];

const RUN_HISTORY_COLUMNS = [
  { key: "run_id", label: "run_id", group: "Run", default: false },
  { key: "status", label: "status", group: "Run", default: true },
  { key: "preset_name", label: "preset_name", group: "Run", default: true },
  { key: "created_at", label: "created_at", group: "Run", default: true },
  { key: "finished_delay", label: "finished_delay", group: "Metrics", default: true },
  { key: "best_delay_explored", label: "best_delay_explored", group: "Metrics", default: true },
  { key: "lower_bound", label: "lower_bound", group: "Metrics", default: true },
  { key: "total_states", label: "total_states", group: "Learning size", default: true },
  { key: "total_state_actions", label: "total_state_actions", group: "Learning size", default: true },
  { key: "decision_graph_edges", label: "decision_graph_edges", group: "Learning size", default: true }
];

const COMPARE_SINGLE_COLUMNS = [
  { key: "algorithm_id", label: "algorithm_id", group: "Run", default: true },
  { key: "preset_name", label: "preset_name", group: "Run", default: true },
  { key: "finished_delay", label: "finished_delay", group: "Metrics", default: true },
  { key: "best_delay_explored", label: "best_delay_explored", group: "Metrics", default: true },
  { key: "lower_bound", label: "lower_bound", group: "Metrics", default: true },
  { key: "total_states", label: "total_states", group: "Learning size", default: false },
  { key: "total_state_actions", label: "total_state_actions", group: "Learning size", default: false },
  { key: "decision_graph_edges", label: "decision_graph_edges", group: "Learning size", default: false },
  { key: "created_at", label: "created_at", group: "Run", default: false },
  { key: "episode", label: "episode", group: "Episode", default: true },
  { key: "delay", label: "delay", group: "Episode", default: true }
];

function buildBatchRunDetailContext(result) {
  return {
    id: "results.batch_run_detail",
    title: `Batch run — ${batchResultTitle(result)}`,
    columns: BATCH_SUMMARY_COLUMN_DEFS,
    rowModes: [
      { id: "summary", label: "Summary (one row per topology)" },
      { id: "episode_series", label: "Episode series (one row per episode)" }
    ],
    defaultRowMode: "summary",
    buildRows(snapshot, options) {
      const rowMode = options.rowMode ?? "summary";
      if (rowMode === "episode_series") {
        const cols = pickColumns(BATCH_EPISODE_COLUMN_DEFS, options.selectedKeys);
        return buildBatchEpisodeRows(result, cols.map((c) => c.key));
      }
      const cols = pickColumns(BATCH_SUMMARY_COLUMN_DEFS, options.selectedKeys);
      return buildBatchSummaryRows(result, cols.map((c) => c.key));
    },
    defaultFilename() {
      return `batch_run_${safeFilename(batchResultTitle(result))}`;
    }
  };
}

function resolveCompareContext(snapshot) {
  const cmp = snapshot.compareExport;
  if (!cmp) return null;
  if (cmp.compareKind === "batch") {
    const sides = [
      { id: "A", label: "Side A", result: cmp.resultA, batchId: cmp.batchIdA },
      { id: "B", label: "Side B", result: cmp.resultB, batchId: cmp.batchIdB }
    ].filter((s) => s.result?.topologies?.length);
    if (!sides.length) {
      return {
        id: "compare.batch",
        title: "Compare — batch results",
        columns: BATCH_SUMMARY_COLUMN_DEFS,
        disabledReason: "Select at least one batch result with data on side A or B."
      };
    }
    const defaultSide = sides[0].id;
    return {
      id: "compare.batch",
      title: "Compare — batch results",
      columns: BATCH_SUMMARY_COLUMN_DEFS,
      compareSides: sides.map(({ id, label }) => ({ id, label })),
      defaultCompareSide: defaultSide,
      rowModes: [
        { id: "summary", label: "Summary (one row per topology)" },
        { id: "episode_series", label: "Episode series" }
      ],
      defaultRowMode: "summary",
      buildRows(snap, options) {
        const side = sides.find((s) => s.id === (options.compareSide ?? defaultSide)) ?? sides[0];
        const ctx = buildBatchRunDetailContext(side.result);
        return ctx.buildRows(snap, options);
      },
      defaultFilename(snap, options) {
        const side = sides.find((s) => s.id === (options.compareSide ?? defaultSide)) ?? sides[0];
        return `compare_batch_${options.compareSide ?? defaultSide}_${safeFilename(batchResultTitle(side.result))}`;
      }
    };
  }

  const sides = [
    { id: "A", label: "Side A", run: cmp.selectedRunA, delaySeries: cmp.delayA, topoName: cmp.topoNameA },
    { id: "B", label: "Side B", run: cmp.selectedRunB, delaySeries: cmp.delayB, topoName: cmp.topoNameB }
  ].filter((s) => s.run);
  if (!sides.length) {
    return {
      id: "compare.single",
      title: "Compare — single runs",
      columns: COMPARE_SINGLE_COLUMNS,
      disabledReason: "Select a completed run on side A or B."
    };
  }
  const defaultSide = sides[0].id;
  return {
    id: "compare.single",
    title: "Compare — single runs",
    columns: COMPARE_SINGLE_COLUMNS,
    compareSides: sides.map(({ id, label }) => ({ id, label })),
    defaultCompareSide: defaultSide,
    buildRows(snap, options) {
      const side = sides.find((s) => s.id === (options.compareSide ?? defaultSide)) ?? sides[0];
      const run = side.run;
      const meta = {
        algorithm_id: run.algorithm_id ?? "",
        preset_name: run.preset_name ?? run.preset_id ?? "",
        finished_delay: run.finished_delay ?? "",
        best_delay_explored: run.best_delay_explored ?? "",
        lower_bound: run.lower_bound ?? "",
        total_states: run.total_states ?? "",
        total_state_actions: run.total_state_actions ?? "",
        decision_graph_edges: run.decision_graph_edges ?? "",
        created_at: run.created_at ?? ""
      };
      const keys = pickColumns(COMPARE_SINGLE_COLUMNS, options.selectedKeys).map((c) => c.key);
      const metaKeys = keys.filter((k) => k !== "episode" && k !== "delay");
      const series = side.delaySeries ?? [];
      if (keys.includes("episode") || keys.includes("delay")) {
        if (!series.length) {
          const row = {};
          keys.forEach((k) => {
            row[k] = meta[k] ?? "";
          });
          return [row];
        }
        return series.map((delay, idx) => {
          const row = {};
          keys.forEach((k) => {
            if (k === "episode") row[k] = idx + 1;
            else if (k === "delay") row[k] = delay;
            else row[k] = meta[k] ?? "";
          });
          return row;
        });
      }
      const row = {};
      keys.forEach((k) => {
        row[k] = meta[k] ?? "";
      });
      return [row];
    },
    defaultFilename(snap, options) {
      return `compare_single_${options.compareSide ?? defaultSide}`;
    }
  };
}

function resolveRightPanelContext(snapshot) {
  const onResultsTab = snapshot.activePanel2Tab === "results";
  const hasRunContext =
    (snapshot.activeMenu === "run_topo" || snapshot.activeMenu === "results") &&
    snapshot.focusedTopologyId &&
    !snapshot.focusedBatchRunId;

  if (!onResultsTab || !hasRunContext) return null;

  const datasets = [];
  if (snapshot.delayPerEpisodePayload?.text) {
    datasets.push({ id: "delay_per_episode", label: "Delay per episode", payload: snapshot.delayPerEpisodePayload });
  }
  if (snapshot.policyTracePayload?.text) {
    datasets.push({ id: "policy_trace", label: "Policy trace", payload: snapshot.policyTracePayload });
  }
  if (snapshot.pathSignaturesPayload?.text) {
    datasets.push({ id: "path_signatures", label: "Path signatures", payload: snapshot.pathSignaturesPayload });
  }

  if (datasets.length) {
    const defaultDataset = datasets[0].id;
    const buildArtifactColumns = (datasetId) => {
      const ds = datasets.find((d) => d.id === datasetId) ?? datasets[0];
      return csvHeadersFromPayload(ds.payload).map((key) => ({
        key,
        label: key,
        group: ds.label,
        default: true
      }));
    };
    return {
      id: "right.run.artifacts",
      title: `Run artifacts — ${snapshot.selectedTopology?.topology_name ?? "topology"}`,
      profiles: datasets.map((ds) => ({
        id: ds.id,
        label: ds.label,
        columns: buildArtifactColumns(ds.id)
      })),
      activeProfileId: defaultDataset,
      columns: buildArtifactColumns(defaultDataset),
      buildRows(snap, options) {
        const ds = datasets.find((d) => d.id === (options.profileId ?? defaultDataset)) ?? datasets[0];
        const rows = parseCsvRows(ds.payload);
        const cols = pickColumns(
          csvHeadersFromPayload(ds.payload).map((key) => ({ key, label: key, default: true })),
          options.selectedKeys
        );
        return rows.map((row) => {
          const out = {};
          cols.forEach((col) => {
            out[col.key] = row[col.key] ?? "";
          });
          return out;
        });
      },
      defaultFilename(snap, options) {
        const ds = datasets.find((d) => d.id === (options.profileId ?? defaultDataset)) ?? datasets[0];
        return safeFilename(ds.id);
      }
    };
  }

  if ((snapshot.runHistoryItems ?? []).length) {
    return {
      id: "right.run.history",
      title: `Run history — ${snapshot.selectedTopology?.topology_name ?? "topology"}`,
      columns: RUN_HISTORY_COLUMNS,
      buildRows(snap, options) {
        const cols = pickColumns(RUN_HISTORY_COLUMNS, options.selectedKeys);
        return (snap.runHistoryItems ?? []).map((run) => {
          const row = {};
          cols.forEach((col) => {
            row[col.key] = run[col.key] ?? "";
          });
          return row;
        });
      },
      defaultFilename() {
        return `run_history_${safeFilename(snapshot.selectedTopology?.topology_name)}`;
      }
    };
  }

  return null;
}

/** @param {ExportSnapshot} snapshot @param {'main'|'right'} surface */
export function resolveExportContext(snapshot, surface = "main") {
  if (surface === "right") {
    return resolveRightPanelContext(snapshot);
  }

  const menu = snapshot.activeMenu;

  if (menu === "home") {
    if (snapshot.homeToolTab === "ucb" && (snapshot.ucbRows ?? []).length) {
      return {
        id: "home.ucb",
        title: "Home — UCB tool",
        columns: UCB_COLUMNS,
        buildRows(snap, options) {
          const cols = pickColumns(UCB_COLUMNS, options.selectedKeys);
          return (snap.ucbRows ?? []).map((row) => {
            const out = {};
            cols.forEach((col) => {
              if (col.key === "q_value") out[col.key] = row.qValue ?? row.q_value ?? "";
              else if (col.key === "visit_count") out[col.key] = row.visitCount ?? row.visit_count ?? "";
              else if (col.key === "ucb_score") out[col.key] = row.score ?? row.ucb_score ?? "";
              else if (col.key === "selected") out[col.key] = row.selected ? "1" : "0";
              else out[col.key] = row[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename: () => "home_ucb"
      };
    }
    if ((snapshot.temperatureRows ?? []).length) {
      return {
        id: "home.softmax",
        title: "Home — Softmax tool",
        columns: SOFTMAX_COLUMNS,
        buildRows(snap, options) {
          const cols = pickColumns(SOFTMAX_COLUMNS, options.selectedKeys);
          return (snap.temperatureRows ?? []).map((row) => {
            const out = {};
            cols.forEach((col) => {
              if (col.key === "q_value") out[col.key] = row.qValue ?? row.q_value ?? "";
              else out[col.key] = row[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename: () => "home_softmax"
      };
    }
    return null;
  }

  if (menu === "compare") {
    return resolveCompareContext(snapshot);
  }

  if (menu === "results") {
    if (snapshot.focusedBatchRunId && snapshot.focusedBatchRunResult?.topologies?.length) {
      return buildBatchRunDetailContext(snapshot.focusedBatchRunResult);
    }
    if (snapshot.focusedBatchRunId && snapshot.batchRunProgress?.rows?.length) {
      return {
        id: "results.batch_progress",
        title: "Batch run — progress",
        columns: BATCH_PROGRESS_COLUMNS,
        buildRows(snap, options) {
          const cols = pickColumns(BATCH_PROGRESS_COLUMNS, options.selectedKeys);
          return (snap.batchRunProgress.rows ?? []).map((row, idx) => {
            const full = {
              topology_index: row.topology_index ?? idx,
              topology_name: row.topology_name ?? "",
              status: row.status ?? "",
              run_id: row.run_id ?? "",
              topology_id: row.topology_id ?? ""
            };
            const out = {};
            cols.forEach((col) => {
              out[col.key] = full[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename: () => "batch_progress"
      };
    }
    if (snapshot.focusedTopologyId) {
      const profiles = [];
      if ((snapshot.qTableRows ?? []).length) {
        profiles.push({
          id: "qtable",
          label: "Q-table",
          columns: QTABLE_COLUMNS
        });
      }
      if ((snapshot.actionSpaceRows ?? []).length) {
        profiles.push({
          id: "action_space",
          label: `Action space (${snapshot.actionSpaceProfile ?? "rcv"})`,
          columns: ACTION_SPACE_COLUMNS
        });
      }
      if (profiles.length) {
        const activeProfileId = profiles[0].id;
        return {
          id: "results.single",
          title: `Single topology — ${snapshot.selectedTopology?.topology_name ?? "results"}`,
          profiles,
          activeProfileId,
          columns: profiles[0].columns,
          buildRows(snap, options) {
            const profileId = options.profileId ?? activeProfileId;
            if (profileId === "action_space") {
              const cols = pickColumns(ACTION_SPACE_COLUMNS, options.selectedKeys);
              return (snap.actionSpaceRows ?? []).map((row) => {
                const out = {};
                cols.forEach((col) => {
                  out[col.key] = row[col.key] ?? "";
                });
                return out;
              });
            }
            const cols = pickColumns(QTABLE_COLUMNS, options.selectedKeys);
            return (snap.qTableRows ?? []).map((row) => {
              const out = {};
              cols.forEach((col) => {
                out[col.key] = row[col.key] ?? "";
              });
              return out;
            });
          },
          defaultFilename(snap, options) {
            const name = safeFilename(snap.selectedTopology?.topology_name);
            if ((options.profileId ?? activeProfileId) === "action_space") return `action_space_${name}`;
            return `qtable_${name}`;
          }
        };
      }
    }
    if (snapshot.focusedBatchId && snapshot.resultsSingleFocusedBatch?.topologies?.length) {
      return {
        id: "results.single.topologies",
        title: `Topologies — ${snapshot.resultsSingleFocusedBatch.batch_name ?? "batch"}`,
        columns: TOPOLOGY_SUMMARY_COLUMNS,
        buildRows(snap, options) {
          const cols = pickColumns(TOPOLOGY_SUMMARY_COLUMNS, options.selectedKeys);
          return (snap.resultsSingleFocusedBatch.topologies ?? []).map((topo) => {
            const out = {};
            cols.forEach((col) => {
              out[col.key] = topo[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename(snap) {
          return `topologies_${safeFilename(snap.resultsSingleFocusedBatch?.batch_name)}`;
        }
      };
    }
    if ((snapshot.batchRunResults ?? []).length) {
      return {
        id: "results.batch_list",
        title: "Batch run list",
        columns: BATCH_LIST_COLUMNS,
        buildRows(snap, options) {
          const cols = pickColumns(BATCH_LIST_COLUMNS, options.selectedKeys);
          return (snap.batchRunResults ?? []).map((item) => {
            const full = {
              batch_run_id: item.batch_run_id ?? "",
              result_label: item.result_label ?? "",
              batch_name: item.batch_name ?? "",
              total_topologies: item.total_topologies ?? "",
              successful: item.successful ?? "",
              failed: item.failed ?? "",
              batch_status: item.batch_status ?? "",
              created_at: item.created_at ?? ""
            };
            const out = {};
            cols.forEach((col) => {
              out[col.key] = full[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename: () => "batch_run_list"
      };
    }
    return null;
  }

  if (menu === "topologies") {
    if (snapshot.activePanel2Tab === "edit_topo" && snapshot.focusedTopologyId && (snapshot.topologyNodes ?? []).length) {
      return {
        id: "topologies.nodes",
        title: `Topology nodes — ${snapshot.selectedTopology?.topology_name ?? ""}`,
        columns: NODE_COLUMNS,
        buildRows(snap, options) {
          const cols = pickColumns(NODE_COLUMNS, options.selectedKeys);
          return (snap.topologyNodes ?? []).map((node) => {
            const out = {};
            cols.forEach((col) => {
              out[col.key] = node[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename(snap) {
          return `nodes_${safeFilename(snap.selectedTopology?.topology_name)}`;
        }
      };
    }
    if (snapshot.activePanel2Tab === "playground" && snapshot.focusedTopologyId && snapshot.playgroundTree) {
      const tree = snapshot.playgroundTree;
      return {
        id: "topologies.playground",
        title: `Playground tree — ${snapshot.selectedTopology?.topology_name ?? ""}`,
        profiles: [
          { id: "nodes", label: "Nodes", columns: PLAYGROUND_NODE_COLUMNS },
          { id: "edges", label: "Edges", columns: PLAYGROUND_EDGE_COLUMNS }
        ],
        activeProfileId: "nodes",
        columns: PLAYGROUND_NODE_COLUMNS,
        buildRows(snap, options) {
          const profileId = options.profileId ?? "nodes";
          if (profileId === "edges") {
            const cols = pickColumns(PLAYGROUND_EDGE_COLUMNS, options.selectedKeys);
            return (tree.edges ?? []).map((edge) => {
              const out = {};
              cols.forEach((col) => {
                if (col.key === "actions") out[col.key] = Array.isArray(edge.actions) ? edge.actions.join("|") : edge.actions ?? "";
                else out[col.key] = edge[col.key] ?? "";
              });
              return out;
            });
          }
          const cols = pickColumns(PLAYGROUND_NODE_COLUMNS, options.selectedKeys);
          return (tree.nodes ?? []).map((node) => {
            const out = {};
            cols.forEach((col) => {
              if (col.key === "covered_node_ids") {
                out[col.key] = Array.isArray(node.covered_node_ids) ? node.covered_node_ids.join("|") : node.covered_node_ids ?? "";
              } else out[col.key] = node[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename(snap, options) {
          const base = safeFilename(snap.selectedTopology?.topology_name);
          return (options.profileId ?? "nodes") === "edges" ? `playground_edges_${base}` : `playground_nodes_${base}`;
        }
      };
    }
    if (snapshot.focusedBatchId && (snapshot.focusedBatchTopologies ?? []).length) {
      return {
        id: "topologies.topologies",
        title: `Topologies — batch`,
        columns: TOPOLOGY_SUMMARY_COLUMNS,
        buildRows(snap, options) {
          const cols = pickColumns(TOPOLOGY_SUMMARY_COLUMNS, options.selectedKeys);
          return (snap.focusedBatchTopologies ?? []).map((topo) => {
            const out = {};
            cols.forEach((col) => {
              out[col.key] = topo[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename: () => "batch_topologies"
      };
    }
    if ((snapshot.filteredBatches ?? []).length) {
      return {
        id: "topologies.batches",
        title: "Batches",
        columns: BATCH_GRID_COLUMNS,
        buildRows(snap, options) {
          const cols = pickColumns(BATCH_GRID_COLUMNS, options.selectedKeys);
          return (snap.filteredBatches ?? []).map((batch) => {
            const out = {};
            cols.forEach((col) => {
              if (col.key === "topology_count") out[col.key] = batch.topologies?.length ?? 0;
              else if (col.key === "is_locked") out[col.key] = batch.is_locked ? "1" : "0";
              else out[col.key] = batch[col.key] ?? "";
            });
            return out;
          });
        },
        defaultFilename: () => "batches"
      };
    }
    return null;
  }

  if (menu === "run_multi" && snapshot.runMultiForm?.batch_id) {
    const selectedBatch = (snapshot.runBatchTopologies ?? []).find(
      (batch) => batch.batch_id === snapshot.runMultiForm.batch_id
    );
    const topologies = selectedBatch?.topologies ?? [];
    if (!topologies.length) return null;
    return {
      id: "run_multi.selection",
      title: "Run multi — topology selection",
      columns: RUN_MULTI_COLUMNS,
      buildRows(snap, options) {
        const cols = pickColumns(RUN_MULTI_COLUMNS, options.selectedKeys);
        const batch = (snap.runBatchTopologies ?? []).find((item) => item.batch_id === snap.runMultiForm?.batch_id);
        const list = batch?.topologies ?? [];
        const selected = new Set(snap.runMultiForm?.selected_topology_ids ?? []);
        return list.map((topo) => {
          const out = {};
          cols.forEach((col) => {
            if (col.key === "selected") out[col.key] = selected.has(topo.topology_id) ? "1" : "0";
            else out[col.key] = topo[col.key] ?? "";
          });
          return out;
        });
      },
      defaultFilename: () => "run_multi_selection"
    };
  }

  return null;
}

export function buildExportCsv(snapshot, context, options) {
  const columns =
    context.profiles?.length && options.profileId
      ? pickColumns(
          context.profiles.find((p) => p.id === options.profileId)?.columns ?? context.columns,
          options.selectedKeys
        )
      : pickColumns(context.columns, options.selectedKeys);

  if (context.rowModes?.length && options.rowMode === "episode_series") {
    const episodeCols = pickColumns(BATCH_EPISODE_COLUMN_DEFS, options.selectedKeys);
    if (episodeCols.length) {
      // columns already resolved inside buildRows for batch contexts
    }
  }

  const rows = context.buildRows?.(snapshot, options) ?? [];
  return { csv: buildCsv(columns, rows), rowCount: rows.length, columns };
}

export function getContextColumns(context, options = {}) {
  if (context.profiles?.length) {
    const profile = context.profiles.find((p) => p.id === (options.profileId ?? context.activeProfileId)) ?? context.profiles[0];
    if (options.rowMode === "episode_series" && context.rowModes?.length) {
      return BATCH_EPISODE_COLUMN_DEFS;
    }
    return profile.columns;
  }
  if (options.rowMode === "episode_series" && context.rowModes?.length) {
    return BATCH_EPISODE_COLUMN_DEFS;
  }
  return context.columns;
}

export function runExportDownload(snapshot, context, options) {
  const activeColumns = getContextColumns(context, options);
  const selectedKeys = options.selectedKeys?.length
    ? options.selectedKeys
    : activeColumns.filter((c) => c.default !== false).map((c) => c.key);
  const buildOptions = { ...options, selectedKeys };
  const rows = context.buildRows(snapshot, buildOptions);
  const columns = activeColumns.filter((c) => selectedKeys.includes(c.key));
  const csv = buildCsv(columns, rows);
  const filename = context.defaultFilename(snapshot, buildOptions);
  return { csv, filename, rowCount: rows.length };
}

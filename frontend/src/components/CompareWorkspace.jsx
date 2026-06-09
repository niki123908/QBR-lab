import { useCallback, useEffect, useMemo, useState } from "react";
import CompareChartWorkspace from "./CompareChartWorkspace.jsx";
import { readCompareWorkspaceSession, writeCompareWorkspaceSession } from "../utils/compareWorkspaceStorage.js";
import BatchResultDetailBody, {
  boxplotYAxisFromDensityGroups,
  delayAxisByDensityFromResults,
  scatterYAxisByDensityFromResults
} from "./BatchResultDetailBody";
import { MiniDelayPerEpisodeChart } from "./BatchResultDetailBody";

function parseCsvRows(payload) {
  const text = payload?.text;
  if (!text || typeof text !== "string") return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx]?.trim() ?? "";
    });
    return row;
  });
}

function delaySeriesFromArtifactPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.map(Number).filter((n) => Number.isFinite(n));
  }
  const rows = parseCsvRows(payload);
  return rows
    .map((row) => Number(row.delay))
    .filter((n) => Number.isFinite(n));
}

async function fetchBatchResultDetail(apiBase, batchRunId) {
  const response = await fetch(`${apiBase}/runs/batch/${batchRunId}/result`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || "Could not load batch result.");
  }
  return data;
}

async function fetchRunHistory(apiBase, topologyId) {
  const response = await fetch(`${apiBase}/runs/history?topology_id=${encodeURIComponent(topologyId)}`);
  const data = await response.json();
  if (!response.ok || !Array.isArray(data)) {
    throw new Error(data?.message || "Could not load run history.");
  }
  return data;
}

async function fetchDelayArtifact(apiBase, runId) {
  const response = await fetch(`${apiBase}/runs/${runId}/artifacts/delay_per_episode`);
  if (!response.ok) return null;
  const data = await response.json();
  return data?.payload ?? null;
}

function formatRunOption(run) {
  const delay = run.finished_delay ?? "—";
  const date = run.created_at ? new Date(run.created_at).toLocaleString() : "";
  return `${run.preset_name || run.algorithm_id} · delay ${delay} · ${date}`;
}

function SingleRunCompareCard({ run, topologyName, delaySeries }) {
  if (!run) {
    return <div className="empty-topology-state compare-empty-hint">Select a completed run.</div>;
  }
  const chartPoint = {
    topology_name: topologyName || run.topology_id,
    topology_id: run.topology_id,
    topology_index: 0,
    last_delay: run.finished_delay,
    best_delay: run.best_delay_explored,
    delay_per_episode: delaySeries ?? []
  };

  return (
    <div className="compare-single-result-card">
      <dl className="compare-run-meta">
        <div>
          <dt>Algorithm</dt>
          <dd>{run.algorithm_id}</dd>
        </div>
        <div>
          <dt>Preset</dt>
          <dd>{run.preset_name || run.preset_id}</dd>
        </div>
        <div>
          <dt>Finished delay</dt>
          <dd>{run.finished_delay ?? "—"}</dd>
        </div>
        <div>
          <dt>Best explored</dt>
          <dd>{run.best_delay_explored ?? "—"}</dd>
        </div>
        <div>
          <dt>Lower bound</dt>
          <dd>{run.lower_bound ?? "—"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{run.created_at ? new Date(run.created_at).toLocaleString() : "—"}</dd>
        </div>
      </dl>
      {run.warning_topology_changed ? (
        <p className="compare-warning muted">Topology changed after this run.</p>
      ) : null}
      {delaySeries?.length ? (
        <MiniDelayPerEpisodeChart point={chartPoint} />
      ) : (
        <p className="muted compare-empty-hint">No delay_per_episode artifact for this run.</p>
      )}
    </div>
  );
}

function CompareColumn({
  sideLabel,
  compareKind,
  batchList,
  batchId,
  onBatchIdChange,
  batchResult,
  batchLoading,
  batchError,
  singleTopologyIds,
  topologyNameById,
  topoId,
  onTopoIdChange,
  runId,
  onRunIdChange,
  history,
  historyLoading,
  historyError,
  selectedRun,
  delaySeries,
  delayLoading,
  artifactFilter,
  onArtifactFilterChange,
  bestDelayOverlayOpacity,
  sharedBoxplotYAxis,
  sharedScatterYAxisByDensity,
  sharedDelayAxisByDensity
}) {
  const doneRuns = useMemo(() => (history ?? []).filter((item) => item.status === "done"), [history]);

  return (
    <div className={`compare-column compare-column--${sideLabel.toLowerCase()}`}>
      <div className="compare-column-header">
        <span className={`compare-side-badge compare-side-badge--${sideLabel.toLowerCase()}`}>{sideLabel}</span>
        {compareKind === "batch" ? (
          <label className="field-label compare-picker-label">
            Batch result
            <select value={batchId} onChange={(e) => onBatchIdChange(e.target.value)}>
              <option value="">— Select batch result —</option>
              {(batchList ?? []).map((item) => (
                <option key={item.batch_run_id} value={item.batch_run_id}>
                  {item.result_label || item.batch_name} ({item.successful}/{item.total_topologies})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="field-label compare-picker-label">
              Topology
              <select value={topoId} onChange={(e) => onTopoIdChange(e.target.value)}>
                <option value="">— Select topology —</option>
                {(singleTopologyIds ?? []).map((id) => (
                  <option key={id} value={id}>
                    {topologyNameById(id) || id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label compare-picker-label">
              Run
              <select
                value={runId}
                onChange={(e) => onRunIdChange(e.target.value)}
                disabled={!topoId || historyLoading}
              >
                <option value="">— Select run —</option>
                {doneRuns.map((run) => (
                  <option key={run.run_id} value={run.run_id}>
                    {formatRunOption(run)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <div className="compare-column-body">
        {compareKind === "batch" ? (
          !batchId ? (
            <div className="empty-topology-state compare-empty-hint">Select a batch result to compare.</div>
          ) : batchLoading ? (
            <div className="empty-topology-state">Loading…</div>
          ) : batchError ? (
            <div className="empty-topology-state batch-results-error">
              <p>{batchError}</p>
            </div>
          ) : (
            <BatchResultDetailBody
              result={batchResult}
              artifactFilter={artifactFilter}
              onArtifactFilterChange={onArtifactFilterChange}
              bestDelayOverlayOpacity={bestDelayOverlayOpacity}
              compact
              boxplotYAxis={sharedBoxplotYAxis}
              boxplotFitWidth
              scatterYAxisByDensity={sharedScatterYAxisByDensity}
              delayAxisByDensity={sharedDelayAxisByDensity}
            />
          )
        ) : !topoId ? (
          <div className="empty-topology-state compare-empty-hint">Select a topology.</div>
        ) : historyLoading ? (
          <div className="empty-topology-state">Loading runs…</div>
        ) : historyError ? (
          <div className="empty-topology-state batch-results-error">
            <p>{historyError}</p>
          </div>
        ) : delayLoading ? (
          <div className="empty-topology-state">Loading run data…</div>
        ) : (
          <SingleRunCompareCard
            run={selectedRun}
            topologyName={topologyNameById(topoId)}
            delaySeries={delaySeries}
          />
        )}
      </div>
    </div>
  );
}

export default function CompareWorkspace({
  apiBase,
  batchRunResults,
  isLoadingBatchRunResults,
  batchRunResultsError,
  onRetryBatchRunResults,
  singleRunTopologyIds,
  topologyNameById,
  bestDelayOverlayOpacity = 1,
  onCompareExportChange
}) {
  const restoredCompare = useMemo(() => readCompareWorkspaceSession(), []);
  const [compareKind, setCompareKind] = useState(() => restoredCompare?.compareKind ?? "batch");
  const isChartMode = compareKind === "chart";
  const isBatchMode = compareKind === "batch";

  const [batchIdA, setBatchIdA] = useState(() => restoredCompare?.batchIdA ?? "");
  const [batchIdB, setBatchIdB] = useState(() => restoredCompare?.batchIdB ?? "");
  const [resultA, setResultA] = useState(null);
  const [resultB, setResultB] = useState(null);
  const [loadingA, setLoadingA] = useState(false);
  const [loadingB, setLoadingB] = useState(false);
  const [errorA, setErrorA] = useState(null);
  const [errorB, setErrorB] = useState(null);
  const [filterA, setFilterA] = useState(() => restoredCompare?.filterA ?? "all");
  const [filterB, setFilterB] = useState(() => restoredCompare?.filterB ?? "all");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeCompareWorkspaceSession({ compareKind, batchIdA, batchIdB, filterA, filterB });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [compareKind, batchIdA, batchIdB, filterA, filterB]);

  const [topoIdA, setTopoIdA] = useState("");
  const [topoIdB, setTopoIdB] = useState("");
  const [runIdA, setRunIdA] = useState("");
  const [runIdB, setRunIdB] = useState("");
  const [historyA, setHistoryA] = useState([]);
  const [historyB, setHistoryB] = useState([]);
  const [historyLoadingA, setHistoryLoadingA] = useState(false);
  const [historyLoadingB, setHistoryLoadingB] = useState(false);
  const [historyErrorA, setHistoryErrorA] = useState(null);
  const [historyErrorB, setHistoryErrorB] = useState(null);
  const [delayA, setDelayA] = useState([]);
  const [delayB, setDelayB] = useState([]);
  const [delayLoadingA, setDelayLoadingA] = useState(false);
  const [delayLoadingB, setDelayLoadingB] = useState(false);

  const loadBatchSide = useCallback(
    async (batchRunId, setResult, setLoading, setError) => {
      if (!batchRunId) {
        setResult(null);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await fetchBatchResultDetail(apiBase, batchRunId);
        setResult(data);
      } catch (err) {
        setResult(null);
        setError(err?.message || "Failed to load.");
      } finally {
        setLoading(false);
      }
    },
    [apiBase]
  );

  useEffect(() => {
    if (compareKind !== "batch") return;
    loadBatchSide(batchIdA, setResultA, setLoadingA, setErrorA);
  }, [compareKind, batchIdA, loadBatchSide]);

  useEffect(() => {
    if (compareKind !== "batch") return;
    loadBatchSide(batchIdB, setResultB, setLoadingB, setErrorB);
  }, [compareKind, batchIdB, loadBatchSide]);

  const loadHistorySide = useCallback(
    async (topologyId, setHistory, setLoading, setError, setRunId) => {
      if (!topologyId) {
        setHistory([]);
        setError(null);
        setRunId("");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await fetchRunHistory(apiBase, topologyId);
        setHistory(data);
        const done = data.filter((item) => item.status === "done");
        setRunId((prev) => (prev && done.some((r) => r.run_id === prev) ? prev : done[0]?.run_id ?? ""));
      } catch (err) {
        setHistory([]);
        setError(err?.message || "Failed to load history.");
        setRunId("");
      } finally {
        setLoading(false);
      }
    },
    [apiBase]
  );

  useEffect(() => {
    if (compareKind !== "single") return;
    loadHistorySide(topoIdA, setHistoryA, setHistoryLoadingA, setHistoryErrorA, setRunIdA);
  }, [compareKind, topoIdA, loadHistorySide]);

  useEffect(() => {
    if (compareKind !== "single") return;
    loadHistorySide(topoIdB, setHistoryB, setHistoryLoadingB, setHistoryErrorB, setRunIdB);
  }, [compareKind, topoIdB, loadHistorySide]);

  useEffect(() => {
    if (compareKind !== "single" || !runIdA) {
      setDelayA([]);
      return;
    }
    let cancelled = false;
    setDelayLoadingA(true);
    fetchDelayArtifact(apiBase, runIdA)
      .then((payload) => {
        if (!cancelled) setDelayA(delaySeriesFromArtifactPayload(payload));
      })
      .finally(() => {
        if (!cancelled) setDelayLoadingA(false);
      });
    return () => {
      cancelled = true;
    };
  }, [compareKind, runIdA, apiBase]);

  useEffect(() => {
    if (compareKind !== "single" || !runIdB) {
      setDelayB([]);
      return;
    }
    let cancelled = false;
    setDelayLoadingB(true);
    fetchDelayArtifact(apiBase, runIdB)
      .then((payload) => {
        if (!cancelled) setDelayB(delaySeriesFromArtifactPayload(payload));
      })
      .finally(() => {
        if (!cancelled) setDelayLoadingB(false);
      });
    return () => {
      cancelled = true;
    };
  }, [compareKind, runIdB, apiBase]);

  const selectedRunA = useMemo(
    () => historyA.find((item) => item.run_id === runIdA) ?? null,
    [historyA, runIdA]
  );
  const selectedRunB = useMemo(
    () => historyB.find((item) => item.run_id === runIdB) ?? null,
    [historyB, runIdB]
  );

  const sharedBoxplotYAxis = useMemo(() => {
    if (compareKind !== "batch") return null;
    return boxplotYAxisFromDensityGroups(resultA?.density_groups, resultB?.density_groups);
  }, [compareKind, resultA, resultB]);

  const sharedScatterYAxisByDensity = useMemo(() => {
    if (compareKind !== "batch") return null;
    return scatterYAxisByDensityFromResults(resultA, resultB);
  }, [compareKind, resultA, resultB]);

  const sharedDelayAxisByDensity = useMemo(() => {
    if (compareKind !== "batch") return null;
    return delayAxisByDensityFromResults(resultA, resultB);
  }, [compareKind, resultA, resultB]);

  useEffect(() => {
    if (!onCompareExportChange || compareKind !== "chart") return;
    onCompareExportChange({ compareKind: "chart" });
  }, [onCompareExportChange, compareKind]);

  useEffect(() => {
    if (!onCompareExportChange || compareKind === "chart") return;
    const compareChartInput = {
      ready: compareKind === "batch" && !!resultA && !!resultB,
      compareKind,
      resultA,
      resultB,
      batchIdA,
      batchIdB
    };
    onCompareExportChange({
      compareKind,
      resultA,
      resultB,
      batchIdA,
      batchIdB,
      selectedRunA,
      selectedRunB,
      delayA,
      delayB,
      compareChartInput,
      topoNameA: topologyNameById?.(topoIdA) ?? topoIdA,
      topoNameB: topologyNameById?.(topoIdB) ?? topoIdB
    });
  }, [
    onCompareExportChange,
    compareKind,
    resultA,
    resultB,
    batchIdA,
    batchIdB,
    selectedRunA,
    selectedRunB,
    delayA,
    delayB,
    topoIdA,
    topoIdB,
    topologyNameById
  ]);

  return (
    <div className="compare-workspace">
      <div className="compare-toolbar">
        <div className="generate-mode-toggle compare-kind-toggle">
          <button
            type="button"
            className={compareKind === "batch" ? "active" : ""}
            onClick={() => setCompareKind("batch")}
          >
            Batch results
          </button>
          <button
            type="button"
            className={compareKind === "single" ? "active" : ""}
            onClick={() => setCompareKind("single")}
          >
            Single topology results
          </button>
          <button
            type="button"
            className={compareKind === "chart" ? "active" : ""}
            onClick={() => setCompareKind("chart")}
          >
            Chart
          </button>
        </div>
        {(isBatchMode || isChartMode) && isLoadingBatchRunResults ? (
          <span className="muted compare-toolbar-hint">Loading batch list…</span>
        ) : null}
        {(isBatchMode || isChartMode) && batchRunResultsError ? (
          <button type="button" className="secondary-cta small" onClick={onRetryBatchRunResults}>
            Retry list
          </button>
        ) : null}
      </div>

      {(isBatchMode || isChartMode) && batchRunResultsError ? (
        <div className="empty-topology-state batch-results-error compare-list-error">
          <p>{batchRunResultsError}</p>
        </div>
      ) : null}

      {isChartMode ? (
        <CompareChartWorkspace
          apiBase={apiBase}
          batchRunResults={batchRunResults}
          isLoadingBatchRunResults={isLoadingBatchRunResults}
          batchRunResultsError={batchRunResultsError}
          onRetryBatchRunResults={onRetryBatchRunResults}
        />
      ) : (
      <div className="compare-columns">
        <CompareColumn
          sideLabel="A"
          compareKind={compareKind}
          batchList={batchRunResults}
          batchId={batchIdA}
          onBatchIdChange={setBatchIdA}
          batchResult={resultA}
          batchLoading={loadingA}
          batchError={errorA}
          singleTopologyIds={singleRunTopologyIds}
          topologyNameById={topologyNameById}
          topoId={topoIdA}
          onTopoIdChange={setTopoIdA}
          runId={runIdA}
          onRunIdChange={setRunIdA}
          history={historyA}
          historyLoading={historyLoadingA}
          historyError={historyErrorA}
          selectedRun={selectedRunA}
          delaySeries={delayA}
          delayLoading={delayLoadingA}
          artifactFilter={filterA}
          onArtifactFilterChange={setFilterA}
          bestDelayOverlayOpacity={bestDelayOverlayOpacity}
          sharedBoxplotYAxis={sharedBoxplotYAxis}
          sharedScatterYAxisByDensity={sharedScatterYAxisByDensity}
          sharedDelayAxisByDensity={sharedDelayAxisByDensity}
        />
        <CompareColumn
          sideLabel="B"
          compareKind={compareKind}
          batchList={batchRunResults}
          batchId={batchIdB}
          onBatchIdChange={setBatchIdB}
          batchResult={resultB}
          batchLoading={loadingB}
          batchError={errorB}
          singleTopologyIds={singleRunTopologyIds}
          topologyNameById={topologyNameById}
          topoId={topoIdB}
          onTopoIdChange={setTopoIdB}
          runId={runIdB}
          onRunIdChange={setRunIdB}
          history={historyB}
          historyLoading={historyLoadingB}
          historyError={historyErrorB}
          selectedRun={selectedRunB}
          delaySeries={delayB}
          delayLoading={delayLoadingB}
          artifactFilter={filterB}
          onArtifactFilterChange={setFilterB}
          bestDelayOverlayOpacity={bestDelayOverlayOpacity}
          sharedBoxplotYAxis={sharedBoxplotYAxis}
          sharedScatterYAxisByDensity={sharedScatterYAxisByDensity}
          sharedDelayAxisByDensity={sharedDelayAxisByDensity}
        />
      </div>
      )}
    </div>
  );
}

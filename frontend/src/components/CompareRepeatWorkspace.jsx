import { useEffect, useMemo, useRef, useState } from "react";
import BatchResultDetailBody, { linearAxisTicks } from "./BatchResultDetailBody.jsx";

function isRepeatSingleTopologyBatch(item) {
  const unique = Number(item?.unique_topology_count);
  const total = Number(item?.total_topologies);
  if (Number.isFinite(unique) && unique === 1 && Number.isFinite(total) && total >= 2) return true;
  return false;
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }
  return sortedValues[base];
}

function computeBoxStats(values) {
  const nums = values.filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  if (!nums.length) return null;
  return {
    min: nums[0],
    q1: quantile(nums, 0.25),
    median: quantile(nums, 0.5),
    q3: quantile(nums, 0.75),
    max: nums[nums.length - 1],
    mean: nums.reduce((sum, v) => sum + v, 0) / nums.length,
    n: nums.length
  };
}

function meanOf(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

/** Sample standard deviation (n−1). null if fewer than 2 values. */
function sampleStdDev(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const mean = nums.reduce((sum, v) => sum + v, 0) / nums.length;
  const variance = nums.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

/**
 * 95% CI for the mean of last_delay: mean ± 1.96 · s/√n (normal approx).
 * Returns { low, high } or null.
 */
function meanConfidenceInterval95(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const mean = nums.reduce((sum, v) => sum + v, 0) / nums.length;
  const std = sampleStdDev(nums);
  if (!Number.isFinite(std)) return null;
  const margin = 1.96 * (std / Math.sqrt(nums.length));
  return { low: mean - margin, high: mean + margin, mean, n: nums.length };
}

function formatCiRange(ci, digits = 2) {
  if (!ci || !Number.isFinite(ci.low) || !Number.isFinite(ci.high)) return null;
  return `[${formatStat(ci.low, digits)},${formatStat(ci.high, digits)}]`;
}

const SUMMARY_COLUMNS = [
  { key: "idx", label: "#", defaultWidth: 48, title: "Row index (0-based, follows current sort)" },
  { key: "batch", label: "Batch", defaultWidth: 220 },
  { key: "algorithm", label: "Algorithm", defaultWidth: 100 },
  { key: "preset", label: "Preset", defaultWidth: 140 },
  { key: "topology", label: "Topology", defaultWidth: 140 },
  {
    key: "converged",
    label: "convergenced runs",
    defaultWidth: 140,
    title: "Runs where last_delay = best_delay / total runs"
  },
  {
    key: "delayRange",
    label: "delay sequence range",
    defaultWidth: 150,
    title: "Min–max delay found across delay_per_episode / path delays (and last/best if needed)"
  },
  { key: "meanLast", label: "Mean last", defaultWidth: 100 },
  {
    key: "stdLast",
    label: "Std deviation",
    defaultWidth: 110,
    title: "Sample std. deviation of last_delay across repeated runs"
  },
  {
    key: "ci95",
    label: "95% CI",
    defaultWidth: 120,
    title: "95% confidence interval of mean last_delay (mean ± 1.96·s/√n)"
  },
  { key: "lb", label: "LB", defaultWidth: 70 }
];

function defaultSummaryColWidths() {
  return Object.fromEntries(SUMMARY_COLUMNS.map((col) => [col.key, col.defaultWidth]));
}

/** First number in label for numeric sort; falls back to full string. */
function batchNumericSortKey(meta) {
  const label = String(meta?.result_label || meta?.batch_name || "");
  const match = label.match(/-?\d+(?:\.\d+)?/);
  if (match) return { kind: "num", value: Number(match[0]), label };
  return { kind: "str", value: label, label };
}

function compareBatchNumeric(a, b) {
  const ka = batchNumericSortKey(a);
  const kb = batchNumericSortKey(b);
  if (ka.kind === "num" && kb.kind === "num" && ka.value !== kb.value) {
    return ka.value - kb.value;
  }
  return ka.label.localeCompare(kb.label, undefined, { numeric: true, sensitivity: "base" });
}

const BATCH_SORT_MODES = ["default", "asc", "desc"];

function nextBatchSortMode(mode) {
  const idx = BATCH_SORT_MODES.indexOf(mode);
  return BATCH_SORT_MODES[(idx + 1) % BATCH_SORT_MODES.length];
}

function batchSortIcon(mode) {
  if (mode === "asc") return "↑";
  if (mode === "desc") return "↓";
  return "↕";
}

function batchSortTitle(mode) {
  if (mode === "asc") return "Sorted ascending (click for descending)";
  if (mode === "desc") return "Sorted descending (click for default)";
  return "Default order (click to sort ascending by number)";
}

function delaysFromResult(result, key) {
  return (result?.topologies ?? [])
    .filter((t) => t.status === "done")
    .map((t) => Number(t[key]))
    .filter((n) => Number.isFinite(n));
}

/** Runs where last_delay equals best_delay (treated as converged). */
function countConvergedRuns(result) {
  return (result?.topologies ?? []).filter((t) => {
    if (t.status !== "done") return false;
    const last = Number(t.last_delay);
    const best = Number(t.best_delay);
    return Number.isFinite(last) && Number.isFinite(best) && last === best;
  }).length;
}

/** Min–max delay values found across repeated runs (sequence / paths / outcomes). */
function delaySequenceRangeLabel(result) {
  const delays = new Set();
  (result?.topologies ?? []).forEach((topo) => {
    if (topo.status && topo.status !== "done") return;
    const map = topo.paths_count_by_delay;
    if (map && typeof map === "object") {
      Object.keys(map).forEach((key) => {
        const d = Number(key);
        if (Number.isFinite(d)) delays.add(d);
      });
    }
    (topo.delay_per_episode ?? []).forEach((value) => {
      const d = Number(value);
      if (Number.isFinite(d)) delays.add(d);
    });
    [topo.last_delay, topo.best_delay].forEach((value) => {
      const d = Number(value);
      if (Number.isFinite(d)) delays.add(d);
    });
  });
  const sorted = Array.from(delays).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  return `[${lo},${hi}]`;
}

async function fetchBatchResultDetail(apiBase, batchRunId) {
  const response = await fetch(`${apiBase}/runs/batch/${batchRunId}/result`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || "Could not load batch result.");
  }
  return data;
}

const SERIES = [
  { key: "last_delay", label: "last_delay", color: "#4E79A7", offset: -18 },
  { key: "best_delay", label: "best_delay", color: "#59A14F", offset: 0 },
  { key: "lower_bound", label: "lower_bound", color: "#E15759", offset: 18 }
];

function RepeatBatchCompareChart({ rows }) {
  if (!rows.length) return null;
  const height = 300;
  const pad = { left: 62, right: 24, top: 36, bottom: 72 };
  const plotH = height - pad.top - pad.bottom;
  const allValues = [];
  rows.forEach((row) => {
    SERIES.forEach((s) => {
      const stats = row.statsByKey[s.key];
      if (!stats) return;
      [stats.min, stats.max].forEach((v) => {
        if (Number.isFinite(v)) allValues.push(v);
      });
    });
  });
  if (!allValues.length) {
    return (
      <div className="batch-chart-card">
        <h4>Repeat batches — delay boxplot</h4>
        <p className="muted chart-hint">No delay values in selected batches.</p>
      </div>
    );
  }
  const domainMin = Math.floor(Math.min(...allValues));
  const domainMax = Math.ceil(Math.max(...allValues));
  const span = domainMax - domainMin || 1;
  const yOf = (v) => height - pad.bottom - ((v - domainMin) / span) * plotH;
  const yTicks = linearAxisTicks(domainMin, domainMax, 5).map((t) => Math.round(t));
  const colSlot = 140;
  const width = Math.max(360, pad.left + pad.right + rows.length * colSlot);
  const colW = (width - pad.left - pad.right) / Math.max(1, rows.length);

  return (
    <div className="batch-chart-card">
      <h4>Repeat batches — delay boxplot</h4>
      <p className="muted chart-hint">One column per selected batch (distribution across repeated runs).</p>
      <div className="chart-scroll chart-scroll--fit">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="batch-chart-svg batch-chart-svg--fit"
          preserveAspectRatio="xMidYMid meet"
        >
          <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
          <text
            x={18}
            y={pad.top + plotH / 2}
            className="chart-axis-text chart-axis-ylabel"
            transform={`rotate(-90 18 ${pad.top + plotH / 2})`}
            textAnchor="middle"
          >
            Delay (timeslots)
          </text>
          {yTicks.map((tv) => {
            const y = yOf(tv);
            return (
              <g key={`y-${tv}`}>
                <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#e8eaf5" strokeWidth="1" />
                <text x={pad.left - 8} y={y + 4} textAnchor="end" className="chart-axis-text">
                  {tv}
                </text>
              </g>
            );
          })}
          {rows.map((row, idx) => {
            const cx = pad.left + colW * idx + colW / 2;
            const shortLabel =
              row.label.length > 18 ? `${row.label.slice(0, 16)}…` : row.label;
            return (
              <g key={row.batchRunId}>
                <text x={cx} y={height - 28} textAnchor="middle" className="chart-axis-text">
                  {shortLabel}
                </text>
                <title>{row.label}</title>
                {SERIES.map((s) => {
                  const stats = row.statsByKey[s.key];
                  if (!stats) return null;
                  const x = cx + s.offset;
                  const yMin = yOf(stats.min);
                  const yMax = yOf(stats.max);
                  const yQ1 = yOf(stats.q1);
                  const yQ3 = yOf(stats.q3);
                  const yMed = yOf(stats.median);
                  const boxW = 10;
                  return (
                    <g key={s.key}>
                      <line x1={x} x2={x} y1={yMin} y2={yMax} stroke={s.color} strokeWidth="1.5" />
                      <line x1={x - 4} x2={x + 4} y1={yMin} y2={yMin} stroke={s.color} strokeWidth="1.5" />
                      <line x1={x - 4} x2={x + 4} y1={yMax} y2={yMax} stroke={s.color} strokeWidth="1.5" />
                      <rect
                        x={x - boxW / 2}
                        y={Math.min(yQ1, yQ3)}
                        width={boxW}
                        height={Math.max(2, Math.abs(yQ3 - yQ1))}
                        fill={s.color}
                        fillOpacity="0.25"
                        stroke={s.color}
                        strokeWidth="1.25"
                      />
                      <line x1={x - boxW / 2} x2={x + boxW / 2} y1={yMed} y2={yMed} stroke={s.color} strokeWidth="2" />
                      <title>{`${row.label} · ${s.label}: n=${stats.n}, med=${stats.median?.toFixed?.(2) ?? stats.median}`}</title>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="batch-chart-legend">
        {SERIES.map((s) => (
          <span key={s.key} className="batch-chart-legend-item">
            <span className="batch-chart-legend-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatStat(v, digits = 2) {
  if (!Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

export default function CompareRepeatWorkspace({
  apiBase,
  batchRunResults,
  isLoadingBatchRunResults,
  batchRunResultsError,
  onRetryBatchRunResults,
  bestDelayOverlayOpacity = 1
}) {
  const repeatBatches = useMemo(
    () => (batchRunResults ?? []).filter(isRepeatSingleTopologyBatch),
    [batchRunResults]
  );

  const [selectedIds, setSelectedIds] = useState([]);
  const [resultsById, setResultsById] = useState({});
  const [loadingIds, setLoadingIds] = useState({});
  const [errorsById, setErrorsById] = useState({});
  const [artifactFilter, setArtifactFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [summaryColWidths, setSummaryColWidths] = useState(defaultSummaryColWidths);
  const [batchSortMode, setBatchSortMode] = useState("default");
  const inFlightRef = useRef(new Set());
  const colResizeRef = useRef(null);

  useEffect(() => {
    const onMove = (event) => {
      const drag = colResizeRef.current;
      if (!drag) return;
      const delta = event.clientX - drag.startX;
      const next = Math.max(60, drag.startWidth + delta);
      setSummaryColWidths((prev) =>
        prev[drag.key] === next ? prev : { ...prev, [drag.key]: next }
      );
    };
    const onUp = () => {
      if (!colResizeRef.current) return;
      colResizeRef.current = null;
      document.body.classList.remove("panel-resize-active");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("panel-resize-active");
    };
  }, []);

  function startColResize(event, key) {
    event.preventDefault();
    event.stopPropagation();
    colResizeRef.current = {
      key,
      startX: event.clientX,
      startWidth: summaryColWidths[key] ?? 100
    };
    document.body.classList.add("panel-resize-active");
  }

  const summaryTableWidth = useMemo(
    () => SUMMARY_COLUMNS.reduce((sum, col) => sum + (summaryColWidths[col.key] ?? col.defaultWidth), 0),
    [summaryColWidths]
  );

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => repeatBatches.some((b) => b.batch_run_id === id)));
  }, [repeatBatches]);

  useEffect(() => {
    selectedIds.forEach((batchRunId) => {
      if (resultsById[batchRunId] || errorsById[batchRunId] || inFlightRef.current.has(batchRunId)) return;
      inFlightRef.current.add(batchRunId);
      setLoadingIds((prev) => ({ ...prev, [batchRunId]: true }));
      fetchBatchResultDetail(apiBase, batchRunId)
        .then((data) => {
          setResultsById((prev) => ({ ...prev, [batchRunId]: data }));
        })
        .catch((err) => {
          setErrorsById((prev) => ({ ...prev, [batchRunId]: err?.message || "Failed to load." }));
        })
        .finally(() => {
          inFlightRef.current.delete(batchRunId);
          setLoadingIds((prev) => {
            const next = { ...prev };
            delete next[batchRunId];
            return next;
          });
        });
    });
  }, [selectedIds, apiBase, resultsById, errorsById]);

  function toggleId(batchRunId) {
    setSelectedIds((prev) => {
      if (prev.includes(batchRunId)) {
        return prev.filter((id) => id !== batchRunId);
      }
      setErrorsById((errs) => {
        if (!errs[batchRunId]) return errs;
        const next = { ...errs };
        delete next[batchRunId];
        return next;
      });
      return [...prev, batchRunId];
    });
  }

  function selectAll() {
    setSelectedIds(repeatBatches.map((b) => b.batch_run_id));
  }

  function clearSelection() {
    setSelectedIds([]);
    setExpandedId(null);
  }

  const selectedMeta = useMemo(
    () => selectedIds.map((id) => repeatBatches.find((b) => b.batch_run_id === id)).filter(Boolean),
    [selectedIds, repeatBatches]
  );

  const sortedSelectedMeta = useMemo(() => {
    if (batchSortMode === "default") return selectedMeta;
    const sorted = [...selectedMeta].sort(compareBatchNumeric);
    return batchSortMode === "desc" ? sorted.reverse() : sorted;
  }, [selectedMeta, batchSortMode]);

  const mixedTopologies = useMemo(() => {
    const ids = new Set(selectedMeta.map((b) => b.repeat_topology_id).filter(Boolean));
    return ids.size > 1;
  }, [selectedMeta]);

  const compareRows = useMemo(() => {
    return sortedSelectedMeta
      .map((meta) => {
        const result = resultsById[meta.batch_run_id];
        if (!result) return null;
        const statsByKey = {};
        SERIES.forEach((s) => {
          statsByKey[s.key] = computeBoxStats(delaysFromResult(result, s.key));
        });
        return {
          batchRunId: meta.batch_run_id,
          label: meta.result_label || meta.batch_name,
          meta,
          result,
          statsByKey,
          convergedRuns: countConvergedRuns(result),
          totalRuns: Number(result.total_topologies) || (result.topologies ?? []).length || 0,
          delaySequenceRange: delaySequenceRangeLabel(result),
          meanLast: meanOf(delaysFromResult(result, "last_delay")),
          stdLast: sampleStdDev(delaysFromResult(result, "last_delay")),
          ci95: formatCiRange(meanConfidenceInterval95(delaysFromResult(result, "last_delay"))),
          lowerBound: meanOf(delaysFromResult(result, "lower_bound"))
        };
      })
      .filter(Boolean);
  }, [sortedSelectedMeta, resultsById]);

  const anyLoading = selectedIds.some((id) => loadingIds[id]);

  return (
    <div className="compare-repeat-workspace">
      <div className="compare-repeat-picker">
        <div className="compare-repeat-picker-header">
          <div>
            <h4 className="compare-repeat-picker-title">Select repeat-1-topo batches</h4>
            <p className="muted compare-repeat-picker-sub">
              Only batches that ran the same topology ≥2 times. Select any number.
            </p>
          </div>
          <div className="compare-repeat-picker-actions">
            <button type="button" className="secondary-cta small" onClick={selectAll} disabled={!repeatBatches.length}>
              Select all ({repeatBatches.length})
            </button>
            <button type="button" className="secondary-cta small" onClick={clearSelection} disabled={!selectedIds.length}>
              Clear
            </button>
          </div>
        </div>

        {isLoadingBatchRunResults ? (
          <div className="empty-topology-state">Loading batch list…</div>
        ) : batchRunResultsError ? (
          <div className="empty-topology-state batch-results-error">
            <p>{batchRunResultsError}</p>
            <button type="button" className="secondary-cta" onClick={onRetryBatchRunResults}>
              Retry
            </button>
          </div>
        ) : !repeatBatches.length ? (
          <div className="empty-topology-state">
            No repeat-1-topology batches yet. Use Run Multi → Repeat one topology (≥2 runs).
          </div>
        ) : (
          <div className="compare-repeat-batch-list ui-scroll">
            {repeatBatches.map((batch) => {
              const checked = selectedIds.includes(batch.batch_run_id);
              const topoLabel = batch.repeat_topology_name || batch.repeat_topology_id || "—";
              return (
                <label key={batch.batch_run_id} className={`compare-repeat-batch-row${checked ? " is-selected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleId(batch.batch_run_id)}
                  />
                  <span className="compare-repeat-batch-main">
                    <span className="compare-repeat-batch-name">{batch.result_label || batch.batch_name}</span>
                    <span className="muted compare-repeat-batch-meta">
                      {batch.algorithm_id} · {batch.preset_name || batch.preset_id} · topo {topoLabel} ·{" "}
                      {batch.successful}/{batch.total_topologies} ok · {batch.batch_status}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {!selectedIds.length ? (
        <div className="empty-topology-state compare-empty-hint">
          Tick one or more repeat batches above to compare.
        </div>
      ) : (
        <div className="compare-repeat-body">
          {mixedTopologies ? (
            <p className="compare-warning muted">
              Selected batches use different topologies — metrics are still shown side by side.
            </p>
          ) : null}
          {anyLoading ? <p className="muted">Loading selected batch results…</p> : null}

          <div className="table-scroll">
            <table
              className="node-edit-table compare-repeat-summary-table compare-repeat-summary-table--resizable"
              style={{ width: summaryTableWidth, minWidth: summaryTableWidth }}
            >
              <colgroup>
                {SUMMARY_COLUMNS.map((col) => (
                  <col key={col.key} style={{ width: summaryColWidths[col.key] ?? col.defaultWidth }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {SUMMARY_COLUMNS.map((col) => (
                    <th key={col.key} title={col.title ?? col.label}>
                      <span className="compare-repeat-th-label">
                        {col.key === "batch" ? (
                          <button
                            type="button"
                            className={`compare-repeat-sort-btn${batchSortMode !== "default" ? " is-active" : ""}`}
                            title={batchSortTitle(batchSortMode)}
                            aria-label={batchSortTitle(batchSortMode)}
                            onClick={() => setBatchSortMode((mode) => nextBatchSortMode(mode))}
                          >
                            <span>{col.label}</span>
                            <span className="compare-repeat-sort-icon" aria-hidden="true">
                              {batchSortIcon(batchSortMode)}
                            </span>
                          </button>
                        ) : (
                          col.label
                        )}
                      </span>
                      <span
                        className="compare-repeat-col-resizer"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${col.label} column`}
                        onPointerDown={(event) => startColResize(event, col.key)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedSelectedMeta.map((meta, idx) => {
                  const row = compareRows.find((r) => r.batchRunId === meta.batch_run_id);
                  const err = errorsById[meta.batch_run_id];
                  const loading = loadingIds[meta.batch_run_id];
                  return (
                    <tr key={meta.batch_run_id}>
                      <td>{idx}</td>
                      <td title={meta.result_label}>{meta.result_label || meta.batch_name}</td>
                      <td>{meta.algorithm_id}</td>
                      <td>{meta.preset_name || meta.preset_id}</td>
                      <td>{meta.repeat_topology_name || meta.repeat_topology_id || "—"}</td>
                      <td>
                        {loading
                          ? "…"
                          : err
                            ? "err"
                            : row
                              ? `${row.convergedRuns}/${row.totalRuns}`
                              : "—"}
                      </td>
                      <td>{loading ? "…" : err ? "err" : row?.delaySequenceRange ?? "—"}</td>
                      <td>{loading ? "…" : err ? "err" : formatStat(row?.meanLast)}</td>
                      <td>{loading ? "…" : err ? "err" : formatStat(row?.stdLast)}</td>
                      <td>{loading ? "…" : err ? "err" : row?.ci95 ?? "—"}</td>
                      <td>{loading ? "…" : err ? "err" : formatStat(row?.lowerBound, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <RepeatBatchCompareChart rows={compareRows} />

          <div className="compare-repeat-details">
            <h4 className="chart-subheading">Batch details</h4>
            {sortedSelectedMeta.map((meta) => {
              const result = resultsById[meta.batch_run_id];
              const err = errorsById[meta.batch_run_id];
              const loading = loadingIds[meta.batch_run_id];
              const open = expandedId === meta.batch_run_id;
              return (
                <div key={meta.batch_run_id} className="compare-repeat-detail-card">
                  <button
                    type="button"
                    className="compare-repeat-detail-toggle"
                    onClick={() => setExpandedId(open ? null : meta.batch_run_id)}
                  >
                    <span>{open ? "▾" : "▸"}</span>
                    <span>{meta.result_label || meta.batch_name}</span>
                    <span className="muted">
                      {loading ? "loading…" : err ? err : result ? `${result.successful} ok` : ""}
                    </span>
                  </button>
                  {open && result ? (
                    <div className="compare-repeat-detail-body">
                      <BatchResultDetailBody
                        result={result}
                        artifactFilter={artifactFilter}
                        onArtifactFilterChange={setArtifactFilter}
                        bestDelayOverlayOpacity={bestDelayOverlayOpacity}
                        compact
                        boxplotFitWidth
                      />
                    </div>
                  ) : null}
                  {open && !result && !loading && err ? (
                    <p className="batch-results-error">{err}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

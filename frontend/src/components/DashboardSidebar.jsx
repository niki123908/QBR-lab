import { useEffect, useMemo, useState } from "react";
import QueueWorkersPanel from "./QueueWorkersPanel";
import { sortBatchesWithTopologies } from "../utils/topologyNameSort.js";

export default function DashboardSidebar({
  activeMenu,
  setActiveMenu,
  batches,
  selectedTopologyId,
  onSelectTopology,
  onSelectBatch,
  onGoHome,
  queueSnapshot,
  managedWorkers,
  onSpawnWorker,
  onKillWorker,
  isSpawningWorker,
  killingWorkerId,
  onWorkersExpandedChange
}) {
  const [expandedBatchIds, setExpandedBatchIds] = useState({});
  const [workersExpanded, setWorkersExpanded] = useState(false);
  const sortedBatches = useMemo(() => sortBatchesWithTopologies(batches), [batches]);
  const totalTopologies = useMemo(
    () => sortedBatches.reduce((acc, batch) => acc + batch.topologies.length, 0),
    [sortedBatches]
  );
  const workerCount = Math.max(
    Array.isArray(managedWorkers) ? managedWorkers.filter((worker) => worker?.alive).length : 0,
    Number(queueSnapshot?.lane_count) || 0
  );

  useEffect(() => {
    onWorkersExpandedChange?.(workersExpanded);
  }, [workersExpanded, onWorkersExpandedChange]);

  function toggleBatch(batchId) {
    setExpandedBatchIds((prev) => ({
      ...prev,
      [batchId]: !prev[batchId]
    }));
  }

  return (
    <aside className="dashboard-sidebar">
      <section className="sidebar-card brand-card">
        <button type="button" className="brand-home-btn" onClick={onGoHome}>
          <span className="brand-title">QBR</span>
        </button>
        <div className="brand-subtitle">Broadcast Lab</div>
      </section>

      <section className="sidebar-card nav-card">
        <button
          type="button"
          className={`nav-item ${activeMenu === "home" ? "active" : ""}`}
          onClick={onGoHome}
        >
          Home
        </button>
        <button
          type="button"
          className={`nav-item ${activeMenu === "topologies" ? "active" : ""}`}
          onClick={() => setActiveMenu("topologies")}
        >
          Topologies
        </button>
        <button
          type="button"
          className={`nav-item ${activeMenu === "generate" ? "active" : ""}`}
          onClick={() => setActiveMenu("generate")}
        >
          Generate topo
        </button>
        <button
          type="button"
          className={`nav-item ${activeMenu === "run_topo" ? "active" : ""}`}
          onClick={() => setActiveMenu("run_topo")}
        >
          Run topo
        </button>
        <button
          type="button"
          className={`nav-item ${activeMenu === "run_multi" ? "active" : ""}`}
          onClick={() => setActiveMenu("run_multi")}
        >
          Run multi-topos
        </button>
        <button
          type="button"
          className={`nav-item ${activeMenu === "results" ? "active" : ""}`}
          onClick={() => setActiveMenu("results")}
        >
          Results
        </button>
        <button
          type="button"
          className={`nav-item ${activeMenu === "compare" ? "active" : ""}`}
          onClick={() => setActiveMenu("compare")}
        >
          Compare
        </button>
      </section>

      <section className="sidebar-card utility-card topology-list-card">
        <div className="card-title-row">
          <h3>Topology Tree</h3>
          <span className="chip">{totalTopologies}</span>
        </div>
        <ul>
          {sortedBatches.map((batch) => {
            const isExpanded = Boolean(expandedBatchIds[batch.batch_id]);
            return (
              <li key={batch.batch_id} className="batch-item">
                <button
                  type="button"
                  className="batch-toggle"
                  onClick={() => {
                    toggleBatch(batch.batch_id);
                    onSelectBatch(batch.batch_id);
                  }}
                >
                  <span>{isExpanded ? "▾" : "▸"}</span>
                  <span>{batch.batch_name}</span>
                  <span className="batch-count">{batch.topologies.length}</span>
                </button>
                {isExpanded ? (
                  <ul className="batch-topology-list">
                    {batch.topologies.map((topo) => (
                      <li
                        key={topo.topology_id}
                        className={selectedTopologyId === topo.topology_id ? "active" : ""}
                        onClick={() => onSelectTopology(topo)}
                      >
                        <span className="list-dot" />
                        {topo.topology_name}
                      </li>
                    ))}
                    {batch.topologies.length === 0 && <li className="empty-text">No data</li>}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {sortedBatches.length === 0 && <li className="empty-text">No data</li>}
        </ul>
      </section>

      <section className="sidebar-card utility-card sidebar-workers-card">
        <button
          type="button"
          className={`batch-toggle workers-dropdown-toggle${workersExpanded ? " active" : ""}`}
          onClick={() => setWorkersExpanded((value) => !value)}
          aria-expanded={workersExpanded}
        >
          <span>{workersExpanded ? "▾" : "▸"}</span>
          <span>Workers</span>
          <span className="workers-dropdown-meta">
            {(Number(queueSnapshot?.total_running) || 0) > 0 ? (
              <span className="chip workers-running-chip">{queueSnapshot.total_running} running</span>
            ) : null}
            <span className="batch-count">{workerCount}</span>
          </span>
        </button>
        {workersExpanded ? (
          <QueueWorkersPanel
            snapshot={queueSnapshot}
            managedWorkers={managedWorkers}
            onSpawnWorker={onSpawnWorker}
            onKillWorker={onKillWorker}
            isSpawningWorker={isSpawningWorker}
            killingWorkerId={killingWorkerId}
          />
        ) : null}
      </section>
    </aside>
  );
}

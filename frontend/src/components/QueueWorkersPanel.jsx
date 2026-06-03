import { useEffect, useMemo, useRef, useState } from "react";

function buildWorkerRows(managedWorkers, snapshot) {
  const laneByWorkerId = new Map();
  for (const lane of snapshot?.lanes ?? []) {
    if (lane?.worker_id) laneByWorkerId.set(lane.worker_id, lane);
  }

  const rows = [];
  const seen = new Set();

  for (const worker of managedWorkers ?? []) {
    if (!worker?.worker_id) continue;
    seen.add(worker.worker_id);
    rows.push({
      worker_id: worker.worker_id,
      managed: Boolean(worker.managed),
      alive: Boolean(worker.alive),
      pid: worker.pid ?? null,
      lane: laneByWorkerId.get(worker.worker_id) ?? { queued: [], running: null }
    });
  }

  for (const lane of snapshot?.lanes ?? []) {
    const workerId = lane?.worker_id;
    if (!workerId || seen.has(workerId)) continue;
    rows.push({
      worker_id: workerId,
      managed: false,
      alive: true,
      pid: null,
      lane
    });
  }

  const orphanLane = (snapshot?.lanes ?? []).find((lane) => !lane?.worker_id && ((lane?.queued?.length ?? 0) > 0 || lane?.running));
  if (orphanLane) {
    rows.push({
      worker_id: null,
      managed: false,
      alive: true,
      pid: null,
      lane: orphanLane,
      label: "Queue"
    });
  }

  return rows;
}

function WorkerQueueList({ items }) {
  if (!items.length) {
    return <li className="empty-text">No queued runs.</li>;
  }
  return items.map((item, itemIndex) => {
    const isRunning = item.status === "running" && itemIndex === items.length - 1;
    return (
      <li
        key={item.run_id}
        className={`queue-run-line ${isRunning ? "running" : "queued"} ${item.mode === "single" ? "single" : "batch"}`}
        title={`${item.topology_name} · ${item.mode}${item.batch_label ? ` · ${item.batch_label}` : ""}`}
      >
        <span className="queue-run-line-text">{item.topology_name}</span>
      </li>
    );
  });
}

function WorkerRow({ row, index, onKillWorker, killingWorkerId }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const items = [...(Array.isArray(row.lane?.queued) ? row.lane.queued : []), ...(row.lane?.running ? [row.lane.running] : [])];
  const label = row.label ?? (row.worker_id ? `Worker ${index + 1}` : "Queue");
  const runningItem = row.lane?.running ?? null;
  const canKill = open && row.managed && row.worker_id;

  useEffect(() => {
    if (!open || !panelRef.current) return;
    panelRef.current.scrollTop = panelRef.current.scrollHeight;
  }, [open, items.length]);

  return (
    <li className="worker-item batch-item">
      <div className={`worker-row-toolbar${open ? " worker-row-toolbar--open" : ""}`}>
        <button type="button" className="batch-toggle worker-toggle" onClick={() => setOpen((value) => !value)}>
          <span className="worker-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className={`worker-status-dot${row.alive === false ? " worker-status-dot--off" : ""}`} aria-hidden="true" />
          <span className="worker-toggle-copy">
            <span className="worker-toggle-label">{label}</span>
            {runningItem ? <span className="worker-toggle-subtitle">{runningItem.topology_name}</span> : null}
          </span>
          <span className="batch-count">{items.length}</span>
        </button>
        {canKill ? (
          <button
            type="button"
            className="worker-kill-btn"
            disabled={killingWorkerId === row.worker_id}
            onClick={() => onKillWorker(row.worker_id)}
            title={`Stop ${row.worker_id}`}
          >
            {killingWorkerId === row.worker_id ? "..." : "Stop"}
          </button>
        ) : null}
      </div>
      {open ? (
        <ul ref={panelRef} className="batch-topology-list worker-queue-list ui-scroll">
          <WorkerQueueList items={items} />
        </ul>
      ) : null}
    </li>
  );
}

export default function QueueWorkersPanel({
  snapshot,
  managedWorkers,
  onSpawnWorker,
  onKillWorker,
  isSpawningWorker,
  killingWorkerId
}) {
  const rows = useMemo(() => buildWorkerRows(managedWorkers, snapshot), [managedWorkers, snapshot]);
  const totalRunning = Number(snapshot?.total_running) || 0;
  const totalQueued = Number(snapshot?.total_queued) || 0;

  return (
    <div className="queue-workers-sidebar">
      <div className="sidebar-workers-summary">
        <div className="sidebar-workers-stat">
          <span className="sidebar-workers-stat-label">Running</span>
          <strong>{totalRunning}</strong>
        </div>
        <div className="sidebar-workers-stat">
          <span className="sidebar-workers-stat-label">Queued</span>
          <strong>{totalQueued}</strong>
        </div>
      </div>
      <ul className="workers-dropdown-list topology-list-card">
        {rows.length ? (
          rows.map((row, index) => (
            <WorkerRow
              key={row.worker_id ?? `worker-row-${index}`}
              row={row}
              index={index}
              onKillWorker={onKillWorker}
              killingWorkerId={killingWorkerId}
            />
          ))
        ) : (
          <li className="empty-text">No active workers.</li>
        )}
      </ul>
      <button type="button" className="workers-add-btn secondary-cta" disabled={isSpawningWorker} onClick={onSpawnWorker}>
        {isSpawningWorker ? "Starting worker..." : "+ Add worker"}
      </button>
    </div>
  );
}

export { buildWorkerRows };

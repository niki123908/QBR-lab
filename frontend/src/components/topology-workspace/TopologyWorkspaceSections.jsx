import { useEffect, useMemo, useState } from "react";

export function FocusedTopologySection({ title = "Topology detail", subtitle = "No selection", headerRight = null, children }) {
  return (
    <section className="hero-preview single-topology-mode">
      <div className="hero-preview-header">
        <div className="focused-topology-title-block">
          <h3>{title}</h3>
          <span>{subtitle}</span>
        </div>
        {headerRight ? <div className="focused-topology-header-actions">{headerRight}</div> : null}
      </div>
      <div className="hero-canvas-wrap full">{children}</div>
    </section>
  );
}

export function BatchSelectSection({ value, onChange, batches, placeholder = "Select a batch" }) {
  return (
    <section className="topology-main-filters run-topo-filter-row">
      <label className="field-label">
        Batch
        <select value={value} onChange={onChange}>
          <option value="">{placeholder}</option>
          {(batches ?? []).map((batch) => (
            <option key={batch.batch_id} value={batch.batch_id}>
              {batch.batch_name} ({batch.topologies.length})
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

export function BatchGridSection({
  batches = [],
  emptyMessage = "No batch available.",
  renderBatchCard,
  extraContent = null
}) {
  return (
    <section className="batch-grid">
      {batches.length === 0 ? (
        <div className="empty-topology-state">{emptyMessage}</div>
      ) : (
        <>
          {batches.map((batch) => renderBatchCard(batch))}
          {extraContent}
        </>
      )}
    </section>
  );
}

export function TopologyGridSection({
  title,
  headerRight = null,
  topologies = [],
  emptyMessage = "No topology available in this batch.",
  filteredEmptyMessage = "No topology matches current filters.",
  renderTopologyCard,
  onVisibleTopologiesChange = null
}) {
  const [nameSort, setNameSort] = useState("name_asc");
  const [nodeFilterOpen, setNodeFilterOpen] = useState(false);
  const [nodeFilters, setNodeFilters] = useState([]);
  const nodeOptions = useMemo(
    () =>
      Array.from(new Set((topologies ?? []).map((topo) => Number(topo.node_count)).filter((n) => Number.isFinite(n))).values()).sort(
        (a, b) => a - b
      ),
    [topologies]
  );
  const visibleTopologies = useMemo(() => {
    const filtered =
      nodeFilters.length > 0 ? topologies.filter((topo) => nodeFilters.includes(Number(topo.node_count))) : topologies;
    return [...filtered].sort((a, b) => {
      const nameA = String(a.topology_name ?? "");
      const nameB = String(b.topology_name ?? "");
      return nameSort === "name_desc" ? nameB.localeCompare(nameA) : nameA.localeCompare(nameB);
    });
  }, [topologies, nodeFilters, nameSort]);

  useEffect(() => {
    setNodeFilters((prev) => prev.filter((item) => nodeOptions.includes(item)));
    setNodeFilterOpen(false);
  }, [nodeOptions]);

  useEffect(() => {
    if (typeof onVisibleTopologiesChange === "function") {
      onVisibleTopologiesChange(visibleTopologies);
    }
  }, [visibleTopologies, onVisibleTopologiesChange]);

  function toggleNodeFilter(nodeCount) {
    setNodeFilters((prev) =>
      prev.includes(nodeCount) ? prev.filter((item) => item !== nodeCount) : [...prev, nodeCount].sort((a, b) => a - b)
    );
  }

  return (
    <section className="topology-grid with-header">
      <div className="batch-top-header">
        <h3>{title}</h3>
        <div className="batch-top-actions">
          <label className="field-label run-multi-filter-field">
            Sort name
            <select value={nameSort} onChange={(e) => setNameSort(e.target.value)}>
              <option value="name_asc">A → Z</option>
              <option value="name_desc">Z → A</option>
            </select>
          </label>
          <div className="run-dropdown run-multi-node-filter">
            <button
              type="button"
              className="run-dropdown-trigger"
              onClick={() => setNodeFilterOpen((open) => !open)}
            >
              <span>{nodeFilters.length > 0 ? `Nodes: ${nodeFilters.join(", ")}` : "Nodes: all"}</span>
              <span>{nodeFilterOpen ? "▴" : "▾"}</span>
            </button>
            {nodeFilterOpen ? (
              <div className="run-dropdown-menu">
                {nodeOptions.length === 0 ? (
                  <p className="muted">No node-count options.</p>
                ) : (
                  nodeOptions.map((nodeCount) => (
                    <label key={nodeCount} className="run-multi-node-option">
                      <input
                        type="checkbox"
                        checked={nodeFilters.includes(nodeCount)}
                        onChange={() => toggleNodeFilter(nodeCount)}
                      />
                      {nodeCount} nodes
                    </label>
                  ))
                )}
              </div>
            ) : null}
          </div>
          {headerRight}
        </div>
      </div>
      {topologies.length === 0 ? (
        <div className="empty-topology-state">{emptyMessage}</div>
      ) : visibleTopologies.length === 0 ? (
        <div className="empty-topology-state">{filteredEmptyMessage}</div>
      ) : (
        visibleTopologies.map((topo) => renderTopologyCard(topo))
      )}
    </section>
  );
}

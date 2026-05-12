from __future__ import annotations

from collections import deque

from app.repositories.topology_memory_repo import get_topology, upsert_topology_lower_bound


def _compute_lower_bound_from_topology(topology) -> int | None:
    nodes = topology.nodes
    if not nodes:
        return None

    node_ids = [node.node_id for node in nodes]
    if 0 not in node_ids:
        return None

    idx_by_id = {node_id: idx for idx, node_id in enumerate(node_ids)}
    points = [(node.x, node.y) for node in nodes]
    n = len(points)
    adjacency: list[list[int]] = [[] for _ in range(n)]
    threshold_sq = topology.tx_range * topology.tx_range

    for i in range(n):
        xi, yi = points[i]
        for j in range(i + 1, n):
            xj, yj = points[j]
            dx = xi - xj
            dy = yi - yj
            if (dx * dx + dy * dy) <= threshold_sq:
                adjacency[i].append(j)
                adjacency[j].append(i)

    sink_idx = idx_by_id[0]
    dist = [-1] * n
    dist[sink_idx] = 0
    queue: deque[int] = deque([sink_idx])
    while queue:
        cur = queue.popleft()
        for nxt in adjacency[cur]:
            if dist[nxt] == -1:
                dist[nxt] = dist[cur] + 1
                queue.append(nxt)

    if any(item < 0 for item in dist):
        return None
    return max(dist)


def refresh_topology_lower_bound(topology_id: str) -> int | None:
    topology = get_topology(topology_id)
    if topology is None:
        return None
    lower_bound = _compute_lower_bound_from_topology(topology)
    upsert_topology_lower_bound(topology_id=topology_id, lower_bound=lower_bound)
    return lower_bound

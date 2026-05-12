from __future__ import annotations

import random
from collections import deque

from app.repositories.topology_memory_repo import (
    allocate_unique_seed,
    NodeRecord,
    TopologyRecord,
    apply_topology_node_updates,
    create_topology,
    get_topology_nodes,
    mark_topology_runs_warning,
)
from app.schemas import GenerateTopologyRequest, NodeCoordinatePatch
from app.schemas import GenerateMultiTopologiesRequest
from app.services.topology_metrics_service import refresh_topology_lower_bound


def validate_coordinate_patch(payload: NodeCoordinatePatch) -> tuple[bool, str | None]:
    """
    Validate and normalize node coordinate updates.

    Rules:
    - Coordinates are integer.
    - Out-of-bound values are clamped to min/max bounds.
    - Duplicate-position check is deferred to repository/DB layer where all
      node coordinates for the topology are available.
    """
    if payload.min_bound > payload.max_bound_x or payload.min_bound > payload.max_bound_y:
        return False, "Failed."

    # Clamp values in place based on UX rule.
    if payload.x < payload.min_bound:
        payload.x = payload.min_bound
    elif payload.x > payload.max_bound_x:
        payload.x = payload.max_bound_x

    if payload.y < payload.min_bound:
        payload.y = payload.min_bound
    elif payload.y > payload.max_bound_y:
        payload.y = payload.max_bound_y

    # TODO: duplicate (x, y) check against topology nodes in DB.
    return True, None


_TOPOLOGY_EDIT_DRAFTS: dict[str, dict[int, tuple[int, int]]] = {}


def stage_topology_node_update(topology_id: str, payload: NodeCoordinatePatch) -> tuple[NodeCoordinatePatch | None, str | None]:
    ok, error = validate_coordinate_patch(payload)
    if not ok:
        return None, error or "Failed."

    nodes = get_topology_nodes(topology_id)
    if nodes is None:
        return None, "Failed."

    draft = _TOPOLOGY_EDIT_DRAFTS.get(topology_id, {})
    position_by_node = {node.node_id: (node.x, node.y) for node in nodes}

    for node_id, pos in draft.items():
        position_by_node[node_id] = pos

    position_by_node[payload.node_id] = (payload.x, payload.y)

    seen: set[tuple[int, int]] = set()
    for pos in position_by_node.values():
        if pos in seen:
            return None, "Failed."
        seen.add(pos)

    draft[payload.node_id] = (payload.x, payload.y)
    _TOPOLOGY_EDIT_DRAFTS[topology_id] = draft
    return payload, None


def commit_topology_updates(topology_id: str) -> tuple[bool, str | None]:
    updates = _TOPOLOGY_EDIT_DRAFTS.get(topology_id, {})
    ok, error = apply_topology_node_updates(topology_id=topology_id, updates=updates)
    if not ok:
        return False, error or "Failed."

    _TOPOLOGY_EDIT_DRAFTS.pop(topology_id, None)
    mark_topology_runs_warning(topology_id=topology_id)
    refresh_topology_lower_bound(topology_id=topology_id)
    return True, None


def _resolve_sink_xy(request: GenerateTopologyRequest) -> tuple[bool, tuple[int, int] | None]:
    if request.sink_mode == "manual":
        if request.sink_x is None or request.sink_y is None:
            return False, None
        return True, (request.sink_x, request.sink_y)
    if request.sink_mode == "corner_tl":
        return True, (0, request.space_height)
    if request.sink_mode == "corner_tr":
        return True, (request.space_width, request.space_height)
    if request.sink_mode == "corner_bl":
        return True, (0, 0)
    if request.sink_mode == "corner_br":
        return True, (request.space_width, 0)
    # center
    return True, (request.space_width // 2, request.space_height // 2)


def _is_in_bound(x: int, y: int, width: int, height: int) -> bool:
    return 0 <= x <= width and 0 <= y <= height


def _generate_unique_nodes(
    node_count: int, width: int, height: int, sink: tuple[int, int], rng: random.Random
) -> list[NodeRecord]:
    selected: set[tuple[int, int]] = {sink}
    # Keep node 0 fixed at sink position.
    nodes: list[NodeRecord] = [NodeRecord(node_id=0, x=sink[0], y=sink[1])]
    for node_id in range(1, node_count):
        while True:
            x = rng.randint(0, width)
            y = rng.randint(0, height)
            if (x, y) in selected:
                continue
            selected.add((x, y))
            nodes.append(NodeRecord(node_id=node_id, x=x, y=y))
            break
    return nodes


def _connected_to_sink(nodes: list[NodeRecord], sink_xy: tuple[int, int], tx_range: float) -> bool:
    sink_index = None
    points: list[tuple[int, int]] = []
    for idx, node in enumerate(nodes):
        points.append((node.x, node.y))
        if node.node_id == 0:
            sink_index = idx

    if sink_index is None:
        return False
    if points[sink_index] != sink_xy:
        return False

    n = len(points)
    adjacency: list[list[int]] = [[] for _ in range(n)]
    threshold_sq = tx_range * tx_range

    for i in range(n):
        xi, yi = points[i]
        for j in range(i + 1, n):
            xj, yj = points[j]
            dx = xi - xj
            dy = yi - yj
            if (dx * dx + dy * dy) <= threshold_sq:
                adjacency[i].append(j)
                adjacency[j].append(i)

    visited = [False] * n
    queue: deque[int] = deque([sink_index])
    visited[sink_index] = True

    while queue:
        cur = queue.popleft()
        for nxt in adjacency[cur]:
            if not visited[nxt]:
                visited[nxt] = True
                queue.append(nxt)

    return all(visited)


def generate_connected_topology(request: GenerateTopologyRequest) -> tuple[TopologyRecord | None, str | None]:
    if request.num_nodes <= 0 or request.space_width <= 0 or request.space_height <= 0:
        return None, "Invalid params: num_nodes/space must be > 0."
    if request.tx_range <= 0 or request.max_retry <= 0:
        return None, "Invalid params: tx_range/max_retry must be > 0."

    ok, sink_xy = _resolve_sink_xy(request)
    if not ok or sink_xy is None:
        return None, "Invalid sink config."
    sink_x, sink_y = sink_xy
    if not _is_in_bound(sink_x, sink_y, request.space_width, request.space_height):
        return None, "Sink is out of bound."

    total_slots = (request.space_width + 1) * (request.space_height + 1)
    if request.num_nodes > total_slots:
        return None, "Too many nodes for this space."

    resolved_seed = request.seed if request.seed is not None else allocate_unique_seed()
    base_seed = resolved_seed

    for attempt in range(request.max_retry):
        rng = random.Random(base_seed + attempt)
        nodes = _generate_unique_nodes(
            node_count=request.num_nodes,
            width=request.space_width,
            height=request.space_height,
            sink=(sink_x, sink_y),
            rng=rng,
        )
        if _connected_to_sink(nodes=nodes, sink_xy=(sink_x, sink_y), tx_range=request.tx_range):
            record = create_topology(
                node_count=request.num_nodes,
                space_width=request.space_width,
                space_height=request.space_height,
                tx_range=request.tx_range,
                sink_mode=request.sink_mode,
                sink_x=sink_x,
                sink_y=sink_y,
                seed=resolved_seed,
                nodes=nodes,
                batch_id=request.batch_id,
            )
            refresh_topology_lower_bound(topology_id=record.topology_id)
            return record, None

    return None, f"No connected topology found after {request.max_retry} retries."


def generate_multi_topologies(
    request: GenerateMultiTopologiesRequest,
) -> tuple[list[TopologyRecord], str | None]:
    if not request.node_counts or request.count_per_node_count <= 0:
        return [], "Select at least 1 node_count and set count_per_node_count > 0."

    created: list[TopologyRecord] = []
    base_seed = request.seed
    for node_count in request.node_counts:
        for idx in range(request.count_per_node_count):
            item = GenerateTopologyRequest(
                num_nodes=node_count,
                space_width=request.space_width,
                space_height=request.space_height,
                tx_range=request.tx_range,
                sink_mode=request.sink_mode,
                sink_x=request.sink_x,
                sink_y=request.sink_y,
                seed=(base_seed + len(created) + idx) if base_seed is not None else None,
                max_retry=request.max_retry,
                batch_id=request.batch_id,
            )
            record, error = generate_connected_topology(item)
            if record is None:
                return (
                    created,
                    f"Failed at node_count={node_count}, item={idx + 1}/{request.count_per_node_count}. "
                    f"{error or 'Unknown error.'}",
                )
            created.append(record)

    return created, None

from __future__ import annotations

from typing import Any, Literal

Mode = Literal["broadcaster", "receiver"]


def _build_adjacency(nodes: list[Any], tx_range: float) -> dict[int, set[int]]:
    adjacency: dict[int, set[int]] = {int(n.node_id): set() for n in nodes}
    tx_range_sq = float(tx_range) * float(tx_range)
    for i, a in enumerate(nodes):
        for b in nodes[i + 1 :]:
            dx = float(a.x) - float(b.x)
            dy = float(a.y) - float(b.y)
            if dx * dx + dy * dy <= tx_range_sq:
                adjacency[int(a.node_id)].add(int(b.node_id))
                adjacency[int(b.node_id)].add(int(a.node_id))
    return adjacency


def derive_playground_candidates(
    nodes: list[Any], tx_range: float, covered_node_ids: list[int] | None
) -> tuple[list[int], list[int], dict[int, set[int]]]:
    covered = {int(v) for v in (covered_node_ids or []) if int(v) >= 0}
    adjacency = _build_adjacency(nodes, tx_range)
    broadcaster_candidates: list[int] = []
    receiver_candidates_set: set[int] = set()

    for node_id in covered:
        neighbors = adjacency.get(node_id, set())
        if any(neighbor_id not in covered for neighbor_id in neighbors):
            broadcaster_candidates.append(node_id)
            for neighbor_id in neighbors:
                if neighbor_id not in covered:
                    receiver_candidates_set.add(neighbor_id)

    return (
        sorted(broadcaster_candidates),
        sorted(receiver_candidates_set),
        adjacency,
    )


def _map_receiver_to_broadcaster(
    receiver_id: int,
    broadcaster_candidates: list[int],
    receiver_candidates: list[int],
    adjacency: dict[int, set[int]],
) -> int | None:
    receiver_candidate_set = set(receiver_candidates)
    broadcasters = [node_id for node_id in broadcaster_candidates if receiver_id in adjacency.get(node_id, set())]
    if not broadcasters:
        return None

    def cover_count(node_id: int) -> int:
        return len([n for n in adjacency.get(node_id, set()) if n in receiver_candidate_set])

    return sorted(broadcasters, key=lambda node_id: (-cover_count(node_id), node_id))[0]


def simulate_playground_slot(
    nodes: list[Any],
    tx_range: float,
    covered_node_ids: list[int] | None,
    mode: Mode,
    selected_node_id: int,
) -> dict[str, Any] | None:
    covered = {int(v) for v in (covered_node_ids or []) if int(v) >= 0}
    broadcaster_candidates, receiver_candidates, adjacency = derive_playground_candidates(nodes, tx_range, list(covered))
    receiver_candidate_set = set(receiver_candidates)
    first_pick: int | None = None

    if mode == "receiver":
        first_pick = _map_receiver_to_broadcaster(
            int(selected_node_id), broadcaster_candidates, receiver_candidates, adjacency
        )
    elif int(selected_node_id) in broadcaster_candidates:
        first_pick = int(selected_node_id)

    if first_pick is None:
        return None

    broadcasters_remaining = list(broadcaster_candidates)
    transmitters: list[int] = []
    receivers: list[int] = []

    def collect_receivers_for(node_id: int) -> list[int]:
        return sorted(
            n
            for n in adjacency.get(node_id, set())
            if n not in covered and n in receiver_candidate_set
        )

    first_index = broadcasters_remaining.index(first_pick)
    if first_index >= 0:
        covered_by_first = collect_receivers_for(first_pick)
        transmitters.append(first_pick)
        receivers.extend(covered_by_first)
        broadcasters_remaining.pop(first_index)

    broadcasters_remaining.sort(
        key=lambda node_id: (-len(collect_receivers_for(node_id)), node_id)
    )

    idx = 0
    while idx < len(broadcasters_remaining):
        broadcaster_id = broadcasters_remaining[idx]
        candidate_receivers = collect_receivers_for(broadcaster_id)
        if any(node_id in receivers for node_id in candidate_receivers):
            broadcasters_remaining.pop(idx)
            continue
        if candidate_receivers:
            transmitters.append(broadcaster_id)
            receivers.extend(candidate_receivers)
        broadcasters_remaining.pop(idx)

    unique_receivers = sorted(set(receivers))
    if not unique_receivers:
        return None

    return {
        "first_pick": first_pick,
        "mode": mode,
        "transmitters": sorted(set(transmitters)),
        "receivers": unique_receivers,
    }


def enumerate_playground_transitions(
    nodes: list[Any],
    tx_range: float,
    covered_node_ids: list[int] | None,
    *,
    modes: tuple[Mode, ...] = ("broadcaster", "receiver"),
) -> list[dict[str, Any]]:
    covered = sorted({int(v) for v in (covered_node_ids or []) if int(v) >= 0}) or [0]
    broadcaster_candidates, receiver_candidates, _ = derive_playground_candidates(nodes, tx_range, covered)
    transitions: list[dict[str, Any]] = []

    for mode in modes:
        actions = receiver_candidates if mode == "receiver" else broadcaster_candidates
        for action in actions:
            slot = simulate_playground_slot(nodes, tx_range, covered, mode, int(action))
            if not slot:
                continue
            next_covered = sorted(set(covered) | {int(v) for v in slot["receivers"]})
            transitions.append(
                {
                    "action": int(action),
                    "mode": mode,
                    "to_covered_node_ids": next_covered,
                }
            )
    return transitions

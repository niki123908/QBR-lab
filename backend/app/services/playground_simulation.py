from __future__ import annotations

from typing import Any, Literal

from app.algorithms.br_env import Br_Env
from app.algorithms.common import trees
from app.algorithms.common.node import Node

Mode = Literal["broadcaster", "receiver"]
SpreadMode = Literal["normal", "la"]


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


def _nodes_to_br_env(nodes: list[Any], tx_range: float, covered_node_ids: list[int]) -> Br_Env:
    adjacency = _build_adjacency(nodes, tx_range)
    node_list: list[Node] = []
    for row in nodes:
        node_id = int(row.node_id)
        node = Node(ID=node_id, x=float(row.x), y=float(row.y), timeslot=1)
        node.neighbors = sorted(adjacency.get(node_id, set()))
        node_list.append(node)
    node_list.sort(key=lambda item: item.ID)
    env = Br_Env(node_list, 1)
    covered = sorted({int(v) for v in covered_node_ids if int(v) >= 0})
    if not covered:
        covered = [0]
    env.V_s = list(covered)
    env.V_ns = [node_id for node_id in env.V_ids if node_id not in set(covered)]
    env._find_br_rcv_cands()
    return env


def simulate_playground_slot(
    nodes: list[Any],
    tx_range: float,
    covered_node_ids: list[int] | None,
    mode: Mode,
    selected_node_id: int,
    *,
    spread_mode: SpreadMode = "normal",
) -> dict[str, Any] | None:
    covered = sorted({int(v) for v in (covered_node_ids or []) if int(v) >= 0}) or [0]
    env = _nodes_to_br_env(nodes, tx_range, covered)
    normalized_spread = str(spread_mode or "normal").strip().lower()
    if normalized_spread not in {"normal", "la"}:
        normalized_spread = "normal"

    if normalized_spread == "la":
        trees.prepare_latency_ahead(env.V)
    else:
        trees.build_bfs(env.V)

    action_axis = str(mode)
    first_pick: int | None = None
    if action_axis == "receiver":
        if int(selected_node_id) in env.rcv_cands:
            first_pick = int(selected_node_id)
    elif int(selected_node_id) in env.br_cands:
        first_pick = int(selected_node_id)

    if first_pick is None:
        return None

    _, _, _, br_set, rcv_set = env.proceed_action(
        first_pick,
        action_axis=action_axis,
        spread_mode=normalized_spread,
        coverage_reward_enabled=False,
    )
    unique_receivers = sorted({int(v) for v in rcv_set})
    if not unique_receivers:
        return None

    return {
        "first_pick": first_pick,
        "mode": mode,
        "spread_mode": normalized_spread,
        "transmitters": sorted({int(v) for v in br_set}),
        "receivers": unique_receivers,
    }


def enumerate_playground_transitions(
    nodes: list[Any],
    tx_range: float,
    covered_node_ids: list[int] | None,
    *,
    modes: tuple[Mode, ...] = ("broadcaster", "receiver"),
    spread_mode: SpreadMode = "normal",
) -> list[dict[str, Any]]:
    covered = sorted({int(v) for v in (covered_node_ids or []) if int(v) >= 0}) or [0]
    broadcaster_candidates, receiver_candidates, _ = derive_playground_candidates(nodes, tx_range, covered)
    transitions: list[dict[str, Any]] = []

    for mode in modes:
        actions = receiver_candidates if mode == "receiver" else broadcaster_candidates
        for action in actions:
            slot = simulate_playground_slot(
                nodes,
                tx_range,
                covered,
                mode,
                int(action),
                spread_mode=spread_mode,
            )
            if not slot:
                continue
            next_covered = sorted(set(covered) | {int(v) for v in slot["receivers"]})
            transitions.append(
                {
                    "action": int(action),
                    "mode": mode,
                    "spread_mode": spread_mode,
                    "to_covered_node_ids": next_covered,
                }
            )
    return transitions

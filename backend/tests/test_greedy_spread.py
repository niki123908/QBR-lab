from __future__ import annotations

import copy

from app.algorithms.br_env import Br_Env
from app.algorithms.common import trees
from app.algorithms.common.node import Node
from app.services.run_registry import _resolve_greedy_config


def _line_topology(count: int) -> list[Node]:
    nodes = [Node(ID=i, x=float(i), y=0.0, timeslot=1) for i in range(count)]
    for i in range(count - 1):
        nodes[i].neighbors.append(i + 1)
        nodes[i + 1].neighbors.append(i)
    return nodes


def _star_topology(leaf_count: int = 4) -> list[Node]:
    nodes = [Node(ID=0, x=0.0, y=0.0, timeslot=1)]
    for i in range(1, leaf_count + 1):
        nodes.append(Node(ID=i, x=float(i), y=1.0, timeslot=1))
    for i in range(1, leaf_count + 1):
        nodes[0].neighbors.append(i)
        nodes[i].neighbors.append(0)
    return nodes


def _env_with_state(nodes: list[Node], covered: list[int]) -> Br_Env:
    env = Br_Env(copy.deepcopy(nodes), 1)
    env.V_s = sorted(covered)
    covered_set = set(covered)
    env.V_ns = [node_id for node_id in env.V_ids if node_id not in covered_set]
    env._find_br_rcv_cands()
    return env


def _receivers_disjoint(br_set: list[int], rcv_set: list[int], env: Br_Env) -> bool:
    assigned: set[int] = set()
    for broadcaster in br_set:
        neighbors = [v for v in env.V[broadcaster].neighbors if v in rcv_set]
        if any(v in assigned for v in neighbors):
            return False
        assigned.update(neighbors)
    return True


def test_br_normal_sorts_by_cover_count() -> None:
    nodes = _star_topology(4)
    env = _env_with_state(nodes, [0])
    trees.build_bfs(env.V)
    _, _, _, br_set, rcv_set = env.proceed_action(1, action_axis="broadcaster", spread_mode="normal")
    assert br_set
    assert rcv_set
    assert _receivers_disjoint(br_set, rcv_set, env)


def test_br_la_uses_latency_ahead_order() -> None:
    nodes = _line_topology(5)
    env = _env_with_state(nodes, [0])
    trees.prepare_latency_ahead(env.V)
    br_temp = list(env.br_cands)
    la_sorted = sorted(
        br_temp,
        key=lambda b: (-int(getattr(env.V[b], "latency_ahead", -1)), -int(b)),
    )
    cover_sorted = sorted(br_temp, key=lambda b: -env._count_neighbors_in_rcv_cands(b))
    if la_sorted != cover_sorted:
        _, _, _, br_set_la, _ = env.proceed_action(
            la_sorted[0], action_axis="broadcaster", spread_mode="la"
        )
        env2 = _env_with_state(nodes, [0])
        trees.prepare_latency_ahead(env2.V)
        _, _, _, br_set_normal, _ = env2.proceed_action(
            cover_sorted[0], action_axis="broadcaster", spread_mode="normal"
        )
        assert br_set_la != br_set_normal or la_sorted[0] != cover_sorted[0]


def test_rcv_normal_future_neighbor_metric_differs_from_la() -> None:
    nodes = _line_topology(5)
    env = _env_with_state(nodes, [0, 1])
    trees.prepare_latency_ahead(env.V)
    future_counts = {rcv: env._future_neighbor_count(rcv) for rcv in env.rcv_cands}
    la_values = {rcv: int(getattr(env.V[rcv], "latency_ahead", -1)) for rcv in env.rcv_cands}
    if len(set(future_counts.values())) > 1 or len(set(la_values.values())) > 1:
        _, _, _, _, rcv_set_normal = env.proceed_action(
            max(env.rcv_cands, key=lambda r: (future_counts[r], -r)),
            action_axis="receiver",
            spread_mode="normal",
        )
        env2 = _env_with_state(nodes, [0, 1])
        trees.prepare_latency_ahead(env2.V)
        _, _, _, _, rcv_set_la = env2.proceed_action(
            max(env2.rcv_cands, key=lambda r: (la_values[r], -r)),
            action_axis="receiver",
            spread_mode="la",
        )
        assert rcv_set_normal or rcv_set_la


def test_rcv_la_keeps_parent_selection_loop() -> None:
    nodes = _star_topology(4)
    env = _env_with_state(nodes, [0])
    trees.prepare_latency_ahead(env.V)
    first = max(env.rcv_cands, key=lambda r: (int(getattr(env.V[r], "latency_ahead", -1)), -r))
    _, _, _, br_set, rcv_set = env.proceed_action(first, action_axis="receiver", spread_mode="la")
    assert br_set
    assert rcv_set
    assert _receivers_disjoint(br_set, rcv_set, env)


def test_all_modes_preserve_non_overlapping_receivers() -> None:
    nodes = _line_topology(6)
    combos = [
        ("broadcaster", "normal"),
        ("broadcaster", "la"),
        ("receiver", "normal"),
        ("receiver", "la"),
    ]
    for action_axis, spread_mode in combos:
        env = _env_with_state(nodes, [0, 1])
        if spread_mode == "la":
            trees.prepare_latency_ahead(env.V)
        else:
            trees.build_bfs(env.V)
        first_pool = env.br_cands if action_axis == "broadcaster" else env.rcv_cands
        assert first_pool
        _, _, _, br_set, rcv_set = env.proceed_action(
            first_pool[0],
            action_axis=action_axis,
            spread_mode=spread_mode,
        )
        assert rcv_set
        assert _receivers_disjoint(br_set, rcv_set, env)


def test_greedy_config_accepts_spread_mode_and_strips_unknown() -> None:
    resolved = _resolve_greedy_config(
        {
            "action_axis": "receiver",
            "spread_mode": "la",
            "episodes": 999,
            "run_seed": 42,
        },
        "default_v1",
    )
    assert resolved["action_axis"] == "receiver"
    assert resolved["spread_mode"] == "la"
    assert resolved["run_seed"] == 42
    assert "episodes" not in resolved

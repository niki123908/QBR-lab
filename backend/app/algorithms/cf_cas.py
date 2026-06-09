"""Collision-Free Critical-path Aware Scheduling (CF-CAS), always-on (T=1)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

from app.algorithms.br_env import hash_state
from app.algorithms.common import trees
from app.algorithms.common.node import Node


def _node_levels(nodes: Sequence[Node]) -> dict[int, int]:
    for node in nodes:
        node.distance = -1
    nodes[0].distance = 0
    queue = [0]
    head = 0
    while head < len(queue):
        current = queue[head]
        head += 1
        for nbr in nodes[current].neighbors:
            if nodes[nbr].distance == -1:
                nodes[nbr].distance = nodes[current].distance + 1
                queue.append(nbr)
    return {idx: int(nodes[idx].distance) for idx in range(len(nodes))}


def build_degree_based_spt(nodes: Sequence[Node]) -> bool:
    """Build degree-based SPT rooted at node 0; sets parentID and childrenIDs."""
    if not trees.build_bfs(nodes):
        return False

    levels = _node_levels(nodes)
    max_level = max(levels.values()) if levels else 0
    in_tree: set[int] = {0}

    for node in nodes:
        node.parentID = None
        node.childrenIDs = []

    for level in range(1, max_level + 1):
        remaining = {idx for idx, lv in levels.items() if lv == level and idx not in in_tree}
        while remaining:
            best_parent: int | None = None
            best_cover: list[int] = []
            for parent in sorted(in_tree):
                if levels.get(parent, -1) >= level:
                    continue
                cover = [v for v in remaining if v in nodes[parent].neighbors]
                if not cover:
                    continue
                if len(cover) > len(best_cover) or (len(cover) == len(best_cover) and (best_parent is None or parent < best_parent)):
                    best_parent = parent
                    best_cover = cover

            if best_parent is None or not best_cover:
                break

            for child in best_cover:
                nodes[child].set_parent(best_parent)
                nodes[best_parent].childrenIDs.append(child)
                in_tree.add(child)
                remaining.discard(child)

    return len(in_tree) == len(nodes)


def _covered_neighbors(nodes: Sequence[Node], node_id: int, covered: set[int]) -> list[int]:
    return [nbr for nbr in nodes[node_id].neighbors if nbr in covered]


def _uncovered_neighbors(nodes: Sequence[Node], node_id: int, uncovered: set[int]) -> list[int]:
    return [nbr for nbr in nodes[node_id].neighbors if nbr in uncovered]


def _pick_forwarder(
    nodes: Sequence[Node],
    receiver: int,
    covered: set[int],
    forwarder_pool: set[int],
    active_uncovered: set[int],
) -> int | None:
    candidates = [
        u
        for u in _covered_neighbors(nodes, receiver, covered)
        if u in forwarder_pool
    ]
    if not candidates:
        return None

    def score(u: int) -> tuple[int, int]:
        cover = len(_uncovered_neighbors(nodes, u, active_uncovered))
        return cover, -u

    return max(candidates, key=score)


def _exclude_forwarders_by_listeners(
    nodes: Sequence[Node], covered: set[int], listeners: Sequence[int], forwarder_pool: set[int]
) -> None:
    for listener in listeners:
        for nbr in nodes[listener].neighbors:
            if nbr in covered:
                forwarder_pool.discard(nbr)


def schedule_cf_cas(nodes: Sequence[Node]) -> list[dict[str, Any]]:
    """
    Run CF-CAS with T=1 (always-on).
    Returns per-timeslot records: time, br_set, rcv_set, action, reward.
    """
    if not build_degree_based_spt(nodes):
        raise ValueError("Network is disconnected.")
    trees.compute_latency_ahead(nodes)

    node_count = len(nodes)
    covered: set[int] = {0}
    uncovered: set[int] = set(range(1, node_count))
    lower_bound = max((int(nodes[idx].distance) for idx in range(node_count)), default=0)
    slots: list[dict[str, Any]] = []
    cur_time = 0

    while uncovered:
        cur_time += 1
        active_uncovered = set(uncovered)
        forwarder_pool = {
            u
            for u in covered
            if any(nbr in active_uncovered for nbr in nodes[u].neighbors)
        }
        br_set: list[int] = []
        rcv_set: list[int] = []
        blocked_critical: set[int] = set()

        while active_uncovered and forwarder_pool:
            pick_from = active_uncovered - blocked_critical
            if not pick_from:
                break
            critical = max(
                pick_from,
                key=lambda v: (int(getattr(nodes[v], "latency_ahead", 0)), -v),
            )
            forwarder = _pick_forwarder(nodes, critical, covered, forwarder_pool, active_uncovered)
            if forwarder is None:
                blocked_critical.add(critical)
                continue

            listeners = _uncovered_neighbors(nodes, forwarder, active_uncovered)
            if not listeners:
                forwarder_pool.discard(forwarder)
                blocked_critical.add(critical)
                continue

            blocked_critical.clear()
            br_set.append(forwarder)
            rcv_set.extend(listeners)
            for listener in listeners:
                active_uncovered.discard(listener)
            forwarder_pool.discard(forwarder)
            _exclude_forwarders_by_listeners(nodes, covered, listeners, forwarder_pool)

        if not rcv_set:
            raise RuntimeError("CF-CAS stalled: no progress in timeslot.")

        unique_rcv = sorted(set(rcv_set))
        unique_br = sorted(set(br_set))
        covered.update(unique_rcv)
        uncovered.difference_update(unique_rcv)

        total_covered = len(covered)
        completion_bonus = 0.0
        if total_covered >= node_count:
            completion_bonus = float(node_count) * math.exp(lower_bound - cur_time)

        reward = float(len(unique_rcv)) + completion_bonus
        slots.append(
            {
                "time": cur_time,
                "br_set": unique_br,
                "rcv_set": unique_rcv,
                "action": int(unique_br[0]) if unique_br else 0,
                "reward": reward,
                "covered": sorted(covered),
            }
        )

    return slots


def slots_to_step_rows(slots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert CF-CAS slots to greedy-compatible step rows with state hashes."""
    step_rows: list[dict[str, Any]] = []
    state_id_mapping: dict[str, int] = {}
    state_id_counter = 1
    prev_covered = [0]

    for slot in slots:
        state_hash = hash_state(prev_covered)
        next_covered = list(slot["covered"])
        next_state_hash = hash_state(next_covered)

        if state_hash not in state_id_mapping:
            state_id_mapping[state_hash] = state_id_counter
            state_id_counter += 1
        if next_state_hash not in state_id_mapping:
            state_id_mapping[next_state_hash] = state_id_counter
            state_id_counter += 1

        step_rows.append(
            {
                "time": slot["time"],
                "state_id": state_id_mapping[state_hash],
                "next_state_id": state_id_mapping[next_state_hash],
                "state_hash": state_hash,
                "next_state_hash": next_state_hash,
                "action": slot["action"],
                "reward": float(slot["reward"]),
                "q_before": 0.0,
                "q_after": 0.0,
                "rcv_set": slot["rcv_set"],
                "br_set": slot["br_set"],
            }
        )
        prev_covered = next_covered

    return step_rows

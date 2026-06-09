from __future__ import annotations

from app.algorithms.cf_cas import (
    build_degree_based_spt,
    schedule_cf_cas,
    slots_to_step_rows,
)
from app.algorithms.common import trees
from app.algorithms.common.node import Node


def _line_topology(count: int) -> list[Node]:
    nodes = [Node(ID=i, x=float(i), y=0.0, timeslot=1) for i in range(count)]
    for i in range(count - 1):
        nodes[i].neighbors.append(i + 1)
        nodes[i + 1].neighbors.append(i)
    return nodes


def test_build_degree_based_spt_connected_line() -> None:
    nodes = _line_topology(5)
    assert build_degree_based_spt(nodes) is True
    assert nodes[0].parentID is None
    assert 1 in nodes[0].childrenIDs
    for node in nodes:
        if node.ID != 0:
            assert node.parentID is not None


def test_latency_ahead_increases_toward_leaves() -> None:
    nodes = _line_topology(5)
    build_degree_based_spt(nodes)
    trees.compute_latency_ahead(nodes)
    assert nodes[4].latency_ahead == 0
    assert nodes[0].latency_ahead == nodes[1].latency_ahead + 1 or nodes[0].latency_ahead >= nodes[4].latency_ahead


def test_schedule_cf_cas_covers_all_nodes() -> None:
    nodes = _line_topology(5)
    slots = schedule_cf_cas(nodes)
    assert slots
    last = slots[-1]["covered"]
    assert last == [0, 1, 2, 3, 4]
    for slot in slots:
        assert slot["br_set"]
        assert slot["rcv_set"]
        assert not (set(slot["br_set"]) & set(slot["rcv_set"]))


def test_slots_to_step_rows_deterministic() -> None:
    nodes = _line_topology(4)
    slots_a = schedule_cf_cas(nodes)
    nodes_b = _line_topology(4)
    slots_b = schedule_cf_cas(nodes_b)
    rows_a = slots_to_step_rows(slots_a)
    rows_b = slots_to_step_rows(slots_b)
    assert len(rows_a) == len(rows_b)
    assert [r["br_set"] for r in rows_a] == [r["br_set"] for r in rows_b]

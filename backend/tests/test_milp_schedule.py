from __future__ import annotations

from app.algorithms.br_env import Br_Env
from app.algorithms.common.node import Node
from app.algorithms.milp_schedule import schedule_milp, validate_milp_schedule
from app.services.run_registry import resolve_and_validate_run_config
from app.services.runners.milp_runner import assert_milp_node_limit


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
        nodes[0].neighbors.append(i)
        nodes[i].neighbors.append(0)
    return nodes


def test_milp_line_matches_lower_bound() -> None:
    nodes = _line_topology(5)
    lb = int(Br_Env(nodes, 1).network_diameter())
    result = schedule_milp(nodes, lower_bound=lb, solver_timeout_sec=30)
    assert result.status == "optimal"
    assert result.delay == lb
    assert result.conflict_mode == "allow"
    assert validate_milp_schedule(nodes, result.timeslots)


def test_milp_star_delay_is_one() -> None:
    nodes = _star_topology(4)
    lb = int(Br_Env(nodes, 1).network_diameter())
    assert lb == 1
    result = schedule_milp(nodes, lower_bound=lb, solver_timeout_sec=30)
    assert result.status == "optimal"
    assert result.delay == 1
    assert validate_milp_schedule(nodes, result.timeslots)
    assert set(result.timeslots[0]["transmitters"]) == {0}
    assert set(result.timeslots[0]["receivers"]) == {1, 2, 3, 4}


def test_milp_forbid_conflict_line() -> None:
    nodes = _line_topology(5)
    lb = int(Br_Env(nodes, 1).network_diameter())
    result = schedule_milp(
        nodes, lower_bound=lb, solver_timeout_sec=30, conflict_mode="forbid"
    )
    assert result.status == "optimal"
    assert result.conflict_mode == "forbid"
    assert result.delay == lb
    assert validate_milp_schedule(nodes, result.timeslots, conflict_mode="forbid")


def test_milp_forbid_conflict_star() -> None:
    """Star: sink alone can TX to all leaves with no pairwise conflict."""
    nodes = _star_topology(4)
    lb = int(Br_Env(nodes, 1).network_diameter())
    result = schedule_milp(
        nodes, lower_bound=lb, solver_timeout_sec=30, conflict_mode="forbid"
    )
    assert result.status == "optimal"
    assert result.delay == 1
    assert validate_milp_schedule(nodes, result.timeslots, conflict_mode="forbid")
    assert set(result.timeslots[0]["transmitters"]) == {0}


def test_milp_forbid_collision_only_matters_for_uninformed() -> None:
    # 0-1, 0-3, 1-3, 1-2. After 0→1, both 0 and 1 TX: uninformed 3 hears two → forbid fails.
    nodes = [Node(ID=i, x=float(i), y=0.0, timeslot=1) for i in range(4)]
    for a, b in ((0, 1), (1, 2), (0, 3), (1, 3)):
        nodes[a].neighbors.append(b)
        nodes[b].neighbors.append(a)

    collide_uninformed = [
        {"timeslot": 1, "transmitters": [0], "receivers": [1]},
        {"timeslot": 2, "transmitters": [0, 1], "receivers": []},
    ]
    assert not validate_milp_schedule(nodes, collide_uninformed, conflict_mode="forbid")

    # Same collision after 3 is already informed is allowed under forbid.
    collide_informed = [
        {"timeslot": 1, "transmitters": [0], "receivers": [1, 3]},
        {"timeslot": 2, "transmitters": [0, 1], "receivers": [2]},
    ]
    assert validate_milp_schedule(nodes, collide_informed, conflict_mode="forbid")


def test_milp_node_limit_and_config() -> None:
    assert_milp_node_limit(99)
    try:
        assert_milp_node_limit(100)
        raise AssertionError("expected node limit error")
    except ValueError:
        pass

    resolved = resolve_and_validate_run_config(
        algorithm_id="milp",
        preset_id="default_v1",
        run_config={"solver_timeout_sec": 45, "conflict_mode": "forbid"},
        topology_context={"node_count": 20},
    )
    assert resolved["solver_timeout_sec"] == 45
    assert resolved["conflict_mode"] == "forbid"

    resolved_default = resolve_and_validate_run_config(
        algorithm_id="milp",
        preset_id="default_v1",
        run_config={},
        topology_context={"node_count": 20},
    )
    assert resolved_default["conflict_mode"] == "allow"

    try:
        resolve_and_validate_run_config(
            algorithm_id="milp",
            preset_id="default_v1",
            run_config={},
            topology_context={"node_count": 100},
        )
        raise AssertionError("expected config node limit error")
    except ValueError:
        pass

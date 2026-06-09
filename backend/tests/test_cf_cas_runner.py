from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from app.algorithms.common.node import Node
from app.services.runners.base import RunnerContext
from app.services.run_registry import resolve_and_validate_run_config
from app.services.runners.cf_cas_runner import execute_cf_cas


def _line_topology(count: int) -> list[Node]:
    nodes = [Node(ID=i, x=float(i), y=0.0, timeslot=1) for i in range(count)]
    for i in range(count - 1):
        nodes[i].neighbors.append(i + 1)
        nodes[i + 1].neighbors.append(i)
    return nodes


def test_cf_cas_config_ignores_extra_qbr_fields() -> None:
    resolved = resolve_and_validate_run_config(
        "cf_cas",
        "default_v1",
        {"episodes": 100, "alpha": 0.2, "run_seed": 42},
        {"node_count": 50},
    )
    assert resolved == {"run_seed": 42}


def test_execute_cf_cas_returns_result() -> None:
    nodes = _line_topology(5)
    topology = SimpleNamespace(tx_range=2.0)
    context = RunnerContext(run_id="test-cf-cas-run", topology=topology, nodes=nodes, config={"run_seed": 1})

    with patch("app.services.runners.cf_cas_runner.write_gzip_json"):
        result = execute_cf_cas(context)

    assert result.finished_delay >= 1
    assert result.lower_bound >= 1
    assert result.finished_delay >= result.lower_bound
    assert result.decision_graph_edges == result.finished_delay
    assert "run_bundle" in result.artifact_paths


def test_execute_cf_cas_deterministic() -> None:
    nodes_a = _line_topology(6)
    nodes_b = _line_topology(6)
    topology = SimpleNamespace(tx_range=2.0)

    with patch("app.services.runners.cf_cas_runner.write_gzip_json"):
        result_a = execute_cf_cas(
            RunnerContext(run_id="cf-cas-a", topology=topology, nodes=nodes_a, config={})
        )
        result_b = execute_cf_cas(
            RunnerContext(run_id="cf-cas-b", topology=topology, nodes=nodes_b, config={})
        )

    assert result_a.finished_delay == result_b.finished_delay
    assert result_a.best_delay_explored == result_b.best_delay_explored

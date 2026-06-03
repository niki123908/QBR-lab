from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, TYPE_CHECKING, Callable

from app.models import Topology

if TYPE_CHECKING:
    from app.algorithms.common.node import Node


@dataclass(frozen=True)
class RunnerContext:
    run_id: str
    topology: Topology
    nodes: list["Node"]
    config: dict[str, Any]


@dataclass
class RunExecutionResult:
    finished_delay: int
    best_delay_explored: int
    lower_bound: int
    reward_final: float
    artifact_paths: dict[str, Path]
    total_states: int | None = None
    total_state_actions: int | None = None
    decision_graph_edges: int | None = None


AlgorithmRunner = Callable[[RunnerContext], RunExecutionResult]

# Wall-clock budget for one topology training run (seconds).
TOPOLOGY_RUN_TIMEOUT_SEC = 30 * 60  # 30 minutes

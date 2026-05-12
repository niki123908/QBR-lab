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


AlgorithmRunner = Callable[[RunnerContext], RunExecutionResult]

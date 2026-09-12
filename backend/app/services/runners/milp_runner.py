from __future__ import annotations

from app.services.runners.base import RunExecutionResult, RunnerContext

# MILP is only allowed for topologies with fewer than this many nodes.
MILP_MAX_NODE_COUNT_EXCLUSIVE = 100


def assert_milp_node_limit(node_count: int) -> None:
    n = int(node_count)
    if n >= MILP_MAX_NODE_COUNT_EXCLUSIVE:
        raise ValueError(
            f"MILP is disabled for topologies with {MILP_MAX_NODE_COUNT_EXCLUSIVE}+ nodes "
            f"(got {n}). Use a topology with fewer than {MILP_MAX_NODE_COUNT_EXCLUSIVE} nodes."
        )


def execute_milp(context: RunnerContext) -> RunExecutionResult:
    """Placeholder runner: node-count gate is enforced; solver body comes next."""
    assert_milp_node_limit(len(context.nodes))
    raise ValueError(
        "MILP solver is registered but not implemented yet. "
        "Node-count gate passed; formulation/solver wiring is next."
    )

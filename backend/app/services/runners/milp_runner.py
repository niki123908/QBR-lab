from __future__ import annotations

from typing import Any

from app.algorithms.br_env import Br_Env, hash_state
from app.algorithms.milp_schedule import schedule_milp
from app.services.run_artifacts import (
    build_milp_run_bundle,
    build_trace_epochs_payload,
    learning_stats_from_episode_steps,
    write_gzip_json,
)
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
    run_id = context.run_id
    nodes = context.nodes
    config = context.config or {}
    assert_milp_node_limit(len(nodes))

    timeout_sec = float(config.get("solver_timeout_sec", 60))
    if timeout_sec < 1:
        timeout_sec = 1.0
    if timeout_sec > 600:
        timeout_sec = 600.0

    conflict_raw = str(config.get("conflict_mode", "allow")).strip().lower()
    conflict_mode = "forbid" if conflict_raw in ("forbid", "conflict_free", "cf", "no_conflict") else "allow"

    env = Br_Env(nodes, 1)
    lower_bound = int(env.network_diameter())
    result = schedule_milp(
        nodes,
        lower_bound=lower_bound,
        solver_timeout_sec=timeout_sec,
        conflict_mode=conflict_mode,
    )
    if result.status != "optimal" or not result.timeslots:
        raise ValueError(
            f"MILP failed ({result.status}). "
            f"lower_bound={result.lower_bound}, tried_T={result.tried_horizons}."
        )

    step_rows: list[dict[str, Any]] = []
    state_id_mapping: dict[str, int] = {}
    state_id_counter = 1
    covered = [0]
    for slot in result.timeslots:
        state_hash = hash_state(covered)
        receivers = [int(v) for v in (slot.get("receivers") or [])]
        transmitters = [int(v) for v in (slot.get("transmitters") or [])]
        next_covered = sorted(set(covered).union(receivers))
        next_state_hash = hash_state(next_covered)
        if state_hash not in state_id_mapping:
            state_id_mapping[state_hash] = state_id_counter
            state_id_counter += 1
        if next_state_hash not in state_id_mapping:
            state_id_mapping[next_state_hash] = state_id_counter
            state_id_counter += 1
        action = transmitters[0] if transmitters else 0
        step_rows.append(
            {
                "time": int(slot["timeslot"]),
                "state_id": state_id_mapping[state_hash],
                "next_state_id": state_id_mapping[next_state_hash],
                "state_hash": state_hash,
                "next_state_hash": next_state_hash,
                "action": action,
                "reward": float(len(receivers)),
                "q_before": 0.0,
                "q_after": 0.0,
                "rcv_set": sorted(receivers),
                "br_set": sorted(transmitters),
            }
        )
        covered = next_covered

    finished_delay = int(result.delay)
    total_reward = float(sum(float(row["reward"]) for row in step_rows))

    from app.core.paths import artifact_root_for_run

    artifact_root = artifact_root_for_run(run_id)
    artifact_root.mkdir(parents=True, exist_ok=True)

    run_bundle_path = artifact_root / "run_bundle.json.gz"
    trace_epochs_path = artifact_root / "trace_epochs.json.gz"

    state_action_payload = {"episode": 1, "delay": finished_delay, "steps": step_rows}
    transmission_payload = {
        "episode": 1,
        "total_delay": finished_delay,
        "timeslots": [
            {
                "timeslot": item["time"],
                "transmitters": item["br_set"],
                "receivers": item["rcv_set"],
            }
            for item in step_rows
        ],
    }
    summary_payload = {
        "algorithm_id": "milp",
        "run_id": run_id,
        "finished_delay": finished_delay,
        "best_delay_explored": finished_delay,
        "lower_bound": int(result.lower_bound),
        "reward_final": total_reward,
        "solver_timeout_sec": timeout_sec,
        "conflict_mode": conflict_mode,
        "milp_status": result.status,
        "milp_tried_horizons": list(result.tried_horizons),
    }

    write_gzip_json(
        run_bundle_path,
        build_milp_run_bundle(
            run_id=run_id,
            summary_payload=summary_payload,
            transmission_payload=transmission_payload,
            state_action_payload=state_action_payload,
        ),
    )
    write_gzip_json(
        trace_epochs_path,
        build_trace_epochs_payload(state_action_payload, state_action_payload),
    )

    total_states, total_state_actions = learning_stats_from_episode_steps(
        [{"episode": 1, "delay": finished_delay, "steps": step_rows}]
    )
    return RunExecutionResult(
        finished_delay=finished_delay,
        best_delay_explored=finished_delay,
        lower_bound=int(result.lower_bound),
        reward_final=total_reward,
        total_states=total_states,
        total_state_actions=total_state_actions,
        decision_graph_edges=len(step_rows),
        artifact_paths={
            "run_bundle": run_bundle_path,
            "trace_epochs": trace_epochs_path,
        },
    )

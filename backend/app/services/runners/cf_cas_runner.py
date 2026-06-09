from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from app.algorithms.br_env import Br_Env
from app.algorithms.cf_cas import schedule_cf_cas, slots_to_step_rows
from app.services.run_artifacts import (
    build_cf_cas_run_bundle,
    build_trace_epochs_payload,
    learning_stats_from_episode_steps,
    write_gzip_json,
)
from app.services.runners.base import RunExecutionResult, RunnerContext, TOPOLOGY_RUN_TIMEOUT_SEC


def execute_cf_cas(context: RunnerContext) -> RunExecutionResult:
    run_id = context.run_id
    nodes = context.nodes

    env = Br_Env(nodes, 1)
    lower_bound = int(env.network_diameter())
    timeout_sec = TOPOLOGY_RUN_TIMEOUT_SEC
    started = time.monotonic()

    slots = schedule_cf_cas(nodes)
    if (time.monotonic() - started) > timeout_sec:
        raise TimeoutError(f"Training exceeded {timeout_sec}s wall-clock limit.")

    step_rows = slots_to_step_rows(slots)
    finished_delay = int(slots[-1]["time"]) if slots else 0
    total_reward = sum(float(row["reward"]) for row in step_rows)

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
        "algorithm_id": "cf_cas",
        "run_id": run_id,
        "finished_delay": finished_delay,
        "best_delay_explored": finished_delay,
        "lower_bound": lower_bound,
        "reward_final": float(total_reward),
    }

    write_gzip_json(
        run_bundle_path,
        build_cf_cas_run_bundle(
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
        lower_bound=lower_bound,
        reward_final=float(total_reward),
        total_states=total_states,
        total_state_actions=total_state_actions,
        decision_graph_edges=len(step_rows),
        artifact_paths={
            "run_bundle": run_bundle_path,
            "trace_epochs": trace_epochs_path,
        },
    )

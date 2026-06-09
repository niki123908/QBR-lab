from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from app.algorithms.br_env import Br_Env, hash_state
from app.algorithms.common import trees
from app.services.run_artifacts import (
    build_greedy_run_bundle,
    build_trace_epochs_payload,
    learning_stats_from_episode_steps,
    write_gzip_json,
)
from app.services.runners.base import RunExecutionResult, RunnerContext, TOPOLOGY_RUN_TIMEOUT_SEC


def _pick_first_action(env: Br_Env, action_axis: str, spread_mode: str) -> int:
    axis = str(action_axis)
    mode = str(spread_mode)

    if axis == "receiver":
        if mode == "la":
            return int(
                max(
                    env.rcv_cands,
                    key=lambda node_id: (int(getattr(env.V[node_id], "latency_ahead", -1)), -int(node_id)),
                )
            )
        return int(max(env.rcv_cands, key=lambda node_id: (env._future_neighbor_count(node_id), -int(node_id))))

    if mode == "la":
        return int(
            max(
                env.br_cands,
                key=lambda node_id: (int(getattr(env.V[node_id], "latency_ahead", -1)), -int(node_id)),
            )
        )

    def cover_count(node_id: int) -> tuple[int, int]:
        count = len([nbr for nbr in env.V[node_id].neighbors if nbr in env.rcv_cands])
        return count, -node_id

    return int(max(env.br_cands, key=cover_count))


def execute_greedy(context: RunnerContext) -> RunExecutionResult:
    run_id = context.run_id
    nodes = context.nodes
    config = context.config or {}
    action_axis = str(config.get("action_axis", "broadcaster"))
    spread_mode = str(config.get("spread_mode", "normal"))

    env = Br_Env(nodes, 1)
    lower_bound = int(env.network_diameter())
    if spread_mode == "la":
        trees.prepare_latency_ahead(env.V)
    timeout_sec = TOPOLOGY_RUN_TIMEOUT_SEC
    started = time.monotonic()

    done = env.reset()
    env.cur_time = 0
    if spread_mode != "la":
        trees.build_bfs(env.V)
    total_reward = 0.0
    step_rows: list[dict[str, Any]] = []
    state_id_mapping: dict[str, int] = {}
    state_id_counter = 1

    while not done:
        if (time.monotonic() - started) > timeout_sec:
            raise TimeoutError(f"Training exceeded {timeout_sec}s wall-clock limit.")

        env.cur_time += 1
        env._find_br_rcv_cands()
        if len(env.br_cands) == 0 or len(env.rcv_cands) == 0:
            continue

        state_hash = hash_state(env.V_s)
        first_pick = _pick_first_action(env, action_axis, spread_mode)
        next_state, reward, done, br_set, rcv_set = env.proceed_action(
            first_pick,
            action_axis=action_axis,
            spread_mode=spread_mode,
        )
        next_state = list(set(next_state))
        next_state_hash = hash_state(next_state)

        if state_hash not in state_id_mapping:
            state_id_mapping[state_hash] = state_id_counter
            state_id_counter += 1
        if next_state_hash not in state_id_mapping:
            state_id_mapping[next_state_hash] = state_id_counter
            state_id_counter += 1

        step_rows.append(
            {
                "time": env.cur_time,
                "state_id": state_id_mapping[state_hash],
                "next_state_id": state_id_mapping[next_state_hash],
                "state_hash": state_hash,
                "next_state_hash": next_state_hash,
                "action": first_pick,
                "reward": float(reward),
                "q_before": 0.0,
                "q_after": 0.0,
                "rcv_set": sorted(list(set(rcv_set))),
                "br_set": sorted(list(set(br_set))),
            }
        )

        env.V_s = next_state
        total_reward += reward

    from app.core.paths import artifact_root_for_run

    artifact_root = artifact_root_for_run(run_id)
    artifact_root.mkdir(parents=True, exist_ok=True)

    run_bundle_path = artifact_root / "run_bundle.json.gz"
    trace_epochs_path = artifact_root / "trace_epochs.json.gz"

    state_action_payload = {"episode": 1, "delay": int(env.cur_time), "steps": step_rows}
    transmission_payload = {
        "episode": 1,
        "total_delay": int(env.cur_time),
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
        "algorithm_id": "greedy",
        "run_id": run_id,
        "finished_delay": int(env.cur_time),
        "best_delay_explored": int(env.cur_time),
        "lower_bound": lower_bound,
        "reward_final": float(total_reward),
        "action_axis": action_axis,
        "spread_mode": spread_mode,
    }

    write_gzip_json(
        run_bundle_path,
        build_greedy_run_bundle(
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
        [{"episode": 1, "delay": int(env.cur_time), "steps": step_rows}]
    )
    return RunExecutionResult(
        finished_delay=int(env.cur_time),
        best_delay_explored=int(env.cur_time),
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

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from app.algorithms.br_env import Br_Env, hash_state
from app.algorithms.common import trees
from app.services.runners.base import RunExecutionResult, RunnerContext


def _timeout_seconds(node_count: int) -> int:
    return 300 if node_count < 500 else 900


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


def _pick_first_broadcaster(env: Br_Env) -> int:
    def cover_count(node_id: int) -> tuple[int, int]:
        count = len([nbr for nbr in env.V[node_id].neighbors if nbr in env.rcv_cands])
        return count, -node_id

    return int(max(env.br_cands, key=cover_count))


def execute_greedy(context: RunnerContext) -> RunExecutionResult:
    run_id = context.run_id
    topology = context.topology
    nodes = context.nodes

    env = Br_Env(nodes, 1)
    lower_bound = int(env.network_diameter())
    timeout_sec = _timeout_seconds(topology.node_count)
    started = time.monotonic()

    done = env.reset()
    env.cur_time = 0
    trees.build_bfs(env.V)
    total_reward = 0.0
    step_rows: list[dict[str, Any]] = []
    state_id_mapping: dict[str, int] = {}
    state_id_counter = 1

    while not done:
        if (time.monotonic() - started) > timeout_sec:
            raise TimeoutError("Failed.")

        env.cur_time += 1
        env._find_br_rcv_cands()
        if len(env.br_cands) == 0 or len(env.rcv_cands) == 0:
            continue

        state_hash = hash_state(env.V_s)
        first_pick = _pick_first_broadcaster(env)
        next_state, reward, done, br_set, rcv_set = env.proceed_action(first_pick)
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

    artifact_root = Path(__file__).resolve().parents[4] / "storage" / "artifacts" / run_id
    artifact_root.mkdir(parents=True, exist_ok=True)

    state_action_path = artifact_root / "state_action_last_epoch.json"
    transmission_path = artifact_root / "transmission_last_epoch.json"
    run_summary_path = artifact_root / "run_summary.json"

    state_action_payload = {"delay": int(env.cur_time), "steps": step_rows}
    transmission_payload = {
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
    }

    _write_json(state_action_path, state_action_payload)
    _write_json(transmission_path, transmission_payload)
    _write_json(run_summary_path, summary_payload)

    return RunExecutionResult(
        finished_delay=int(env.cur_time),
        best_delay_explored=int(env.cur_time),
        lower_bound=lower_bound,
        reward_final=float(total_reward),
        artifact_paths={
            "run_summary": run_summary_path,
            "state_action_last_epoch": state_action_path,
            "transmission_last_epoch": transmission_path,
        },
    )

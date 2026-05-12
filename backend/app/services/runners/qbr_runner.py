from __future__ import annotations

import csv
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from app.algorithms.br_env import Br_Env
from app.algorithms.common import trees
from app.services.runners.base import RunExecutionResult, RunnerContext
from app.services.runners.qbr_components import (
    BroadcastCandidateFinder,
    EpsilonGreedyActionPolicy,
    QbrStateEncoder,
    QLearningUpdateRule,
    SoftmaxActionPolicy,
)
from app.services.runners.template import train_with_template


def _timeout_seconds(node_count: int) -> int:
    return 300 if node_count < 500 else 900


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


def _write_csv(path: Path, header: list[str], rows: list[list[Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def _build_path_signature(steps: list[dict[str, Any]]) -> str:
    if not steps:
        return ""
    seq = [str(item["state_id"]) for item in steps]
    seq.append(str(steps[-1]["next_state_id"]))
    return "->".join(seq)


def _timeslot_transmission(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_slot: dict[int, dict[str, Any]] = {}
    for step in steps:
        ts = int(step["time"])
        if ts not in by_slot:
            by_slot[ts] = {"timeslot": ts, "transmitters": set(), "receivers": set()}
        by_slot[ts]["transmitters"].update(step.get("br_set", []))
        by_slot[ts]["receivers"].update(step.get("rcv_set", []))

    output: list[dict[str, Any]] = []
    for ts in sorted(by_slot.keys()):
        output.append(
            {
                "timeslot": ts,
                "transmitters": sorted(by_slot[ts]["transmitters"]),
                "receivers": sorted(by_slot[ts]["receivers"]),
            }
        )
    return output


def _action_space_by_timeslot_summary(
    episodes_steps: list[dict[str, Any]], candidate_count_key: str, axis_label: str
) -> dict[str, Any]:
    """Mean candidate count per timeslot over unique path_signature (first episode only per signature)."""
    seen_sig: set[str] = set()
    representatives: list[dict[str, Any]] = []
    for item in episodes_steps:
        sig = str(item.get("path_signature") or "")
        if not sig or sig in seen_sig:
            continue
        seen_sig.add(sig)
        representatives.append(item)

    bucket: dict[int, list[float]] = defaultdict(list)
    for item in representatives:
        steps = item.get("steps")
        if not isinstance(steps, list):
            continue
        for step in steps:
            if not isinstance(step, dict):
                continue
            t = int(step.get("time") or 0)
            raw = step.get(candidate_count_key)
            if raw is None:
                continue
            bucket[t].append(float(raw))

    timeslots: list[dict[str, Any]] = [
        {
            "timeslot": t,
            "mean_candidate_count": sum(vals) / len(vals),
            "n_unique_paths": len(vals),
        }
        for t, vals in sorted(bucket.items(), key=lambda x: x[0])
    ]
    return {"action_axis": str(axis_label), "timeslots": timeslots}


def _build_q_profile_for_episode(
    episode_payload: dict[str, Any], q_snapshot: dict[str, dict[int, float]]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    steps = episode_payload.get("steps")
    if not isinstance(steps, list):
        return rows
    for step in steps:
        if not isinstance(step, dict):
            continue
        timeslot = int(step.get("time") or 0)
        state_hash = str(step.get("state_hash") or "")
        candidates_raw = step.get("action_candidates")
        candidates: list[int] = []
        if isinstance(candidates_raw, list):
            for item in candidates_raw:
                try:
                    candidates.append(int(item))
                except (TypeError, ValueError):
                    continue
        state_actions = q_snapshot.get(state_hash, {})
        q_values = [float(state_actions.get(action, 0.0)) for action in candidates]
        if q_values:
            max_q = float(max(q_values))
            mean_q = float(sum(q_values) / len(q_values))
        else:
            max_q = 0.0
            mean_q = 0.0
        rows.append(
            {
                "timeslot": timeslot,
                "candidate_count": int(len(candidates)),
                "max_q": max_q,
                "mean_q": mean_q,
            }
        )
    return rows


def _q_profile_by_epoch_summary(
    episodes_steps: list[dict[str, Any]],
    qtable_snapshots_by_episode: dict[int, dict[str, dict[int, float]]],
    final_qtable: dict[str, dict[int, float]],
    *,
    target_epochs: list[int],
    fallback_episode: int,
    action_axis: str,
) -> dict[str, Any]:
    episode_payload_by_num: dict[int, dict[str, Any]] = {}
    for item in episodes_steps:
        ep = int(item.get("episode") or 0)
        if ep > 0 and ep not in episode_payload_by_num:
            episode_payload_by_num[ep] = item

    charts: list[dict[str, Any]] = []
    for target in target_epochs:
        resolved = int(target if target in episode_payload_by_num else fallback_episode)
        episode_payload = episode_payload_by_num.get(resolved, {"episode": resolved, "steps": []})
        q_snapshot = qtable_snapshots_by_episode.get(resolved, final_qtable)
        charts.append(
            {
                "target_epoch": int(target),
                "resolved_epoch": int(resolved),
                "timeslots": _build_q_profile_for_episode(episode_payload, q_snapshot),
            }
        )
    return {"action_axis": str(action_axis), "charts": charts}


def execute_qbr(context: RunnerContext) -> RunExecutionResult:
    run_id = context.run_id
    topology = context.topology
    nodes = context.nodes
    config = context.config

    episodes = int(config.get("episodes", 1000))
    if episodes <= 0:
        raise ValueError("Failed.")

    alpha = float(config.get("alpha", 0.2))
    gamma = float(config.get("gamma", 0.8))
    policy_type = str(config.get("policy_type", "epsilon_greedy"))
    epsilon = float(config.get("epsilon_start", 1.0))
    epsilon_end = float(config.get("epsilon_end", 0.01))
    epsilon_decay = float(config.get("epsilon_decay", 0.001))
    temperature_start = float(config.get("temperature_start", 1.0))
    temperature_end = float(config.get("temperature_end", 0.1))
    temperature_decay = float(config.get("temperature_decay", 0.001))
    temperature_decay_mode = str(config.get("temperature_decay_mode", "linear"))
    action_axis = str(config.get("action_axis", "broadcaster"))
    completion_bonus_multiplier = float(config.get("completion_bonus_multiplier", 1.0))
    lambda_param = float(config.get("lambda_param", 0.0))
    trace_threshold = float(config.get("trace_threshold", 0.01))

    if policy_type == "epsilon_greedy":
        action_policy = EpsilonGreedyActionPolicy(
            epsilon_start=epsilon,
            epsilon_end=epsilon_end,
            epsilon_decay=epsilon_decay,
            action_axis=action_axis,
        )
        policy_trace_header = ["episode", "epsilon_before", "epsilon_after"]
    elif policy_type == "softmax":
        action_policy = SoftmaxActionPolicy(
            temperature_start=temperature_start,
            temperature_end=temperature_end,
            temperature_decay=temperature_decay,
            action_axis=action_axis,
            temperature_decay_mode=temperature_decay_mode,
        )
        policy_trace_header = ["episode", "temperature_before", "temperature_after"]
    else:
        raise ValueError("Failed.")

    env = Br_Env(nodes, 1)
    lower_bound = int(env.network_diameter())
    training = train_with_template(
        env=env,
        episodes=episodes,
        timeout_sec=_timeout_seconds(topology.node_count),
        alpha=alpha,
        gamma=gamma,
        state_encoder=QbrStateEncoder(),
        action_policy=action_policy,
        update_rule=QLearningUpdateRule(),
        candidate_finder=BroadcastCandidateFinder(),
        on_episode_start=lambda runtime_env: trees.build_bfs(runtime_env.V),
        export_q_table_all_epoch=False,
        completion_bonus_multiplier=completion_bonus_multiplier,
        lambda_param=lambda_param,
        trace_threshold=trace_threshold,
        action_axis=action_axis,
        q_snapshot_episodes={200, 450, 700, 1000, episodes},
    )
    episodes_steps = training.episodes_steps
    for item in episodes_steps:
        item["path_signature"] = _build_path_signature(item["steps"])
    qtable = training.qtable
    qtable_snapshots_by_episode = training.qtable_snapshots_by_episode
    total_rewards = training.total_rewards
    policy_rows = training.policy_rows
    best_delay = training.best_delay
    best_episode_index = training.best_episode_index

    bd = int(best_delay if best_delay != math.inf else 0)
    best_delay_episode_count = sum(1 for item in episodes_steps if int(item["delay"]) == bd)
    action_space_by_timeslot = _action_space_by_timeslot_summary(
        episodes_steps,
        "action_candidate_count",
        "rcv_cands" if action_axis == "receiver" else "br_cands",
    )
    action_space_by_timeslot_rcv = _action_space_by_timeslot_summary(episodes_steps, "rcv_candidate_count", "rcv_cands")
    action_space_by_timeslot_br = _action_space_by_timeslot_summary(episodes_steps, "br_candidate_count", "br_cands")
    q_profile_by_epoch = _q_profile_by_epoch_summary(
        episodes_steps,
        qtable_snapshots_by_episode,
        qtable,
        target_epochs=[200, 450, 700, 1000],
        fallback_episode=max(1, episodes),
        action_axis=action_axis,
    )

    artifact_root = Path(__file__).resolve().parents[4] / "storage" / "artifacts" / run_id
    artifact_root.mkdir(parents=True, exist_ok=True)

    last_episode_payload = episodes_steps[-1] if episodes_steps else {"episode": 0, "delay": 0, "steps": []}
    best_episode_payload = (
        episodes_steps[best_episode_index] if best_episode_index >= 0 else {"episode": 0, "delay": 0, "steps": []}
    )

    run_summary_path = artifact_root / "run_summary.json"
    q_table_path = artifact_root / "q_table.json"
    last_state_action_path = artifact_root / "state_action_last_epoch.json"
    best_state_action_path = artifact_root / "state_action_best_epoch.json"
    transmission_last_path = artifact_root / "transmission_last_epoch.json"
    transmission_best_path = artifact_root / "transmission_best_epoch.json"
    delay_csv_path = artifact_root / "delay_per_episode.csv"
    policy_csv_path = artifact_root / "policy_trace.csv"
    signature_csv_path = artifact_root / "path_signatures.csv"

    _write_json(
        run_summary_path,
        {
            "algorithm_id": "qbr",
            "run_id": run_id,
            "episodes": episodes,
            "alpha": alpha,
            "gamma": gamma,
            "policy_type": policy_type,
            "action_axis": action_axis,
            "completion_bonus_multiplier": completion_bonus_multiplier,
            "lambda_param": lambda_param,
            "trace_threshold": trace_threshold,
            "epsilon_end": epsilon_end if policy_type == "epsilon_greedy" else None,
            "temperature_end": temperature_end if policy_type == "softmax" else None,
            "temperature_decay_mode": temperature_decay_mode if policy_type == "softmax" else None,
            "finished_delay": int(last_episode_payload["delay"]),
            "best_delay_explored": int(best_delay if best_delay is not math.inf else 0),
            "best_episode": int(best_episode_payload["episode"]),
            "best_delay_episode_count": int(best_delay_episode_count),
            "lower_bound": lower_bound,
            "reward_final": float(total_rewards[-1] if total_rewards else 0.0),
            "action_space_by_timeslot": action_space_by_timeslot,
            "action_space_by_timeslot_rcv": action_space_by_timeslot_rcv,
            "action_space_by_timeslot_br": action_space_by_timeslot_br,
            "q_profile_by_epoch": q_profile_by_epoch,
        },
    )
    _write_json(q_table_path, qtable)
    _write_json(last_state_action_path, last_episode_payload)
    _write_json(best_state_action_path, best_episode_payload)
    _write_json(
        transmission_last_path,
        {
            "episode": last_episode_payload["episode"],
            "total_delay": last_episode_payload["delay"],
            "timeslots": _timeslot_transmission(last_episode_payload["steps"]),
        },
    )
    _write_json(
        transmission_best_path,
        {
            "episode": best_episode_payload["episode"],
            "total_delay": best_episode_payload["delay"],
            "timeslots": _timeslot_transmission(best_episode_payload["steps"]),
        },
    )

    _write_csv(
        delay_csv_path,
        ["episode", "delay", "total_reward"],
        [[item["episode"], item["delay"], item["total_reward"]] for item in episodes_steps],
    )
    _write_csv(policy_csv_path, policy_trace_header, policy_rows)
    _write_csv(
        signature_csv_path,
        ["episode", "path_signature"],
        [[item["episode"], item["path_signature"]] for item in episodes_steps],
    )

    return RunExecutionResult(
        finished_delay=int(last_episode_payload["delay"]),
        best_delay_explored=int(best_delay if best_delay is not math.inf else 0),
        lower_bound=lower_bound,
        reward_final=float(total_rewards[-1] if total_rewards else 0.0),
        artifact_paths={
            "run_summary": run_summary_path,
            "q_table": q_table_path,
            "state_action_last_epoch": last_state_action_path,
            "state_action_best_epoch": best_state_action_path,
            "transmission_last_epoch": transmission_last_path,
            "transmission_best_epoch": transmission_best_path,
            "delay_per_episode": delay_csv_path,
            "policy_trace": policy_csv_path,
            "path_signatures": signature_csv_path,
        },
    )

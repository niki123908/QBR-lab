from __future__ import annotations

import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from app.algorithms.br_env import Br_Env
from app.algorithms.common import trees
from app.services.runners.base import RunExecutionResult, RunnerContext, TOPOLOGY_RUN_TIMEOUT_SEC
from app.services.runners.qbr_components import (
    BroadcastCandidateFinder,
    EpsilonGreedyActionPolicy,
    QbrStateEncoder,
    QLearningUpdateRule,
    SoftmaxActionPolicy,
    UcbActionPolicy,
)
from app.services.playground_tree_service import build_run_decision_graph_from_episodes
from app.services.run_artifacts import (
    build_qbr_run_bundle,
    build_trace_epochs_payload,
    decision_graph_counts,
    q_table_learning_stats,
    write_gzip_json,
)
from app.services.runners.template import train_with_template


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
        if step.get("action_aggregated"):
            groups_raw = step.get("action_groups")
            group_ids: list[int] = []
            if isinstance(groups_raw, list):
                for group in groups_raw:
                    if not isinstance(group, dict):
                        continue
                    try:
                        group_ids.append(int(group.get("group_id")))
                    except (TypeError, ValueError):
                        continue
            if group_ids:
                q_values = [float(state_actions.get(group_id, 0.0)) for group_id in group_ids]
            else:
                q_values = [float(state_actions.get(action, 0.0)) for action in candidates]
        else:
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
    coverage_reward_enabled = bool(config.get("coverage_reward_enabled", True))
    lambda_param = float(config.get("lambda_param", 0.0))
    trace_threshold = float(config.get("trace_threshold", 0.01))
    ucb_c = float(config.get("ucb_c", 1.414))
    action_aggregation_mode = str(config.get("action_aggregation_mode", "off"))

    if policy_type == "epsilon_greedy":
        action_policy = EpsilonGreedyActionPolicy(
            epsilon_start=epsilon,
            epsilon_end=epsilon_end,
            epsilon_decay=epsilon_decay,
            action_axis=action_axis,
        )
    elif policy_type == "softmax":
        action_policy = SoftmaxActionPolicy(
            temperature_start=temperature_start,
            temperature_end=temperature_end,
            temperature_decay=temperature_decay,
            action_axis=action_axis,
            temperature_decay_mode=temperature_decay_mode,
        )
    elif policy_type == "ucb":
        action_policy = UcbActionPolicy(
            ucb_c=ucb_c,
            action_axis=action_axis,
        )
    else:
        raise ValueError("Failed.")

    env = Br_Env(nodes, 1)
    lower_bound = int(env.network_diameter())
    training = train_with_template(
        env=env,
        episodes=episodes,
        timeout_sec=TOPOLOGY_RUN_TIMEOUT_SEC,
        alpha=alpha,
        gamma=gamma,
        state_encoder=QbrStateEncoder(),
        action_policy=action_policy,
        update_rule=QLearningUpdateRule(),
        candidate_finder=BroadcastCandidateFinder(),
        on_episode_start=lambda runtime_env: trees.build_bfs(runtime_env.V),
        export_q_table_all_epoch=False,
        completion_bonus_multiplier=completion_bonus_multiplier,
        coverage_reward_enabled=coverage_reward_enabled,
        lambda_param=lambda_param,
        trace_threshold=trace_threshold,
        action_axis=action_axis,
        action_aggregation_mode=action_aggregation_mode,
        q_snapshot_episodes={200, 450, 700, 1000, episodes},
    )
    episodes_steps = training.episodes_steps
    for item in episodes_steps:
        item["path_signature"] = _build_path_signature(item["steps"])
    qtable = training.qtable
    qtable_snapshots_by_episode = training.qtable_snapshots_by_episode
    total_rewards = training.total_rewards
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
    action_space_by_timeslot_group = _action_space_by_timeslot_summary(
        episodes_steps,
        "action_group_count",
        "rcv_cands" if action_axis == "receiver" else "br_cands",
    )
    action_space_by_timeslot_group_rcv = _action_space_by_timeslot_summary(
        episodes_steps, "rcv_group_count", "rcv_cands"
    )
    action_space_by_timeslot_group_br = _action_space_by_timeslot_summary(
        episodes_steps, "br_group_count", "br_cands"
    )
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

    run_bundle_path = artifact_root / "run_bundle.json.gz"
    q_table_path = artifact_root / "q_table.json.gz"
    trace_epochs_path = artifact_root / "trace_epochs.json.gz"
    decision_graph_path = artifact_root / "run_decision_graph.json.gz"

    bundle_payload = build_qbr_run_bundle(
        run_id=run_id,
        episodes=episodes,
        policy_type=policy_type,
        action_axis=action_axis,
        action_aggregation_mode=action_aggregation_mode,
        alpha=alpha,
        gamma=gamma,
        completion_bonus_multiplier=completion_bonus_multiplier,
        coverage_reward_enabled=coverage_reward_enabled,
        lambda_param=lambda_param,
        trace_threshold=trace_threshold,
        epsilon_end=epsilon_end if policy_type == "epsilon_greedy" else None,
        temperature_end=temperature_end if policy_type == "softmax" else None,
        temperature_decay_mode=temperature_decay_mode if policy_type == "softmax" else None,
        ucb_c=ucb_c if policy_type == "ucb" else None,
        epsilon_start=epsilon if policy_type == "epsilon_greedy" else None,
        epsilon_decay=epsilon_decay if policy_type == "epsilon_greedy" else None,
        temperature_start=temperature_start if policy_type == "softmax" else None,
        temperature_decay=temperature_decay if policy_type == "softmax" else None,
        last_episode_payload=last_episode_payload,
        best_episode_payload=best_episode_payload,
        best_delay=int(best_delay if best_delay is not math.inf else 0),
        best_delay_episode_count=int(best_delay_episode_count),
        lower_bound=lower_bound,
        total_rewards=total_rewards,
        action_space_by_timeslot=action_space_by_timeslot,
        action_space_by_timeslot_rcv=action_space_by_timeslot_rcv,
        action_space_by_timeslot_br=action_space_by_timeslot_br,
        action_space_by_timeslot_group=action_space_by_timeslot_group,
        action_space_by_timeslot_group_rcv=action_space_by_timeslot_group_rcv,
        action_space_by_timeslot_group_br=action_space_by_timeslot_group_br,
        q_profile_by_epoch=q_profile_by_epoch,
        episodes_steps=episodes_steps,
        timeslot_transmission_fn=_timeslot_transmission,
    )
    write_gzip_json(run_bundle_path, bundle_payload)
    write_gzip_json(
        trace_epochs_path,
        build_trace_epochs_payload(last_episode_payload, best_episode_payload),
    )
    write_gzip_json(q_table_path, qtable)

    graph_mode = action_axis if action_axis in {"broadcaster", "receiver"} else "broadcaster"
    graph_payload = build_run_decision_graph_from_episodes(episodes_steps, default_mode=graph_mode)
    write_gzip_json(decision_graph_path, graph_payload)
    total_states, total_state_actions = q_table_learning_stats(qtable)
    _, decision_graph_edges = decision_graph_counts(graph_payload)

    return RunExecutionResult(
        finished_delay=int(last_episode_payload["delay"]),
        best_delay_explored=int(best_delay if best_delay is not math.inf else 0),
        lower_bound=lower_bound,
        reward_final=float(total_rewards[-1] if total_rewards else 0.0),
        total_states=total_states,
        total_state_actions=total_state_actions,
        decision_graph_edges=decision_graph_edges,
        artifact_paths={
            "run_bundle": run_bundle_path,
            "q_table": q_table_path,
            "trace_epochs": trace_epochs_path,
            "run_decision_graph": decision_graph_path,
        },
    )

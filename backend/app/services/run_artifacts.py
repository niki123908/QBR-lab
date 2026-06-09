"""Consolidated run artifact writers and legacy-compatible readers."""

from __future__ import annotations

import csv
import gzip
import json
from io import StringIO
from pathlib import Path
from typing import Any

RUN_BUNDLE_SCHEMA_VERSION = 1
TRACE_EPOCHS_SCHEMA_VERSION = 1
DECISION_GRAPH_SCHEMA_VERSION = 1


def write_gzip_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write(raw)


def read_artifact_file(path: Path) -> Any | None:
    if not path.exists() or not path.is_file():
        return None
    try:
        if path.suffix.lower() == ".gz" or path.name.endswith(".json.gz"):
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                return json.load(handle)
        if path.suffix.lower() == ".json":
            return json.loads(path.read_text(encoding="utf-8"))
        return {"text": path.read_text(encoding="utf-8")}
    except (OSError, json.JSONDecodeError):
        return None


def _transmission_payload(episode_payload: dict[str, Any], timeslot_fn) -> dict[str, Any]:
    return {
        "episode": int(episode_payload.get("episode") or 0),
        "total_delay": int(episode_payload.get("delay") or 0),
        "timeslots": timeslot_fn(episode_payload.get("steps") or []),
    }


def build_qbr_run_bundle(
    *,
    run_id: str,
    episodes: int,
    policy_type: str,
    action_axis: str,
    action_aggregation_mode: str,
    alpha: float,
    gamma: float,
    completion_bonus_multiplier: float,
    coverage_reward_enabled: bool,
    lambda_param: float,
    trace_threshold: float,
    epsilon_end: float | None,
    temperature_end: float | None,
    temperature_decay_mode: str | None,
    ucb_c: float | None,
    epsilon_start: float | None = None,
    epsilon_decay: float | None = None,
    temperature_start: float | None = None,
    temperature_decay: float | None = None,
    last_episode_payload: dict[str, Any],
    best_episode_payload: dict[str, Any],
    best_delay: int,
    best_delay_episode_count: int,
    lower_bound: int,
    total_rewards: list[float],
    action_space_by_timeslot: Any,
    action_space_by_timeslot_rcv: Any,
    action_space_by_timeslot_br: Any,
    action_space_by_timeslot_group: Any,
    action_space_by_timeslot_group_rcv: Any,
    action_space_by_timeslot_group_br: Any,
    q_profile_by_epoch: Any,
    episodes_steps: list[dict[str, Any]],
    timeslot_transmission_fn,
) -> dict[str, Any]:
    metrics = {
        "algorithm_id": "qbr",
        "run_id": run_id,
        "episodes": episodes,
        "alpha": alpha,
        "gamma": gamma,
        "policy_type": policy_type,
        "action_axis": action_axis,
        "action_aggregation_mode": action_aggregation_mode,
        "completion_bonus_multiplier": completion_bonus_multiplier,
        "coverage_reward_enabled": bool(coverage_reward_enabled),
        "lambda_param": lambda_param,
        "trace_threshold": trace_threshold,
        "epsilon_end": epsilon_end,
        "temperature_end": temperature_end,
        "temperature_decay_mode": temperature_decay_mode,
        "ucb_c": ucb_c,
        "finished_delay": int(last_episode_payload.get("delay") or 0),
        "best_delay_explored": int(best_delay),
        "best_episode": int(best_episode_payload.get("episode") or 0),
        "best_delay_episode_count": int(best_delay_episode_count),
        "lower_bound": lower_bound,
        "reward_final": float(total_rewards[-1] if total_rewards else 0.0),
        "action_space_by_timeslot": action_space_by_timeslot,
        "action_space_by_timeslot_rcv": action_space_by_timeslot_rcv,
        "action_space_by_timeslot_br": action_space_by_timeslot_br,
        "action_space_by_timeslot_group": action_space_by_timeslot_group,
        "action_space_by_timeslot_group_rcv": action_space_by_timeslot_group_rcv,
        "action_space_by_timeslot_group_br": action_space_by_timeslot_group_br,
        "q_profile_by_epoch": q_profile_by_epoch,
    }
    policy: dict[str, Any] = {
        "policy_type": policy_type,
        "action_axis": action_axis,
    }
    if policy_type == "epsilon_greedy":
        policy.update(
            {
                "epsilon_start": epsilon_start,
                "epsilon_end": epsilon_end,
                "epsilon_decay": epsilon_decay,
            }
        )
    elif policy_type == "softmax":
        policy.update(
            {
                "temperature_start": temperature_start,
                "temperature_end": temperature_end,
                "temperature_decay": temperature_decay,
                "temperature_decay_mode": temperature_decay_mode,
            }
        )
    elif policy_type == "ucb":
        policy["ucb_c"] = ucb_c

    episode_rows = [
        {
            "episode": int(item.get("episode") or 0),
            "delay": int(item.get("delay") or 0),
            "total_reward": float(item.get("total_reward") or 0.0),
            "path_signature": str(item.get("path_signature") or ""),
        }
        for item in episodes_steps
    ]
    return {
        "schema_version": RUN_BUNDLE_SCHEMA_VERSION,
        "algorithm_id": "qbr",
        "run_id": run_id,
        "metrics": metrics,
        "policy": policy,
        "episodes": episode_rows,
        "transmission": {
            "last": _transmission_payload(last_episode_payload, timeslot_transmission_fn),
            "best": _transmission_payload(best_episode_payload, timeslot_transmission_fn),
        },
    }


def build_trace_epochs_payload(
    last_episode_payload: dict[str, Any],
    best_episode_payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": TRACE_EPOCHS_SCHEMA_VERSION,
        "last": last_episode_payload,
        "best": best_episode_payload,
    }


def build_greedy_run_bundle(
    *,
    run_id: str,
    summary_payload: dict[str, Any],
    transmission_payload: dict[str, Any],
    state_action_payload: dict[str, Any],
) -> dict[str, Any]:
    delay = int(state_action_payload.get("delay") or summary_payload.get("finished_delay") or 0)
    return {
        "schema_version": RUN_BUNDLE_SCHEMA_VERSION,
        "algorithm_id": "greedy",
        "run_id": run_id,
        "metrics": summary_payload,
        "policy": {"policy_type": "greedy"},
        "episodes": [{"episode": 1, "delay": delay, "total_reward": 0.0, "path_signature": ""}],
        "transmission": {"last": transmission_payload, "best": transmission_payload},
    }


def build_cf_cas_run_bundle(
    *,
    run_id: str,
    summary_payload: dict[str, Any],
    transmission_payload: dict[str, Any],
    state_action_payload: dict[str, Any],
) -> dict[str, Any]:
    delay = int(state_action_payload.get("delay") or summary_payload.get("finished_delay") or 0)
    return {
        "schema_version": RUN_BUNDLE_SCHEMA_VERSION,
        "algorithm_id": "cf_cas",
        "run_id": run_id,
        "metrics": summary_payload,
        "policy": {"policy_type": "cf_cas"},
        "episodes": [{"episode": 1, "delay": delay, "total_reward": 0.0, "path_signature": ""}],
        "transmission": {"last": transmission_payload, "best": transmission_payload},
    }


def q_table_learning_stats(qtable: dict[str, Any]) -> tuple[int, int]:
    """Return (unique_states, state_action_pairs) from final Q-table."""
    if not isinstance(qtable, dict):
        return 0, 0
    total_states = len(qtable)
    total_state_actions = 0
    for actions in qtable.values():
        if isinstance(actions, dict):
            total_state_actions += len(actions)
    return total_states, total_state_actions


def decision_graph_counts(graph_payload: dict[str, Any] | None) -> tuple[int, int]:
    """Return (node_count, edge_count) from run_decision_graph artifact payload."""
    if not isinstance(graph_payload, dict):
        return 0, 0
    tree = graph_payload.get("tree") if isinstance(graph_payload.get("tree"), dict) else graph_payload
    if not isinstance(tree, dict):
        return 0, 0
    nodes = tree.get("nodes") if isinstance(tree.get("nodes"), list) else []
    edges = tree.get("edges") if isinstance(tree.get("edges"), list) else []
    return len(nodes), len(edges)


def learning_stats_from_episode_steps(episodes_steps: list[dict[str, Any]]) -> tuple[int, int]:
    """Unique state hashes and (state_hash, action) pairs seen across episode steps."""
    states: set[str] = set()
    pairs: set[tuple[str, int]] = set()
    for episode in episodes_steps:
        if not isinstance(episode, dict):
            continue
        steps = episode.get("steps")
        if not isinstance(steps, list):
            continue
        for step in steps:
            if not isinstance(step, dict):
                continue
            state_hash = str(step.get("state_hash") or "").strip()
            if not state_hash:
                continue
            states.add(state_hash)
            try:
                action = int(step["action"])
            except (TypeError, ValueError, KeyError):
                continue
            pairs.add((state_hash, action))
    return len(states), len(pairs)


def bundle_as_run_summary(bundle: dict[str, Any]) -> dict[str, Any]:
    metrics = dict(bundle.get("metrics") or {})
    if not metrics and bundle.get("finished_delay") is not None:
        return dict(bundle)
    return metrics


def episodes_to_delay_csv_text(episodes: list[dict[str, Any]]) -> str:
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["episode", "delay", "total_reward"])
    for row in episodes:
        writer.writerow(
            [
                row.get("episode", ""),
                row.get("delay", ""),
                row.get("total_reward", ""),
            ]
        )
    return buffer.getvalue()


def episodes_to_path_signatures_csv_text(episodes: list[dict[str, Any]]) -> str:
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["episode", "path_signature"])
    for row in episodes:
        writer.writerow([row.get("episode", ""), row.get("path_signature", "")])
    return buffer.getvalue()


def path_metrics_from_bundle_episodes(episodes: list[dict[str, Any]]) -> tuple[int | None, int | None]:
    if not episodes:
        return None, None
    signatures = [str(r.get("path_signature") or "").strip() for r in episodes]
    signatures = [s for s in signatures if s]
    unique_path_count = len(set(signatures)) if signatures else 0
    delays: list[tuple[int, int]] = []
    for row in episodes:
        try:
            delays.append((int(row["episode"]), int(row["delay"])))
        except (TypeError, ValueError, KeyError):
            continue
    if not delays:
        return unique_path_count, None
    best_delay = min(d for _, d in delays)
    best_eps = {ep for ep, d in delays if d == best_delay}
    best_sigs = {
        str(r.get("path_signature") or "").strip()
        for r in episodes
        if int(r.get("episode") or -1) in best_eps and str(r.get("path_signature") or "").strip()
    }
    return unique_path_count, len(best_sigs)


def delay_series_from_bundle_episodes(episodes: list[dict[str, Any]]) -> list[int]:
    series: list[tuple[int, int]] = []
    for row in episodes:
        try:
            series.append((int(row["episode"]), int(row["delay"])))
        except (TypeError, ValueError, KeyError):
            continue
    series.sort(key=lambda item: item[0])
    return [delay for _, delay in series]

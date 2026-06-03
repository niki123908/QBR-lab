from __future__ import annotations

import gzip
import json
from pathlib import Path

from app.services.artifact_payload import resolve_artifact_payload
from app.services.run_artifacts import (
    build_qbr_run_bundle,
    build_trace_epochs_payload,
    decision_graph_counts,
    episodes_to_delay_csv_text,
    path_metrics_from_bundle_episodes,
    q_table_learning_stats,
    write_gzip_json,
)


def test_build_bundle_and_legacy_aliases(tmp_path: Path) -> None:
    run_id = "test-run"
    root = tmp_path / run_id
    root.mkdir(parents=True)

    episodes_steps = [
        {"episode": 1, "delay": 10, "total_reward": 1.0, "path_signature": "a->b", "steps": []},
        {"episode": 2, "delay": 8, "total_reward": 2.0, "path_signature": "a->c", "steps": []},
    ]
    bundle = build_qbr_run_bundle(
        run_id=run_id,
        episodes=2,
        policy_type="epsilon_greedy",
        action_axis="broadcaster",
        action_aggregation_mode="off",
        alpha=0.2,
        gamma=0.8,
        completion_bonus_multiplier=1.0,
        coverage_reward_enabled=True,
        lambda_param=0.0,
        trace_threshold=0.01,
        epsilon_end=0.01,
        temperature_end=None,
        temperature_decay_mode=None,
        ucb_c=None,
        epsilon_start=1.0,
        epsilon_decay=0.1,
        temperature_start=None,
        temperature_decay=None,
        last_episode_payload=episodes_steps[1],
        best_episode_payload=episodes_steps[1],
        best_delay=8,
        best_delay_episode_count=1,
        lower_bound=3,
        total_rewards=[1.0, 2.0],
        action_space_by_timeslot={},
        action_space_by_timeslot_rcv={},
        action_space_by_timeslot_br={},
        action_space_by_timeslot_group={},
        action_space_by_timeslot_group_rcv={},
        action_space_by_timeslot_group_br={},
        q_profile_by_epoch={},
        episodes_steps=episodes_steps,
        timeslot_transmission_fn=lambda _steps: [],
    )
    bundle_path = root / "run_bundle.json.gz"
    write_gzip_json(bundle_path, bundle)
    trace_path = root / "trace_epochs.json.gz"
    write_gzip_json(trace_path, build_trace_epochs_payload(episodes_steps[1], episodes_steps[1]))

    import app.services.artifact_payload as ap

    original = ap._artifact_root
    ap._artifact_root = lambda _rid: root
    try:
        summary = resolve_artifact_payload(run_id, "run_summary")
        assert summary is not None
        assert summary["finished_delay"] == 8
        assert summary["best_delay_explored"] == 8

        delay_payload = resolve_artifact_payload(run_id, "delay_per_episode")
        assert delay_payload is not None
        assert "episode,delay,total_reward" in delay_payload["text"]

        unique, best_unique = path_metrics_from_bundle_episodes(bundle["episodes"])
        assert unique == 2
        assert best_unique == 1
    finally:
        ap._artifact_root = original


def test_gzip_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "sample.json.gz"
    write_gzip_json(path, {"hello": "world"})
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        loaded = json.load(handle)
    assert loaded["hello"] == "world"


def test_q_table_learning_stats() -> None:
    qtable = {
        "s1": {1: 0.5, 2: 0.1},
        "s2": {3: 0.0},
    }
    states, pairs = q_table_learning_stats(qtable)
    assert states == 2
    assert pairs == 3


def test_decision_graph_counts() -> None:
    nodes, edges = decision_graph_counts(
        {"tree": {"nodes": [{}, {}], "edges": [{}, {}, {}]}}
    )
    assert nodes == 2
    assert edges == 3


def test_episodes_to_delay_csv() -> None:
    text = episodes_to_delay_csv_text([{"episode": 1, "delay": 5, "total_reward": 0.5}])
    assert "1,5,0.5" in text

"""Deploy / inference rollout from an existing QBR Q-table (no learning)."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.algorithms.br_env import Br_Env, hash_state
from app.algorithms.common import trees
from app.core.db import db_session_scope, init_db
from app.core.paths import artifact_root_for_run
from app.models import Artifact, Run
from app.services.run_artifacts import (
    build_qbr_deploy_run_bundle,
    build_trace_epochs_payload,
    learning_stats_from_episode_steps,
    read_artifact_file,
    write_gzip_json,
)
from app.services.runners.action_aggregation import (
    StateActionRegistry,
    is_exact_next_state_aggregation,
)
from app.services.runners.base import RunExecutionResult, RunnerContext, TOPOLOGY_RUN_TIMEOUT_SEC
from app.services.runners.qbr_components import BroadcastCandidateFinder, QbrStateEncoder


def _normalize_qtable(raw: Any) -> dict[str, dict[int, float]]:
    if not isinstance(raw, dict):
        raise ValueError("Source Q-table is missing or invalid.")
    out: dict[str, dict[int, float]] = {}
    for state_hash, actions in raw.items():
        if not isinstance(actions, dict):
            continue
        normalized: dict[int, float] = {}
        for action_key, value in actions.items():
            try:
                normalized[int(action_key)] = float(value)
            except (TypeError, ValueError):
                continue
        out[str(state_hash)] = normalized
    if not out:
        raise ValueError("Source Q-table is empty.")
    return out


def _load_json_file(path: Path) -> Any:
    if not path.exists() or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _artifact_path_for_run(run_id: str, artifact_type: str) -> Path | None:
    init_db()
    with db_session_scope() as session:
        row = session.scalars(
            select(Artifact).where(Artifact.run_id == run_id, Artifact.artifact_type == artifact_type).limit(1)
        ).first()
        if row is not None and row.uri:
            return Path(row.uri)
    # Fallback to conventional layout
    candidate = artifact_root_for_run(run_id) / (
        "q_table.json.gz" if artifact_type == "q_table" else f"{artifact_type}.json"
    )
    if artifact_type == "resolved_run_config":
        candidate = artifact_root_for_run(run_id) / "resolved_run_config.json"
    return candidate if candidate.exists() else None


def resolve_source_run_id(*, topology_id: str, config: dict[str, Any]) -> str:
    source_run_id = str(config.get("source_run_id") or "").strip()
    if source_run_id:
        return source_run_id

    source_batch_run_id = str(config.get("source_batch_run_id") or "").strip()
    if not source_batch_run_id:
        raise ValueError("Deploy requires source_run_id or source_batch_run_id.")

    init_db()
    with db_session_scope() as session:
        row = session.scalars(
            select(Run)
            .where(
                Run.batch_run_group_id == source_batch_run_id,
                Run.topology_id == topology_id,
                Run.status == "done",
                Run.algorithm_id == "qbr",
            )
            .order_by(Run.created_at.desc())
            .limit(1)
        ).first()
        if row is None:
            raise ValueError(
                f"No done QBR run for topology in source batch {source_batch_run_id[:8]}."
            )
        return str(row.id)


def load_source_qbr_context(*, topology_id: str, config: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, dict[int, float]]]:
    source_run_id = resolve_source_run_id(topology_id=topology_id, config=config)

    init_db()
    with db_session_scope() as session:
        source = session.get(Run, source_run_id)
        if source is None:
            raise ValueError("Source run not found.")
        if source.status != "done":
            raise ValueError("Source run is not done.")
        if str(source.algorithm_id) != "qbr":
            raise ValueError("Source run must be a QBR training run.")
        if str(source.topology_id) != str(topology_id):
            raise ValueError("Source run topology does not match deploy topology.")

    q_path = _artifact_path_for_run(source_run_id, "q_table")
    if q_path is None:
        raise ValueError("Source run has no q_table artifact.")
    qtable = _normalize_qtable(read_artifact_file(q_path))

    resolved_path = _artifact_path_for_run(source_run_id, "resolved_run_config")
    source_config: dict[str, Any] = {}
    if resolved_path is not None:
        raw = _load_json_file(resolved_path) if resolved_path.suffix == ".json" else read_artifact_file(resolved_path)
        if isinstance(raw, dict):
            nested = raw.get("resolved_run_config")
            if isinstance(nested, dict):
                source_config = nested
            elif "action_axis" in raw or "action_aggregation_mode" in raw:
                source_config = raw

    return source_run_id, source_config, qtable


def _pick_greedy_action(
    *,
    env: Br_Env,
    qtable: dict[str, dict[int, float]],
    state_hash: str,
    action_axis: str,
    spread_mode: str,
    action_aggregation_mode: str,
    completion_bonus_multiplier: float,
    coverage_reward_enabled: bool,
    encoder: QbrStateEncoder,
    exact_registry: StateActionRegistry | None,
) -> tuple[int, float]:
    if state_hash not in qtable:
        raise ValueError(f"Unknown state in Q-table: {state_hash}")

    state_q = qtable[state_hash]
    candidates = sorted(list(env.rcv_cands if action_axis == "receiver" else env.br_cands))
    if not candidates:
        raise ValueError(f"No candidates at state {state_hash}.")

    if is_exact_next_state_aggregation(action_aggregation_mode):
        if exact_registry is None:
            raise ValueError("Failed.")
        groups = exact_registry.get_or_build_groups(
            env,
            state_hash,
            candidates,
            encode_state=encoder.encode_state,
            action_axis=action_axis,
            spread_mode=spread_mode,
            completion_bonus_multiplier=completion_bonus_multiplier,
            coverage_reward_enabled=coverage_reward_enabled,
        )
        if not groups:
            raise ValueError(f"No action groups at state {state_hash}.")
        best_group = max(
            groups,
            key=lambda group: (
                float(state_q.get(int(group.group_id), 0.0)),
                -int(group.group_id),
            ),
        )
        q_value = float(state_q.get(int(best_group.group_id), 0.0))
        return int(best_group.representative_action), q_value

    best_action = max(
        candidates,
        key=lambda action_id: (float(state_q.get(int(action_id), 0.0)), -int(action_id)),
    )
    return int(best_action), float(state_q.get(int(best_action), 0.0))


def execute_qbr_deploy(context: RunnerContext) -> RunExecutionResult:
    run_id = context.run_id
    topology = context.topology
    nodes = context.nodes
    config = context.config or {}

    source_run_id, source_config, qtable = load_source_qbr_context(
        topology_id=str(topology.id),
        config=config,
    )

    action_axis = str(source_config.get("action_axis") or config.get("action_axis") or "broadcaster")
    spread_mode = str(source_config.get("spread_mode") or config.get("spread_mode") or "normal")
    action_aggregation_mode = str(
        source_config.get("action_aggregation_mode") or config.get("action_aggregation_mode") or "off"
    )
    completion_bonus_multiplier = float(source_config.get("completion_bonus_multiplier", 1.0))
    coverage_reward_enabled = bool(source_config.get("coverage_reward_enabled", True))
    completion_exp_bonus_enabled = bool(source_config.get("completion_exp_bonus_enabled", False))

    env = Br_Env(nodes, 1)
    lower_bound = int(env.network_diameter())
    encoder = QbrStateEncoder()
    candidate_finder = BroadcastCandidateFinder()
    exact_registry = StateActionRegistry() if is_exact_next_state_aggregation(action_aggregation_mode) else None

    if spread_mode == "la":
        trees.prepare_latency_ahead(env.V)

    done = env.reset()
    env.cur_time = 0
    if spread_mode != "la":
        trees.build_bfs(env.V)

    total_reward = 0.0
    step_rows: list[dict[str, Any]] = []
    state_id_mapping: dict[str, int] = {}
    state_id_counter = 1
    timeout_sec = TOPOLOGY_RUN_TIMEOUT_SEC
    job_started = time.monotonic()

    rollout_t0 = time.perf_counter()
    while not done:
        if (time.monotonic() - job_started) > timeout_sec:
            raise TimeoutError(f"Deploy exceeded {timeout_sec}s wall-clock limit.")

        env.cur_time += 1
        has_candidates = candidate_finder.find(env)
        if not has_candidates:
            if len(env.V_ns) == 0:
                done = True
            else:
                done = True
            continue

        state_hash = encoder.encode_from_env(env)
        action, q_value = _pick_greedy_action(
            env=env,
            qtable=qtable,
            state_hash=state_hash,
            action_axis=action_axis,
            spread_mode=spread_mode,
            action_aggregation_mode=action_aggregation_mode,
            completion_bonus_multiplier=completion_bonus_multiplier,
            coverage_reward_enabled=coverage_reward_enabled,
            encoder=encoder,
            exact_registry=exact_registry,
        )
        next_state, reward, done, br_set, rcv_set = env.proceed_action(
            action,
            completion_bonus_multiplier=completion_bonus_multiplier,
            coverage_reward_enabled=coverage_reward_enabled,
            completion_exp_bonus_enabled=completion_exp_bonus_enabled,
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
                "action": int(action),
                "reward": float(reward),
                "q_before": float(q_value),
                "q_after": float(q_value),
                "rcv_set": sorted(list(set(rcv_set))),
                "br_set": sorted(list(set(br_set))),
            }
        )
        env.V_s = next_state
        total_reward += float(reward)

    rollout_runtime_ms = (time.perf_counter() - rollout_t0) * 1000.0

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
        "algorithm_id": "qbr_deploy",
        "run_id": run_id,
        "source_run_id": source_run_id,
        "finished_delay": int(env.cur_time),
        "best_delay_explored": int(env.cur_time),
        "lower_bound": lower_bound,
        "reward_final": float(total_reward),
        "action_axis": action_axis,
        "spread_mode": spread_mode,
        "action_aggregation_mode": action_aggregation_mode,
        "rollout_runtime_ms": float(rollout_runtime_ms),
        "rollout_runtime_sec": float(rollout_runtime_ms) / 1000.0,
    }

    write_gzip_json(
        run_bundle_path,
        build_qbr_deploy_run_bundle(
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
        rollout_runtime_ms=float(rollout_runtime_ms),
        artifact_paths={
            "run_bundle": run_bundle_path,
            "trace_epochs": trace_epochs_path,
        },
    )

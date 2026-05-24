from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone

import numpy as np
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import select

from app.algorithms.common.node import Node
from app.core.db import db_session_scope, init_db
from app.models import Artifact, BatchRunGroup, Run, RunMetric, Topology, TopologyNode
from app.repositories.run_repo import create_batch_run_enqueued
from app.repositories.run_repo import create_single_run_enqueued
from app.repositories.run_repo import get_run_execution_payload
from app.repositories.run_repo import reconcile_batch_run_group
from app.repositories.run_repo import try_resume_batch
from app.services.run_registry import get_algorithm_runner, resolve_and_validate_run_config
from app.services.runners.base import RunExecutionResult, RunnerContext


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _build_node_list(topology: Topology, rows: list[TopologyNode]) -> list[Node]:
    if not rows:
        raise ValueError("Failed.")
    max_node_id = max(row.node_id for row in rows)
    expected_ids = set(range(max_node_id + 1))
    existing_ids = {row.node_id for row in rows}
    if existing_ids != expected_ids:
        raise ValueError("Failed.")
    if 0 not in existing_ids:
        raise ValueError("Failed.")

    nodes: list[Node] = [Node(ID=i, x=0, y=0, timeslot=1) for i in range(max_node_id + 1)]
    for row in rows:
        nodes[row.node_id] = Node(ID=row.node_id, x=row.x, y=row.y, timeslot=1)

    threshold_sq = topology.tx_range * topology.tx_range
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            dx = nodes[i].x - nodes[j].x
            dy = nodes[i].y - nodes[j].y
            if (dx * dx + dy * dy) <= threshold_sq:
                nodes[i].neighbors.append(j)
                nodes[j].neighbors.append(i)
    return nodes


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


def _persist_run_success(run_id: str, topology_id: str, runtime_sec: float, result: RunExecutionResult) -> None:
    with db_session_scope() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise ValueError("Failed.")

        topology_row = session.get(Topology, topology_id)
        run.status = "done"
        run.runtime_sec = runtime_sec
        run.ended_at = _utcnow()
        run.error_message = None
        run.worker_id = None
        run.heartbeat_at = None
        run.claimed_at = None
        run.payload_json = None

        if topology_row is not None and not topology_row.is_deleted:
            topology_row.status = "done"
            topology_row.finished_delay = result.finished_delay
            topology_row.lower_bound = result.lower_bound
            topology_row.best_delay_explored = result.best_delay_explored

        metric = RunMetric(
            run_id=run_id,
            finished_delay=result.finished_delay,
            lower_bound=result.lower_bound,
            best_delay_explored=result.best_delay_explored,
            reward_final=result.reward_final,
        )
        session.add(metric)

        for artifact_type, path in result.artifact_paths.items():
            checksum: str | None = None
            if path.exists() and path.is_file():
                try:
                    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
                except OSError:
                    checksum = None
            artifact = Artifact(
                run_id=run_id,
                artifact_type=artifact_type,
                uri=path.as_posix(),
                size_bytes=path.stat().st_size if path.exists() else None,
                checksum=checksum,
            )
            session.add(artifact)


def _persist_run_failure(run_id: str, topology_id: str, started: float) -> None:
    with db_session_scope() as session:
        run = session.get(Run, run_id)
        topology = session.get(Topology, topology_id)
        if run is not None:
            run.status = "failed"
            run.runtime_sec = time.monotonic() - started
            run.ended_at = _utcnow()
            run.error_message = "Failed."
            run.worker_id = None
            run.heartbeat_at = None
            run.claimed_at = None
        if topology is not None and not topology.is_deleted:
            has_previous_success = (
                session.scalars(
                    select(Run.id).where(Run.topology_id == topology_id, Run.status == "done").limit(1)
                ).first()
                is not None
            )
            topology.status = "done" if has_previous_success else "new"


def _execute_run(
    run_id: str,
    topology_id: str,
    algorithm_id: str,
    preset_id: str,
    preset_name: str,
    run_config: dict[str, Any],
    kept_artifact_types: set[str] | None = None,
    draft_preset_id: str | None = None,
) -> None:
    started = time.monotonic()
    try:
        with db_session_scope() as session:
            run = session.get(Run, run_id)
            topology = session.get(Topology, topology_id)
            if run is None or topology is None or topology.is_deleted:
                raise ValueError("Failed.")
            node_rows = session.scalars(
                select(TopologyNode).where(TopologyNode.topology_id == topology_id).order_by(TopologyNode.node_id.asc())
            ).all()
            _ = _build_node_list(topology=topology, rows=node_rows)
            run.status = "running"
            run.started_at = _utcnow()
            topology.status = "running"

        resolved_config = resolve_and_validate_run_config(
            algorithm_id=algorithm_id,
            preset_id=preset_id,
            run_config=run_config,
            topology_context={"node_count": topology.node_count},
        )
        run_seed = resolved_config.get("run_seed")
        if run_seed is not None:
            np.random.seed(int(run_seed))
        artifact_root = Path(__file__).resolve().parents[3] / "storage" / "artifacts" / run_id
        resolved_config_path = artifact_root / "resolved_run_config.json"
        _write_json(
            resolved_config_path,
            {
                "run_id": run_id,
                "algorithm_id": algorithm_id,
                "preset_id": preset_id,
                "preset_name": preset_name,
                "draft_preset_id": draft_preset_id,
                "resolved_run_config": resolved_config,
            },
        )
        with db_session_scope() as session:
            topology = session.get(Topology, topology_id)
            node_rows = session.scalars(
                select(TopologyNode).where(TopologyNode.topology_id == topology_id).order_by(TopologyNode.node_id.asc())
            ).all()
            if topology is None:
                raise ValueError("Failed.")
            nodes = _build_node_list(topology=topology, rows=node_rows)
            runner = get_algorithm_runner(algorithm_id=algorithm_id)
            context = RunnerContext(run_id=run_id, topology=topology, nodes=nodes, config=resolved_config)
            result = runner(context)
        result.artifact_paths["resolved_run_config"] = resolved_config_path
        if kept_artifact_types is not None:
            result.artifact_paths = {k: v for k, v in result.artifact_paths.items() if k in kept_artifact_types}
        runtime_sec = time.monotonic() - started
        _persist_run_success(run_id=run_id, topology_id=topology_id, runtime_sec=runtime_sec, result=result)
    except Exception:
        _persist_run_failure(run_id=run_id, topology_id=topology_id, started=started)
        raise


def run_single_topology(
    topology_id: str,
    algorithm_id: str,
    preset_id: str,
    preset_name: str,
    run_config: dict[str, Any],
    draft_preset_id: str | None = None,
) -> str:
    init_db()
    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            raise ValueError("Failed.")

        node_rows = session.scalars(
            select(TopologyNode).where(TopologyNode.topology_id == topology_id).order_by(TopologyNode.node_id.asc())
        ).all()
        nodes = _build_node_list(topology=topology, rows=node_rows)

        _ = nodes  # validate before enqueue

    run_id = create_single_run_enqueued(
        topology_id=topology_id,
        algorithm_id=algorithm_id,
        preset_id=preset_id,
        payload={
            "topology_id": topology_id,
            "algorithm_id": algorithm_id,
            "preset_id": preset_id,
            "preset_name": preset_name,
            "run_config": run_config,
            "draft_preset_id": draft_preset_id,
        },
        queue_priority=0,
    )
    return run_id


def execute_queued_single_run(run_id: str) -> None:
    started = time.monotonic()
    try:
        payload = get_run_execution_payload(run_id)
        if not payload:
            raise ValueError("Failed.")
        _execute_run(
            run_id=run_id,
            topology_id=str(payload["topology_id"]),
            algorithm_id=str(payload["algorithm_id"]),
            preset_id=str(payload["preset_id"]),
            preset_name=str(payload.get("preset_name") or payload["preset_id"]),
            run_config=payload.get("run_config") or {},
            draft_preset_id=payload.get("draft_preset_id"),
        )
    except Exception:
        with db_session_scope() as session:
            row = session.get(Run, run_id)
            topology_id = row.topology_id if row is not None else ""
        if topology_id:
            _persist_run_failure(run_id=run_id, topology_id=topology_id, started=started)
        raise

def _load_batch_payload_and_pairs(batch_run_id: str) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    with db_session_scope() as session:
        g = session.get(BatchRunGroup, batch_run_id)
        if g is None:
            return {}, []
        payload = json.loads(g.payload_json)
        run_rows = session.scalars(
            select(Run).where(Run.batch_run_group_id == batch_run_id).order_by(Run.created_at.asc(), Run.id.asc())
        ).all()
        return payload, [(row.id, row.topology_id) for row in run_rows]


def execute_queued_batch_run(run_id: str) -> None:
    init_db()
    started = time.monotonic()
    batch_run_id = ""
    topology_id = ""
    try:
        with db_session_scope() as session:
            run_row = session.get(Run, run_id)
            if run_row is None or run_row.mode != "batch" or not run_row.batch_run_group_id:
                raise ValueError("Failed.")
            batch_run_id = run_row.batch_run_group_id
            payload, run_pairs = _load_batch_payload_and_pairs(batch_run_id)
            if not payload:
                raise ValueError("Failed.")
            topology_id = run_row.topology_id

        algorithm_id = str(payload["algorithm_id"])
        preset_id = str(payload["preset_id"])
        preset_name = str(payload.get("preset_name") or preset_id)
        run_config = payload.get("run_config") or {}
        raw_draft = payload.get("draft_preset_id")
        draft_preset_id = raw_draft.strip() if isinstance(raw_draft, str) and raw_draft.strip() else None
        save_full = bool(payload.get("save_full_artifacts_for_selected_runs"))
        selected_topology_set = set(payload.get("selected_artifact_topology_ids") or [])
        selected_types = list(payload.get("selected_artifact_types") or [])
        topology_ids = [tid for _, tid in run_pairs]
        if save_full and not selected_topology_set:
            selected_topology_set = set(topology_ids)
        artifact_type_set = _expand_partial_artifact_types(selected_types) if save_full else set()
        keep_types: set[str] | None = None
        if save_full:
            keep_types = artifact_type_set if topology_id in selected_topology_set else set()

        _execute_run(
            run_id=run_id,
            topology_id=topology_id,
            algorithm_id=algorithm_id,
            preset_id=preset_id,
            preset_name=preset_name,
            run_config=run_config,
            kept_artifact_types=keep_types,
            draft_preset_id=draft_preset_id,
        )
    except Exception:
        if topology_id:
            _persist_run_failure(run_id=run_id, topology_id=topology_id, started=started)
        raise
    finally:
        if batch_run_id:
            reconcile_batch_run_group(batch_run_id)


def resume_batch_job(batch_run_id: str) -> tuple[bool, str]:
    init_db()
    ok, msg = try_resume_batch(batch_run_id)
    return ok, msg


def _expand_partial_artifact_types(types: list[str]) -> set[str]:
    """Map UI / API artifact names to runner artifact dict keys (see qbr_runner artifact_paths)."""
    expanded: set[str] = {"resolved_run_config"}
    for raw in types:
        if raw == "path_signature":
            expanded.update(
                {
                    "path_signatures",
                    "delay_per_episode",
                    "state_action_best_epoch",
                    "transmission_best_epoch",
                }
            )
        elif raw == "delay_per_episode":
            expanded.add("delay_per_episode")
        else:
            expanded.add(raw)
    return expanded


def run_batch_topologies(
    topology_ids: list[str],
    algorithm_id: str,
    preset_id: str,
    preset_name: str,
    run_config: dict[str, Any],
    save_full_artifacts_for_selected_runs: bool,
    selected_artifact_topology_ids: list[str],
    selected_artifact_types: list[str],
    draft_preset_id: str | None = None,
) -> str:
    if not topology_ids:
        raise ValueError("Failed.")
    batch_run_id = str(uuid4())
    payload: dict[str, Any] = {
        "algorithm_id": algorithm_id,
        "preset_id": preset_id,
        "preset_name": preset_name,
        "run_config": run_config,
        "draft_preset_id": draft_preset_id,
        "save_full_artifacts_for_selected_runs": save_full_artifacts_for_selected_runs,
        "selected_artifact_topology_ids": list(selected_artifact_topology_ids),
        "selected_artifact_types": list(selected_artifact_types),
    }
    create_batch_run_enqueued(
        batch_run_id=batch_run_id,
        topology_ids=topology_ids,
        algorithm_id=algorithm_id,
        preset_id=preset_id,
        payload=payload,
    )
    return batch_run_id

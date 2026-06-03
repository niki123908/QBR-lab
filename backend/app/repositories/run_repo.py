from __future__ import annotations

import csv
from typing import Any
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import StringIO
from pathlib import Path

from sqlalchemy import or_, select

from app.core.db import db_session_scope, init_db
from app.models import Artifact, Batch, BatchRunGroup, Run, RunMetric, Topology


@dataclass
class RunHistoryRecord:
    run_id: str
    topology_id: str
    mode: str
    status: str
    warning_topology_changed: bool
    algorithm_id: str
    preset_id: str
    preset_name: str
    created_at: datetime
    finished_delay: int | None
    lower_bound: int | None
    best_delay_explored: int | None
    batch_run_id: str | None
    batch_result_label: str | None
    runtime_sec: float | None = None
    error_message: str | None = None
    total_states: int | None = None
    total_state_actions: int | None = None
    decision_graph_edges: int | None = None


@dataclass
class ArtifactRefRecord:
    artifact_type: str
    uri: str
    size_bytes: int | None
    checksum: str | None
    created_at: datetime


@dataclass
class RunDetailRecord:
    run_id: str
    topology_id: str
    mode: str
    status: str
    warning_topology_changed: bool
    algorithm_id: str
    preset_id: str
    preset_name: str
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None
    runtime_sec: float | None
    error_message: str | None
    finished_delay: int | None
    lower_bound: int | None
    best_delay_explored: int | None
    reward_final: float | None
    artifacts: list[ArtifactRefRecord]
    total_states: int | None = None
    total_state_actions: int | None = None
    decision_graph_edges: int | None = None


@dataclass
class BatchRunListRecord:
    batch_run_id: str
    batch_name: str
    algorithm_id: str
    preset_id: str
    preset_name: str
    result_label: str
    custom_result_label: str | None
    total_topologies: int
    successful: int
    failed: int
    created_at: datetime
    batch_status: str


@dataclass
class BatchRunProgressRow:
    run_id: str
    topology_id: str
    topology_name: str
    topology_index: int
    status: str


@dataclass
class BatchRunProgressRecord:
    batch_run_id: str
    batch_status: str
    stop_requested: bool
    total_topologies: int
    pending: int
    running: int
    done: int
    failed: int
    stopped: int
    rows: list[BatchRunProgressRow]


@dataclass
class QueueRunItemRecord:
    run_id: str
    topology_id: str
    topology_name: str
    mode: str
    status: str
    worker_id: str | None
    queue_priority: int
    batch_run_id: str | None
    batch_label: str | None
    created_at: datetime


@dataclass
class WorkerQueueLaneRecord:
    lane_id: str
    worker_id: str | None
    running: QueueRunItemRecord | None
    queued: list[QueueRunItemRecord]


@dataclass
class QueueSnapshotRecord:
    total_queued: int
    total_running: int
    lane_count: int
    lanes: list[WorkerQueueLaneRecord]


@dataclass
class BatchRunTopologyPointRecord:
    topology_id: str
    topology_name: str
    topology_index: int
    node_count: int
    status: str
    last_delay: int | None
    best_delay: int | None
    lower_bound: int | None
    unique_path_count: int | None
    best_delay_unique_path_count: int | None
    delay_per_episode: list[int]
    paths_count_by_delay: dict[int, int]
    total_states: int | None
    total_state_actions: int | None


@dataclass
class BatchRunDensityGroupRecord:
    node_count: int
    topologies: list[BatchRunTopologyPointRecord]


@dataclass
class BatchRunResultRecord:
    batch_run_id: str
    batch_name: str
    algorithm_id: str
    preset_id: str
    preset_name: str
    run_config: dict
    draft_preset_id: str | None
    result_label: str
    custom_result_label: str | None
    total_topologies: int
    successful: int
    failed: int
    density_groups: list[BatchRunDensityGroupRecord]
    topologies: list[BatchRunTopologyPointRecord]


@dataclass
class ClaimedRunRecord:
    run_id: str
    topology_id: str
    mode: str
    batch_run_group_id: str | None
    algorithm_id: str
    preset_id: str
    queue_priority: int
    attempt_count: int


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _resolve_batch_name(topologies: list[Topology], batch_by_id: dict[str, Batch]) -> str:
    batch_names = [batch_by_id[item.batch_id].name for item in topologies if item.batch_id in batch_by_id]
    if not batch_names:
        return "Unbatched"
    return Counter(batch_names).most_common(1)[0][0]


def _build_label(batch_name: str, preset_name: str) -> str:
    return f"{batch_name} -- {preset_name}"


def _batch_run_custom_label(group_row: BatchRunGroup | None) -> str | None:
    if group_row is None or group_row.result_label is None:
        return None
    custom = str(group_row.result_label).strip()
    return custom or None


def _batch_run_display_label(
    group_row: BatchRunGroup | None,
    *,
    batch_name: str,
    preset_name: str,
) -> str:
    custom = _batch_run_custom_label(group_row)
    if custom:
        return custom
    return _build_label(batch_name=batch_name, preset_name=preset_name)


def _natural_sort_key(text: str) -> tuple:
    parts = re.split(r"(\d+)", str(text or ""))
    key: list[object] = []
    for part in parts:
        if not part:
            continue
        if part.isdigit():
            key.append(int(part))
        else:
            key.append(part.lower())
    return tuple(key)


def _infer_batch_status_from_runs(run_items: list[Run]) -> str:
    statuses = {r.status for r in run_items}
    if "running" in statuses:
        return "running"
    if "queued" in statuses or "pending" in statuses:
        return "queued"
    if "stopped" in statuses:
        return "stopped"
    if statuses <= {"done", "failed"}:
        return "completed"
    return "queued"


def _resolved_batch_status(group_status: str | None, run_items: list[Run]) -> str:
    inferred = _infer_batch_status_from_runs(run_items)
    if not group_status:
        return inferred
    if inferred == "running":
        return "running"
    if inferred == "completed":
        return "completed"
    if inferred == "stopped":
        return "stopped"
    return group_status if group_status in {"queued", "running", "stopped", "completed", "failed"} else inferred


def create_batch_run_enqueued(
    batch_run_id: str,
    topology_ids: list[str],
    algorithm_id: str,
    preset_id: str,
    payload: dict,
    result_label: str | None = None,
) -> None:
    init_db()
    with db_session_scope() as session:
        unique_topology_ids = list(dict.fromkeys(topology_ids))
        if not unique_topology_ids:
            raise ValueError("Failed.")
        existing_ids = {
            row.id
            for row in session.scalars(
                select(Topology).where(Topology.id.in_(unique_topology_ids), Topology.is_deleted.is_(False))
            ).all()
        }
        if len(existing_ids) != len(unique_topology_ids):
            raise ValueError("Failed.")
        custom_label = str(result_label).strip() if result_label is not None else None
        if custom_label == "":
            custom_label = None
        session.add(
            BatchRunGroup(
                id=batch_run_id,
                status="queued",
                stop_requested=False,
                total_topologies=len(topology_ids),
                payload_json=json.dumps(payload, ensure_ascii=False),
                result_label=custom_label,
            )
        )
        for topology_id in topology_ids:
            session.add(
                Run(
                    topology_id=topology_id,
                    mode="batch",
                    batch_run_group_id=batch_run_id,
                    algorithm_id=algorithm_id,
                    config_id=preset_id,
                    status="queued",
                    attempt_count=0,
                    queue_priority=100,
                    created_at=_utcnow(),
                )
            )


def create_single_run_enqueued(
    topology_id: str,
    algorithm_id: str,
    preset_id: str,
    payload: dict,
    *,
    queue_priority: int = 0,
) -> str:
    init_db()
    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            raise ValueError("Failed.")
        run = Run(
            topology_id=topology_id,
            mode="single",
            algorithm_id=algorithm_id,
            config_id=preset_id,
            status="queued",
            attempt_count=0,
            queue_priority=int(queue_priority),
            payload_json=json.dumps(payload, ensure_ascii=False),
            created_at=_utcnow(),
        )
        session.add(run)
        session.flush()
        return run.id


def claim_next_queued_run(worker_id: str, *, modes: tuple[str, ...] | None = None) -> ClaimedRunRecord | None:
    init_db()
    with db_session_scope() as session:
        query = select(Run).where(Run.status == "queued")
        if modes:
            query = query.where(Run.mode.in_(modes))
        candidates = session.scalars(query.order_by(Run.queue_priority.asc(), Run.created_at.asc(), Run.id.asc()).limit(50)).all()
        row: Run | None = None
        for candidate in candidates:
            if candidate.batch_run_group_id is None:
                row = candidate
                break
            group = session.get(BatchRunGroup, candidate.batch_run_group_id)
            if group is None:
                row = candidate
                break
            if group.status == "stopped" or group.stop_requested:
                continue
            row = candidate
            break
        if row is None:
            return None

        now = _utcnow()
        row.status = "running"
        row.worker_id = worker_id
        row.claimed_at = now
        row.heartbeat_at = now
        row.started_at = row.started_at or now
        row.attempt_count = int(row.attempt_count or 0) + 1
        if row.batch_run_group_id:
            group = session.get(BatchRunGroup, row.batch_run_group_id)
            if group is not None:
                group.status = "running"
                group.started_at = group.started_at or now
                group.ended_at = None

        return ClaimedRunRecord(
            run_id=row.id,
            topology_id=row.topology_id,
            mode=row.mode,
            batch_run_group_id=row.batch_run_group_id,
            algorithm_id=row.algorithm_id,
            preset_id=row.config_id,
            queue_priority=row.queue_priority,
            attempt_count=row.attempt_count,
        )


def get_run_execution_payload(run_id: str) -> dict | None:
    init_db()
    with db_session_scope() as session:
        row = session.get(Run, run_id)
        if row is None or not row.payload_json:
            return None
        try:
            return json.loads(row.payload_json)
        except json.JSONDecodeError:
            return None


def heartbeat_run(run_id: str, worker_id: str) -> bool:
    init_db()
    with db_session_scope() as session:
        row = session.get(Run, run_id)
        if row is None or row.status != "running":
            return False
        if row.worker_id != worker_id:
            return False
        row.heartbeat_at = _utcnow()
        return True


def mark_run_stopped(run_id: str, worker_id: str | None = None) -> bool:
    init_db()
    with db_session_scope() as session:
        row = session.get(Run, run_id)
        if row is None:
            return False
        if worker_id is not None and row.worker_id not in {None, worker_id}:
            return False
        row.status = "stopped"
        row.heartbeat_at = None
        row.worker_id = None
        row.claimed_at = None
        row.ended_at = _utcnow()
        return True


def requeue_runs_for_worker(worker_id: str) -> int:
    init_db()
    with db_session_scope() as session:
        rows = session.scalars(select(Run).where(Run.status == "running", Run.worker_id == worker_id)).all()
        if not rows:
            return 0
        for row in rows:
            row.status = "queued"
            row.worker_id = None
            row.claimed_at = None
            row.heartbeat_at = None
            row.started_at = None
            row.ended_at = None
            topology = session.get(Topology, row.topology_id)
            if topology is not None and not topology.is_deleted:
                has_previous_success = (
                    session.scalars(
                        select(Run.id).where(Run.topology_id == row.topology_id, Run.status == "done").limit(1)
                    ).first()
                    is not None
                )
                topology.status = "done" if has_previous_success else "new"
        group_ids = sorted({row.batch_run_group_id for row in rows if row.batch_run_group_id})
        for group_id in group_ids:
            group = session.get(BatchRunGroup, group_id)
            if group is None:
                continue
            group.status = "queued"
            group.ended_at = None
            group.stop_requested = False
        return len(rows)


def requeue_stale_runs(*, stale_after_seconds: int) -> list[str]:
    init_db()
    stale_before = _utcnow() - timedelta(seconds=max(0, int(stale_after_seconds)))
    with db_session_scope() as session:
        rows = session.scalars(
            select(Run).where(
                Run.status == "running",
                or_(
                    Run.worker_id.is_(None),
                    Run.heartbeat_at.is_(None),
                    Run.heartbeat_at < stale_before,
                ),
            )
        ).all()
        reclaimed: list[str] = []
        for row in rows:
            row.status = "queued"
            row.worker_id = None
            row.claimed_at = None
            row.heartbeat_at = None
            row.started_at = None
            row.ended_at = None
            topology = session.get(Topology, row.topology_id)
            if topology is not None and not topology.is_deleted:
                has_previous_success = (
                    session.scalars(
                        select(Run.id).where(Run.topology_id == row.topology_id, Run.status == "done").limit(1)
                    ).first()
                    is not None
                )
                topology.status = "done" if has_previous_success else "new"
            reclaimed.append(row.id)
        group_ids = sorted({row.batch_run_group_id for row in rows if row.batch_run_group_id})
        for group_id in group_ids:
            group = session.get(BatchRunGroup, group_id)
            if group is None:
                continue
            group.status = "queued"
            group.ended_at = None
            group.stop_requested = False
        return reclaimed


def request_batch_stop(batch_run_id: str) -> bool:
    init_db()
    with db_session_scope() as session:
        g = session.get(BatchRunGroup, batch_run_id)
        if g is None:
            return False
        if g.status in ("completed", "failed", "stopped"):
            return False
        g.stop_requested = True
        run_rows = session.scalars(select(Run).where(Run.batch_run_group_id == batch_run_id)).all()
        has_running = any(row.status == "running" for row in run_rows)
        if not has_running:
            for row in run_rows:
                if row.status == "queued":
                    row.status = "stopped"
            g.status = "stopped"
            g.ended_at = _utcnow()
            g.stop_requested = False
        return True


def finalize_batch_stopped(batch_run_id: str) -> None:
    init_db()
    with db_session_scope() as session:
        g = session.get(BatchRunGroup, batch_run_id)
        if g is not None:
            run_rows = session.scalars(select(Run).where(Run.batch_run_group_id == batch_run_id)).all()
            for row in run_rows:
                if row.status == "queued":
                    row.status = "stopped"
            g.status = "stopped"
            g.ended_at = _utcnow()
            g.stop_requested = False


def update_batch_run_group(batch_run_id: str, *, status: str | None = None, ended: bool = False) -> None:
    init_db()
    with db_session_scope() as session:
        g = session.get(BatchRunGroup, batch_run_id)
        if g is None:
            return
        if status is not None:
            g.status = status
        if ended:
            g.ended_at = datetime.now(timezone.utc)
        if status == "running" and g.started_at is None:
            g.started_at = datetime.now(timezone.utc)


def try_resume_batch(batch_run_id: str) -> tuple[bool, str]:
    init_db()
    with db_session_scope() as session:
        g = session.get(BatchRunGroup, batch_run_id)
        if g is None:
            return False, "not_found"
        if g.status != "stopped":
            return False, "invalid_state"
        resumable_rows = session.scalars(
            select(Run).where(Run.batch_run_group_id == batch_run_id, Run.status == "stopped")
        ).all()
        if not resumable_rows:
            return False, "nothing_to_resume"
        for row in resumable_rows:
            row.status = "queued"
            row.ended_at = None
        g.stop_requested = False
        g.status = "queued"
        g.ended_at = None
        return True, "ok"


def reconcile_batch_run_group(batch_run_id: str) -> str | None:
    init_db()
    with db_session_scope() as session:
        g = session.get(BatchRunGroup, batch_run_id)
        if g is None:
            return None
        run_rows = session.scalars(select(Run).where(Run.batch_run_group_id == batch_run_id)).all()
        if not run_rows:
            g.status = "completed"
            g.ended_at = _utcnow()
            g.stop_requested = False
            return g.status

        statuses = {row.status for row in run_rows}
        if g.stop_requested:
            has_running = "running" in statuses
            if not has_running:
                for row in run_rows:
                    if row.status == "queued":
                        row.status = "stopped"
                g.status = "stopped"
                g.ended_at = _utcnow()
                g.stop_requested = False
                return g.status

        if "running" in statuses:
            g.status = "running"
            g.ended_at = None
            if g.started_at is None:
                g.started_at = _utcnow()
            return g.status

        if "queued" in statuses:
            g.status = "queued"
            g.ended_at = None
            return g.status

        if statuses <= {"done", "failed"}:
            g.status = "completed"
            g.ended_at = _utcnow()
            g.stop_requested = False
            return g.status

        if "stopped" in statuses:
            g.status = "stopped"
            g.ended_at = _utcnow()
            g.stop_requested = False
            return g.status

        return g.status


def get_batch_run_progress(batch_run_id: str) -> BatchRunProgressRecord | None:
    init_db()
    with db_session_scope() as session:
        run_items = session.scalars(
            select(Run)
            .where(Run.batch_run_group_id == batch_run_id)
            .order_by(Run.created_at.asc(), Run.id.asc())
        ).all()
        if not run_items:
            return None
        g = session.get(BatchRunGroup, batch_run_id)
        topology_ids = [item.topology_id for item in run_items]
        topologies = session.scalars(select(Topology).where(Topology.id.in_(topology_ids))).all() if topology_ids else []
        tmap = {t.id: t for t in topologies}
        counts = Counter(r.status for r in run_items)
        pending = counts.get("queued", 0) + counts.get("pending", 0)
        running = counts.get("running", 0)
        done = counts.get("done", 0)
        failed = counts.get("failed", 0)
        stopped = counts.get("stopped", 0)
        batch_status = _resolved_batch_status(g.status if g is not None else None, run_items)
        stop_requested = g.stop_requested if g is not None else False
        display_items = [
            (
                tmap.get(r.topology_id).name if tmap.get(r.topology_id) is not None else r.topology_id,
                r,
            )
            for r in run_items
        ]
        display_items.sort(key=lambda item: _natural_sort_key(item[0]))
        rows: list[BatchRunProgressRow] = []
        for idx, (topology_name, r) in enumerate(display_items):
            rows.append(
                BatchRunProgressRow(
                    run_id=r.id,
                    topology_id=r.topology_id,
                    topology_name=topology_name,
                    topology_index=idx,
                    status=r.status,
                )
            )
        return BatchRunProgressRecord(
            batch_run_id=batch_run_id,
            batch_status=batch_status,
            stop_requested=stop_requested,
            total_topologies=len(run_items),
            pending=pending,
            running=running,
            done=done,
            failed=failed,
            stopped=stopped,
            rows=rows,
        )


def _artifact_uri(session, run_id: str, artifact_type: str) -> str | None:
    row = session.scalars(
        select(Artifact).where(Artifact.run_id == run_id, Artifact.artifact_type == artifact_type).limit(1)
    ).first()
    return row.uri if row else None


def _read_csv_rows(uri: str | None) -> list[dict[str, str]]:
    if not uri:
        return []
    path = Path(uri)
    if not path.exists() or not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    reader = csv.DictReader(StringIO(text))
    return [dict(row) for row in reader]


def _path_metrics_from_csvs(path_rows: list[dict[str, str]], delay_rows: list[dict[str, str]]) -> tuple[int | None, int | None]:
    """Match RightControlPanel: unique paths; best-delay episodes then unique path sigs among those."""
    if not path_rows:
        return None, None
    signatures = [row.get("path_signature", "").strip() for row in path_rows if row.get("path_signature", "").strip()]
    unique_path_count = len(set(signatures)) if signatures else 0

    if not delay_rows:
        return unique_path_count, None

    delays: list[tuple[int, int]] = []
    for row in delay_rows:
        try:
            ep = int(row.get("episode", ""))
            d = int(row.get("delay", ""))
        except (TypeError, ValueError):
            continue
        delays.append((ep, d))
    if not delays:
        return unique_path_count, None

    best_delay = min(d for _, d in delays)
    best_episodes = {ep for ep, d in delays if d == best_delay}

    path_sigs_at_best: set[str] = set()
    for row in path_rows:
        try:
            ep = int(row.get("episode", ""))
        except (TypeError, ValueError):
            continue
        if ep in best_episodes:
            sig = row.get("path_signature", "").strip()
            if sig:
                path_sigs_at_best.add(sig)
    best_delay_unique = len(path_sigs_at_best)
    return unique_path_count, best_delay_unique


def _load_run_bundle_episodes(session, run_id: str) -> list[dict[str, Any]]:
    from app.services.artifact_payload import resolve_artifact_payload

    bundle = resolve_artifact_payload(run_id, "run_bundle", uri_path=None)
    if isinstance(bundle, dict) and isinstance(bundle.get("episodes"), list):
        return [row for row in bundle["episodes"] if isinstance(row, dict)]
    bundle_uri = _artifact_uri(session, run_id, "run_bundle")
    if bundle_uri:
        bundle = resolve_artifact_payload(run_id, "run_bundle", uri_path=Path(bundle_uri))
        if isinstance(bundle, dict) and isinstance(bundle.get("episodes"), list):
            return [row for row in bundle["episodes"] if isinstance(row, dict)]
    return []


def _batch_run_path_metrics_for_run(session, run_id: str) -> tuple[int | None, int | None]:
    episodes = _load_run_bundle_episodes(session, run_id)
    if episodes:
        from app.services.run_artifacts import path_metrics_from_bundle_episodes

        return path_metrics_from_bundle_episodes(episodes)
    path_uri = _artifact_uri(session, run_id, "path_signatures")
    delay_uri = _artifact_uri(session, run_id, "delay_per_episode")
    path_rows = _read_csv_rows(path_uri)
    delay_rows = _read_csv_rows(delay_uri)
    return _path_metrics_from_csvs(path_rows, delay_rows)


def _paths_count_by_delay_for_run(session, run_id: str) -> dict[int, int]:
    """Unique path_signature count per finished delay (from run_bundle episodes)."""
    episodes = _load_run_bundle_episodes(session, run_id)
    if not episodes:
        return {}
    by_delay: dict[int, set[str]] = {}
    for row in episodes:
        if not isinstance(row, dict):
            continue
        try:
            delay = int(row.get("delay"))
        except (TypeError, ValueError):
            continue
        signature = str(row.get("path_signature") or "").strip()
        if not signature:
            continue
        by_delay.setdefault(delay, set()).add(signature)
    return {delay: len(signatures) for delay, signatures in sorted(by_delay.items())}


def _delay_per_episode_series_for_run(session, run_id: str) -> list[int]:
    episodes = _load_run_bundle_episodes(session, run_id)
    if episodes:
        from app.services.run_artifacts import delay_series_from_bundle_episodes

        return delay_series_from_bundle_episodes(episodes)
    delay_uri = _artifact_uri(session, run_id, "delay_per_episode")
    delay_rows = _read_csv_rows(delay_uri)
    series: list[tuple[int, int]] = []
    for row in delay_rows:
        try:
            ep = int(row.get("episode", ""))
            delay = int(row.get("delay", ""))
        except (TypeError, ValueError):
            continue
        series.append((ep, delay))
    series.sort(key=lambda item: item[0])
    return [delay for _, delay in series]


def list_run_history(topology_id: str) -> list[RunHistoryRecord]:
    init_db()
    with db_session_scope() as session:
        rows = session.scalars(select(Run).where(Run.topology_id == topology_id).order_by(Run.created_at.desc())).all()
        group_ids = {row.batch_run_group_id for row in rows if row.mode == "batch" and row.batch_run_group_id}
        group_label_map: dict[str, str] = {}
        group_preset_name_map: dict[str, str] = {}
        if group_ids:
            grouped_runs = session.scalars(
                select(Run)
                .where(Run.batch_run_group_id.in_(group_ids))
                .order_by(Run.created_at.asc(), Run.id.asc())
            ).all()
            by_group: dict[str, list[Run]] = {}
            for item in grouped_runs:
                if not item.batch_run_group_id:
                    continue
                by_group.setdefault(item.batch_run_group_id, []).append(item)
            topo_ids = {item.topology_id for item in grouped_runs}
            topologies = session.scalars(select(Topology).where(Topology.id.in_(topo_ids))).all() if topo_ids else []
            topo_by_id = {item.id: item for item in topologies}
            batch_ids = {item.batch_id for item in topologies if item.batch_id}
            batches = session.scalars(select(Batch).where(Batch.id.in_(batch_ids))).all() if batch_ids else []
            batch_by_id = {item.id: item for item in batches}
            for group_id, run_items in by_group.items():
                sample = run_items[0]
                linked = [topo_by_id[item.topology_id] for item in run_items if item.topology_id in topo_by_id]
                batch_name = _resolve_batch_name(linked, batch_by_id=batch_by_id)
                group_row = session.get(BatchRunGroup, group_id)
                payload = json.loads(group_row.payload_json) if group_row is not None and group_row.payload_json else {}
                preset_name = str(payload.get("preset_name") or sample.config_id)
                group_preset_name_map[group_id] = preset_name
                group_label_map[group_id] = _batch_run_display_label(
                    group_row,
                    batch_name=batch_name,
                    preset_name=preset_name,
                )
        result: list[RunHistoryRecord] = []
        for row in rows:
            metric = session.get(RunMetric, row.id)
            preset_name = row.config_id
            if row.mode == "batch" and row.batch_run_group_id:
                preset_name = group_preset_name_map.get(row.batch_run_group_id, row.config_id)
            else:
                resolved_row = session.scalars(
                    select(Artifact)
                    .where(Artifact.run_id == row.id, Artifact.artifact_type == "resolved_run_config")
                    .limit(1)
                ).first()
                if resolved_row is not None:
                    try:
                        payload = json.loads(Path(resolved_row.uri).read_text(encoding="utf-8"))
                        preset_name = str(payload.get("preset_name") or row.config_id)
                    except (OSError, json.JSONDecodeError):
                        preset_name = row.config_id
            result.append(
                RunHistoryRecord(
                    run_id=row.id,
                    topology_id=row.topology_id,
                    mode=row.mode,
                    status=row.status,
                    warning_topology_changed=row.warning_topology_changed,
                    algorithm_id=row.algorithm_id,
                    preset_id=row.config_id,
                    preset_name=preset_name,
                    created_at=row.created_at,
                    finished_delay=metric.finished_delay if metric else None,
                    lower_bound=metric.lower_bound if metric else None,
                    best_delay_explored=metric.best_delay_explored if metric else None,
                    batch_run_id=row.batch_run_group_id,
                    batch_result_label=group_label_map.get(row.batch_run_group_id or ""),
                    runtime_sec=float(row.runtime_sec) if row.runtime_sec is not None else None,
                    error_message=row.error_message,
                    total_states=metric.total_states if metric else None,
                    total_state_actions=metric.total_state_actions if metric else None,
                    decision_graph_edges=metric.decision_graph_edges if metric else None,
                )
            )
        return result


def list_topology_ids_with_single_runs() -> list[str]:
    init_db()
    with db_session_scope() as session:
        rows = session.scalars(select(Run.topology_id).where(Run.mode == "single", Run.status == "done")).all()
        # Keep stable order and deduplicate.
        return sorted(set(rows))


def delete_run(run_id: str) -> bool:
    init_db()
    with db_session_scope() as session:
        row = session.get(Run, run_id)
        if row is None:
            return False
        session.delete(row)
        return True


def delete_batch_run(batch_run_id: str) -> bool:
    init_db()
    with db_session_scope() as session:
        rows = session.scalars(select(Run).where(Run.batch_run_group_id == batch_run_id)).all()
        if not rows:
            return False
        # Best-effort cleanup for artifact files/folders on disk.
        artifact_rows = session.scalars(
            select(Artifact).where(Artifact.run_id.in_([row.id for row in rows]))
        ).all()
        deleted_dirs: set[str] = set()
        for artifact in artifact_rows:
            path = Path(artifact.uri)
            try:
                if path.exists() and path.is_file():
                    path.unlink(missing_ok=True)
            except OSError:
                pass
            parent = str(path.parent.resolve()) if path.parent else ""
            if parent and parent not in deleted_dirs:
                deleted_dirs.add(parent)
                try:
                    if path.parent.exists():
                        path.parent.rmdir()
                except OSError:
                    pass
        for row in rows:
            session.delete(row)
        g = session.get(BatchRunGroup, batch_run_id)
        if g is not None:
            session.delete(g)
        return True


def get_artifact_payload(run_id: str, artifact_type: str):
    from app.services.artifact_payload import resolve_artifact_payload

    init_db()
    with db_session_scope() as session:
        row = session.scalars(
            select(Artifact).where(Artifact.run_id == run_id, Artifact.artifact_type == artifact_type).limit(1)
        ).first()
        uri_path = Path(row.uri) if row is not None else None
        if uri_path is not None and uri_path.exists() and uri_path.is_file():
            direct = resolve_artifact_payload(run_id, artifact_type, uri_path=uri_path)
            if direct is not None:
                return direct
        return resolve_artifact_payload(run_id, artifact_type, uri_path=None)


def get_run_detail(run_id: str) -> RunDetailRecord | None:
    init_db()
    with db_session_scope() as session:
        row = session.get(Run, run_id)
        if row is None:
            return None
        metric = session.get(RunMetric, run_id)
        artifacts = session.scalars(
            select(Artifact).where(Artifact.run_id == run_id).order_by(Artifact.created_at.asc())
        ).all()
        preset_name = row.config_id
        resolved_row = session.scalars(
            select(Artifact).where(Artifact.run_id == row.id, Artifact.artifact_type == "resolved_run_config").limit(1)
        ).first()
        if resolved_row is not None:
            try:
                payload = json.loads(Path(resolved_row.uri).read_text(encoding="utf-8"))
                preset_name = str(payload.get("preset_name") or row.config_id)
            except (OSError, json.JSONDecodeError):
                preset_name = row.config_id
        return RunDetailRecord(
            run_id=row.id,
            topology_id=row.topology_id,
            mode=row.mode,
            status=row.status,
            warning_topology_changed=row.warning_topology_changed,
            algorithm_id=row.algorithm_id,
            preset_id=row.config_id,
            preset_name=preset_name,
            created_at=row.created_at,
            started_at=row.started_at,
            ended_at=row.ended_at,
            runtime_sec=row.runtime_sec,
            error_message=row.error_message,
            finished_delay=metric.finished_delay if metric else None,
            lower_bound=metric.lower_bound if metric else None,
            best_delay_explored=metric.best_delay_explored if metric else None,
            reward_final=metric.reward_final if metric else None,
            total_states=metric.total_states if metric else None,
            total_state_actions=metric.total_state_actions if metric else None,
            decision_graph_edges=metric.decision_graph_edges if metric else None,
            artifacts=[
                ArtifactRefRecord(
                    artifact_type=item.artifact_type,
                    uri=item.uri,
                    size_bytes=item.size_bytes,
                    checksum=item.checksum,
                    created_at=item.created_at,
                )
                for item in artifacts
            ],
        )


def list_batch_runs() -> list[BatchRunListRecord]:
    init_db()
    with db_session_scope() as session:
        rows = session.scalars(
            select(Run)
            .where(Run.mode == "batch", Run.batch_run_group_id.is_not(None))
            .order_by(Run.created_at.desc())
        ).all()
        grouped: dict[str, list[Run]] = {}
        for item in rows:
            if item.batch_run_group_id is None:
                continue
            grouped.setdefault(item.batch_run_group_id, []).append(item)

        topology_ids = {item.topology_id for item in rows}
        topologies = session.scalars(select(Topology).where(Topology.id.in_(topology_ids))).all() if topology_ids else []
        topology_by_id = {item.id: item for item in topologies}

        batch_ids = {item.batch_id for item in topologies if item.batch_id}
        batches = session.scalars(select(Batch).where(Batch.id.in_(batch_ids))).all() if batch_ids else []
        batch_by_id = {item.id: item for item in batches}

        result: list[BatchRunListRecord] = []
        for batch_run_id, run_items in grouped.items():
            run_items_sorted = sorted(run_items, key=lambda x: (x.created_at, x.id))
            sample = run_items_sorted[0]
            linked_topologies = [topology_by_id[item.topology_id] for item in run_items_sorted if item.topology_id in topology_by_id]
            batch_name = _resolve_batch_name(linked_topologies, batch_by_id=batch_by_id)
            total = len(run_items_sorted)
            successful = sum(1 for item in run_items_sorted if item.status == "done")
            failed = sum(1 for item in run_items_sorted if item.status == "failed")
            group_row = session.get(BatchRunGroup, batch_run_id)
            batch_status = _resolved_batch_status(group_row.status if group_row is not None else None, run_items_sorted)
            payload = json.loads(group_row.payload_json) if group_row is not None and group_row.payload_json else {}
            preset_name = str(payload.get("preset_name") or sample.config_id)
            display_label = _batch_run_display_label(
                group_row,
                batch_name=batch_name,
                preset_name=preset_name,
            )
            result.append(
                BatchRunListRecord(
                    batch_run_id=batch_run_id,
                    batch_name=batch_name,
                    algorithm_id=sample.algorithm_id,
                    preset_id=sample.config_id,
                    preset_name=preset_name,
                    result_label=display_label,
                    custom_result_label=_batch_run_custom_label(group_row),
                    total_topologies=total,
                    successful=successful,
                    failed=failed,
                    created_at=sample.created_at,
                    batch_status=batch_status,
                )
            )
        return sorted(result, key=lambda x: x.created_at, reverse=True)


def update_batch_run_result_label(batch_run_id: str, result_label: str | None) -> bool:
    init_db()
    clean = str(result_label).strip() if result_label is not None else None
    if clean == "":
        clean = None
    with db_session_scope() as session:
        row = session.get(BatchRunGroup, batch_run_id)
        if row is None:
            return False
        row.result_label = clean
        return True


def get_queue_snapshot() -> QueueSnapshotRecord:
    init_db()
    with db_session_scope() as session:
        run_rows = session.scalars(
            select(Run)
            .where(Run.status.in_(("queued", "running")))
            .order_by(Run.queue_priority.asc(), Run.created_at.asc(), Run.id.asc())
        ).all()
        if not run_rows:
            return QueueSnapshotRecord(total_queued=0, total_running=0, lane_count=0, lanes=[])

        topology_ids = {row.topology_id for row in run_rows}
        topologies = session.scalars(select(Topology).where(Topology.id.in_(topology_ids))).all() if topology_ids else []
        topology_by_id = {row.id: row for row in topologies}

        group_ids = {row.batch_run_group_id for row in run_rows if row.batch_run_group_id}
        group_rows = session.scalars(select(BatchRunGroup).where(BatchRunGroup.id.in_(group_ids))).all() if group_ids else []
        group_by_id = {row.id: row for row in group_rows}

        batch_ids = {row.batch_id for row in topologies if row.batch_id}
        batch_rows = session.scalars(select(Batch).where(Batch.id.in_(batch_ids))).all() if batch_ids else []
        batch_by_id = {row.id: row for row in batch_rows}

        def _item_from_run(run_row: Run) -> QueueRunItemRecord:
            topo = topology_by_id.get(run_row.topology_id)
            batch_label: str | None = None
            if run_row.batch_run_group_id:
                group = group_by_id.get(run_row.batch_run_group_id)
                payload = json.loads(group.payload_json) if group is not None and group.payload_json else {}
                preset_name = str(payload.get("preset_name") or run_row.config_id)
                topo_batch = batch_by_id.get(topo.batch_id) if topo is not None and topo.batch_id else None
                batch_name = topo_batch.name if topo_batch is not None else "Batch"
                batch_label = _build_label(batch_name=batch_name, preset_name=preset_name)
            return QueueRunItemRecord(
                run_id=run_row.id,
                topology_id=run_row.topology_id,
                topology_name=topo.name if topo is not None else run_row.topology_id,
                mode=run_row.mode,
                status=run_row.status,
                worker_id=run_row.worker_id,
                queue_priority=int(run_row.queue_priority or 100),
                batch_run_id=run_row.batch_run_group_id,
                batch_label=batch_label,
                created_at=run_row.created_at,
            )

        running_rows = [row for row in run_rows if row.status == "running"]
        queued_rows = [row for row in run_rows if row.status == "queued"]
        worker_ids = [row.worker_id for row in running_rows if row.worker_id]
        worker_ids = list(dict.fromkeys(sorted(worker_ids)))
        lane_ids = worker_ids[:] if worker_ids else ["queue"]
        lanes: list[WorkerQueueLaneRecord] = []
        for lane_id in lane_ids:
            running_row = next((row for row in running_rows if row.worker_id == lane_id), None) if lane_id != "queue" else None
            lanes.append(
                WorkerQueueLaneRecord(
                    lane_id=lane_id,
                    worker_id=lane_id if lane_id != "queue" else None,
                    running=_item_from_run(running_row) if running_row is not None else None,
                    queued=[],
                )
            )

        if not lanes:
            lanes.append(WorkerQueueLaneRecord(lane_id="queue", worker_id=None, running=None, queued=[]))

        for index, row in enumerate(queued_rows):
            lane = lanes[index % len(lanes)]
            lane.queued.append(_item_from_run(row))

        return QueueSnapshotRecord(
            total_queued=len(queued_rows),
            total_running=len(running_rows),
            lane_count=len(lanes),
            lanes=lanes,
        )


def get_batch_run_result(batch_run_id: str) -> BatchRunResultRecord | None:
    init_db()
    with db_session_scope() as session:
        run_items = session.scalars(
            select(Run)
            .where(Run.mode == "batch", Run.batch_run_group_id == batch_run_id)
            .order_by(Run.created_at.asc(), Run.id.asc())
        ).all()
        if not run_items:
            return None

        topology_ids = [item.topology_id for item in run_items]
        topologies = session.scalars(select(Topology).where(Topology.id.in_(topology_ids))).all()
        topology_by_id = {item.id: item for item in topologies}

        batch_ids = {item.batch_id for item in topologies if item.batch_id}
        batches = session.scalars(select(Batch).where(Batch.id.in_(batch_ids))).all() if batch_ids else []
        batch_by_id = {item.id: item for item in batches}

        metrics = session.scalars(select(RunMetric).where(RunMetric.run_id.in_([item.id for item in run_items]))).all()
        metric_by_run_id = {item.run_id: item for item in metrics}

        linked_topologies = [topology_by_id[item.topology_id] for item in run_items if item.topology_id in topology_by_id]
        batch_name = _resolve_batch_name(linked_topologies, batch_by_id=batch_by_id)
        sample = run_items[0]
        group_row = session.get(BatchRunGroup, batch_run_id)
        payload = json.loads(group_row.payload_json) if group_row is not None and group_row.payload_json else {}
        preset_name = str(payload.get("preset_name") or sample.config_id)
        run_config = payload.get("run_config")
        if not isinstance(run_config, dict):
            run_config = {}
        draft_preset_id = payload.get("draft_preset_id")
        if draft_preset_id is not None:
            draft_preset_id = str(draft_preset_id)

        display_run_items = sorted(
            run_items,
            key=lambda run_item: _natural_sort_key(
                topology_by_id.get(run_item.topology_id).name if topology_by_id.get(run_item.topology_id) is not None else run_item.topology_id
            ),
        )

        points: list[BatchRunTopologyPointRecord] = []
        for index, run_item in enumerate(display_run_items):
            topology = topology_by_id.get(run_item.topology_id)
            metric = metric_by_run_id.get(run_item.id)
            unique_paths, best_unique_paths = (
                _batch_run_path_metrics_for_run(session, run_item.id) if run_item.status == "done" else (None, None)
            )
            delay_per_episode = _delay_per_episode_series_for_run(session, run_item.id) if run_item.status == "done" else []
            paths_by_delay = _paths_count_by_delay_for_run(session, run_item.id) if run_item.status == "done" else {}
            points.append(
                BatchRunTopologyPointRecord(
                    topology_id=run_item.topology_id,
                    topology_name=topology.name if topology is not None else run_item.topology_id,
                    topology_index=index,
                    node_count=topology.node_count if topology is not None else 0,
                    status=run_item.status,
                    last_delay=metric.finished_delay if metric else None,
                    best_delay=metric.best_delay_explored if metric else None,
                    lower_bound=metric.lower_bound if metric else None,
                    unique_path_count=unique_paths,
                    best_delay_unique_path_count=best_unique_paths,
                    delay_per_episode=delay_per_episode,
                    paths_count_by_delay=paths_by_delay,
                    total_states=metric.total_states if metric else None,
                    total_state_actions=metric.total_state_actions if metric else None,
                )
            )

        density_buckets: dict[int, list[BatchRunTopologyPointRecord]] = {}
        for item in points:
            density_buckets.setdefault(item.node_count, []).append(item)
        density_groups = [
            BatchRunDensityGroupRecord(node_count=node_count, topologies=items)
            for node_count, items in sorted(density_buckets.items(), key=lambda x: x[0])
        ]

        display_label = _batch_run_display_label(
            group_row,
            batch_name=batch_name,
            preset_name=preset_name,
        )
        return BatchRunResultRecord(
            batch_run_id=batch_run_id,
            batch_name=batch_name,
            algorithm_id=sample.algorithm_id,
            preset_id=sample.config_id,
            preset_name=preset_name,
            run_config=run_config,
            draft_preset_id=draft_preset_id,
            result_label=display_label,
            custom_result_label=_batch_run_custom_label(group_row),
            total_topologies=len(display_run_items),
            successful=sum(1 for item in display_run_items if item.status == "done"),
            failed=sum(1 for item in display_run_items if item.status == "failed"),
            density_groups=density_groups,
            topologies=points,
        )

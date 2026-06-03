from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
import random

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import db_session_scope, init_db
from app.models import Batch, Run, Topology, TopologyMetric, TopologyNode


@dataclass
class NodeRecord:
    node_id: int
    x: int
    y: int


@dataclass
class TopologyRecord:
    topology_id: str
    topology_name: str
    status: Literal["new", "done", "pending", "running"]
    node_count: int
    space_width: int
    space_height: int
    tx_range: float
    sink_mode: str
    sink_x: int
    sink_y: int
    seed: int | None
    nodes: list[NodeRecord]
    finished_delay: int | None
    lower_bound: int | None
    best_delay_explored: int | None
    created_at: datetime


@dataclass
class BatchRecord:
    batch_id: str
    batch_name: str
    is_locked: bool
    topologies: list[TopologyRecord]


DEFAULT_BATCH_NAME = "Default batch"
LOCK_MARKER = "[LOCKED]"


def _get_or_create_default_batch(session: Session) -> Batch:
    row = session.scalars(select(Batch).where(Batch.name == DEFAULT_BATCH_NAME)).first()
    if row is not None:
        return row
    row = Batch(name=DEFAULT_BATCH_NAME, description="Auto-created default batch")
    session.add(row)
    session.flush()
    return row


def _batch_locked(batch: Batch) -> bool:
    return bool(batch.description and LOCK_MARKER in batch.description)


def _natural_topology_name_key(name: str) -> tuple[int | str, ...]:
    """Sort tp_250_00 before tp_250_01 … before tp_250_200 (not lexicographic / created_at)."""
    value = (name or "").strip().lower()
    parts: list[int | str] = []
    for chunk in re.split(r"(\d+)", value):
        if not chunk:
            continue
        parts.append(int(chunk) if chunk.isdigit() else chunk)
    return tuple(parts)


def _next_topology_name(session: Session, node_count: int, batch_id: str) -> str:
    prefix = f"tp_{node_count}_"
    rows = session.scalars(
        select(Topology.name).where(
            Topology.batch_id == batch_id,
            Topology.is_deleted.is_(False),
            Topology.name.like(f"{prefix}%"),
        )
    ).all()
    max_suffix = -1
    for name in rows:
        try:
            suffix = int(name.rsplit("_", 1)[1])
            if suffix > max_suffix:
                max_suffix = suffix
        except (ValueError, IndexError):
            continue
    return f"{prefix}{max_suffix + 1:02d}"


def _resolve_batch_id(session: Session, batch_id: str | None) -> str:
    if batch_id is None:
        return _get_or_create_default_batch(session).id
    batch = session.get(Batch, batch_id)
    if batch is None:
        return _get_or_create_default_batch(session).id
    return batch.id


def allocate_unique_seed() -> int:
    init_db()
    with db_session_scope() as session:
        used = set(
            session.scalars(
                select(Topology.seed).where(Topology.is_deleted.is_(False), Topology.seed.is_not(None))
            ).all()
        )
        while True:
            candidate = random.randint(1, 9_999_999)
            if candidate not in used:
                return candidate


def _to_record(topology: Topology, lower_bound: int | None = None) -> TopologyRecord:
    return TopologyRecord(
        topology_id=topology.id,
        topology_name=topology.name,
        status=topology.status,  # type: ignore[assignment]
        node_count=topology.node_count,
        space_width=topology.space_width,
        space_height=topology.space_height,
        tx_range=topology.tx_range,
        sink_mode=topology.sink_mode,
        sink_x=topology.sink_x,
        sink_y=topology.sink_y,
        seed=topology.seed,
        nodes=[NodeRecord(node_id=node.node_id, x=node.x, y=node.y) for node in topology.nodes],
        finished_delay=None,
        lower_bound=lower_bound,
        best_delay_explored=None,
        created_at=topology.created_at,
    )


def _to_list_record(topology: Topology, lower_bound: int | None = None) -> TopologyRecord:
    """Lightweight row for list/batch APIs (no per-topology node fetch)."""
    return TopologyRecord(
        topology_id=topology.id,
        topology_name=topology.name,
        status=topology.status,  # type: ignore[assignment]
        node_count=topology.node_count,
        space_width=topology.space_width,
        space_height=topology.space_height,
        tx_range=topology.tx_range,
        sink_mode=topology.sink_mode,
        sink_x=topology.sink_x,
        sink_y=topology.sink_y,
        seed=topology.seed,
        nodes=[],
        finished_delay=None,
        lower_bound=lower_bound,
        best_delay_explored=None,
        created_at=topology.created_at,
    )


def create_topology(
    node_count: int,
    space_width: int,
    space_height: int,
    tx_range: float,
    sink_mode: str,
    sink_x: int,
    sink_y: int,
    seed: int | None,
    nodes: list[NodeRecord],
    batch_id: str | None = None,
) -> TopologyRecord:
    init_db()
    with db_session_scope() as session:
        resolved_batch_id = _resolve_batch_id(session, batch_id=batch_id)
        topology = Topology(
            batch_id=resolved_batch_id,
            name=_next_topology_name(session=session, node_count=node_count, batch_id=resolved_batch_id),
            node_count=node_count,
            space_width=space_width,
            space_height=space_height,
            tx_range=tx_range,
            sink_mode=sink_mode,
            sink_x=sink_x,
            sink_y=sink_y,
            seed=seed,
            status="new",
        )
        session.add(topology)
        session.flush()

        for node in nodes:
            session.add(
                TopologyNode(
                    topology_id=topology.id,
                    node_id=node.node_id,
                    x=node.x,
                    y=node.y,
                )
            )

        session.flush()
        session.refresh(topology)
        # Load nodes after flush.
        topology.nodes = session.scalars(
            select(TopologyNode).where(TopologyNode.topology_id == topology.id).order_by(TopologyNode.node_id.asc())
        ).all()
        return _to_record(topology)


def _load_lower_bound_map(session: Session, topology_ids: list[str]) -> dict[str, int | None]:
    if not topology_ids:
        return {}
    rows = session.scalars(select(TopologyMetric).where(TopologyMetric.topology_id.in_(topology_ids))).all()
    return {row.topology_id: row.lower_bound for row in rows}


def list_topologies(
    status: str | None = None,
    node_count: int | None = None,
    lower_bound: int | None = None,
) -> list[TopologyRecord]:
    init_db()
    with db_session_scope() as session:
        query = select(Topology).where(Topology.is_deleted.is_(False)).order_by(Topology.created_at.desc())
        if status is not None:
            query = query.where(Topology.status == status)
        if node_count is not None:
            query = query.where(Topology.node_count == node_count)
        if lower_bound is not None:
            query = query.join(TopologyMetric, TopologyMetric.topology_id == Topology.id).where(
                TopologyMetric.lower_bound == lower_bound
            )

        topologies = session.scalars(query).all()
        lower_bound_map = _load_lower_bound_map(session, [topology.id for topology in topologies])
        return [
            _to_list_record(topology, lower_bound=lower_bound_map.get(topology.id)) for topology in topologies
        ]


def list_batches(
    status: str | None = None,
    node_count: int | None = None,
    lower_bound: int | None = None,
) -> list[BatchRecord]:
    init_db()
    with db_session_scope() as session:
        batches = session.scalars(select(Batch).order_by(Batch.created_at.desc())).all()
        result: list[BatchRecord] = []
        for batch in batches:
            query = select(Topology).where(Topology.batch_id == batch.id, Topology.is_deleted.is_(False))
            if status is not None:
                query = query.where(Topology.status == status)
            if node_count is not None:
                query = query.where(Topology.node_count == node_count)
            if lower_bound is not None:
                query = query.join(TopologyMetric, TopologyMetric.topology_id == Topology.id).where(
                    TopologyMetric.lower_bound == lower_bound
                )
            topologies = session.scalars(query).all()
            topologies = sorted(topologies, key=lambda row: _natural_topology_name_key(row.name))
            lower_bound_map = _load_lower_bound_map(session, [topology.id for topology in topologies])
            topo_records = [
                _to_list_record(topology, lower_bound=lower_bound_map.get(topology.id)) for topology in topologies
            ]

            result.append(
                BatchRecord(
                    batch_id=batch.id,
                    batch_name=batch.name,
                    is_locked=_batch_locked(batch),
                    topologies=topo_records,
                )
            )
        return result


def create_batch(name: str) -> str:
    init_db()
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("Failed.")
    with db_session_scope() as session:
        existing = session.scalars(select(Batch).where(Batch.name == clean_name)).first()
        if existing is not None:
            return existing.id
        row = Batch(name=clean_name, description=None)
        session.add(row)
        session.flush()
        return row.id


def rename_batch(batch_id: str, name: str) -> bool:
    init_db()
    clean_name = name.strip()
    if not clean_name:
        return False
    with db_session_scope() as session:
        batch = session.get(Batch, batch_id)
        if batch is None:
            return False
        existing = session.scalars(select(Batch).where(Batch.name == clean_name, Batch.id != batch_id)).first()
        if existing is not None:
            return False
        batch.name = clean_name
        return True


def set_batch_locked(batch_id: str, locked: bool) -> bool:
    init_db()
    with db_session_scope() as session:
        batch = session.get(Batch, batch_id)
        if batch is None:
            return False
        desc = batch.description or ""
        had_marker = LOCK_MARKER in desc
        if locked and not had_marker:
            batch.description = f"{desc} {LOCK_MARKER}".strip()
        if not locked and had_marker:
            batch.description = desc.replace(LOCK_MARKER, "").strip() or None
        return True


def delete_batch(batch_id: str) -> bool:
    init_db()
    with db_session_scope() as session:
        batch = session.get(Batch, batch_id)
        if batch is None:
            return False
        if batch.name == DEFAULT_BATCH_NAME:
            return False

        rows = session.scalars(select(Topology).where(Topology.batch_id == batch_id)).all()
        for row in rows:
            run_rows = session.scalars(select(Run).where(Run.topology_id == row.id)).all()
            for run_row in run_rows:
                run_row.warning_topology_changed = True
            row.is_deleted = True
            row.batch_id = None
            row.updated_at = datetime.utcnow()
        session.delete(batch)
        return True


def get_topology_nodes(topology_id: str) -> list[NodeRecord] | None:
    init_db()
    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            return None
        rows = session.scalars(
            select(TopologyNode).where(TopologyNode.topology_id == topology_id).order_by(TopologyNode.node_id.asc())
        ).all()
        return [NodeRecord(node_id=row.node_id, x=row.x, y=row.y) for row in rows]


def get_topology(topology_id: str) -> TopologyRecord | None:
    init_db()
    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            return None
        topology.nodes = session.scalars(
            select(TopologyNode).where(TopologyNode.topology_id == topology_id).order_by(TopologyNode.node_id.asc())
        ).all()
        metric = session.get(TopologyMetric, topology_id)
        return _to_record(topology, lower_bound=metric.lower_bound if metric else None)


def upsert_topology_lower_bound(topology_id: str, lower_bound: int | None) -> None:
    init_db()
    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            return
        metric = session.get(TopologyMetric, topology_id)
        if metric is None:
            metric = TopologyMetric(topology_id=topology_id, lower_bound=lower_bound)
            session.add(metric)
        else:
            metric.lower_bound = lower_bound


def apply_topology_node_updates(topology_id: str, updates: dict[int, tuple[int, int]]) -> tuple[bool, str | None]:
    if not updates:
        return True, None

    init_db()
    try:
        with db_session_scope() as session:
            topology = session.get(Topology, topology_id)
            if topology is None or topology.is_deleted:
                return False, "Failed."

            rows = session.scalars(select(TopologyNode).where(TopologyNode.topology_id == topology_id)).all()
            row_by_id = {row.node_id: row for row in rows}

            for node_id, (x, y) in updates.items():
                row = row_by_id.get(node_id)
                if row is None:
                    return False, "Failed."
                row.x = x
                row.y = y

            topology.updated_at = datetime.utcnow()
        return True, None
    except IntegrityError:
        return False, "Failed."


def mark_topology_runs_warning(topology_id: str) -> None:
    init_db()
    with db_session_scope() as session:
        rows = session.scalars(select(Run).where(Run.topology_id == topology_id)).all()
        for row in rows:
            row.warning_topology_changed = True


def delete_topology(topology_id: str) -> bool:
    init_db()
    with db_session_scope() as session:
        row = session.get(Topology, topology_id)
        if row is None or row.is_deleted:
            return False
        run_rows = session.scalars(select(Run).where(Run.topology_id == topology_id)).all()
        for run_row in run_rows:
            run_row.warning_topology_changed = True
        row.is_deleted = True
        row.updated_at = datetime.utcnow()
        return True

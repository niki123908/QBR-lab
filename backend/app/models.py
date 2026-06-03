from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Batch(Base):
    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class BatchRunGroup(Base):
    """One row per multi-topology batch job (async worker updates status)."""

    __tablename__ = "batch_run_groups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    status: Mapped[str] = mapped_column(
        String(16), default="queued", nullable=False
    )  # queued | running | stopped | completed | failed
    stop_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    total_topologies: Mapped[int] = mapped_column(Integer, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    result_label: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Topology(Base):
    __tablename__ = "topologies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    batch_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("batches.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    node_count: Mapped[int] = mapped_column(Integer, nullable=False)
    space_width: Mapped[int] = mapped_column(Integer, nullable=False)
    space_height: Mapped[int] = mapped_column(Integer, nullable=False)
    tx_range: Mapped[float] = mapped_column(Float, nullable=False)
    sink_mode: Mapped[str] = mapped_column(String(64), nullable=False)
    sink_x: Mapped[int] = mapped_column(Integer, nullable=False)
    sink_y: Mapped[int] = mapped_column(Integer, nullable=False)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="new", nullable=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    nodes: Mapped[list["TopologyNode"]] = relationship(
        back_populates="topology", cascade="all, delete-orphan", passive_deletes=True
    )
    runs: Mapped[list["Run"]] = relationship(back_populates="topology", passive_deletes=True)
    metric: Mapped["TopologyMetric | None"] = relationship(
        back_populates="topology", uselist=False, cascade="all, delete-orphan", passive_deletes=True
    )
    playground_tree: Mapped["TopologyPlaygroundTree | None"] = relationship(
        back_populates="topology", uselist=False, cascade="all, delete-orphan", passive_deletes=True
    )


class TopologyNode(Base):
    __tablename__ = "topology_nodes"
    __table_args__ = (
        UniqueConstraint("topology_id", "node_id", name="uq_topology_node_id"),
        UniqueConstraint("topology_id", "x", "y", name="uq_topology_xy"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    topology_id: Mapped[str] = mapped_column(String(36), ForeignKey("topologies.id", ondelete="CASCADE"), nullable=False)
    node_id: Mapped[int] = mapped_column(Integer, nullable=False)
    x: Mapped[int] = mapped_column(Integer, nullable=False)
    y: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    topology: Mapped["Topology"] = relationship(back_populates="nodes")


class TopologyMetric(Base):
    __tablename__ = "topology_metrics"

    topology_id: Mapped[str] = mapped_column(String(36), ForeignKey("topologies.id", ondelete="CASCADE"), primary_key=True)
    lower_bound: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    topology: Mapped["Topology"] = relationship(back_populates="metric")


class TopologyPlaygroundTree(Base):
    """Persisted Playground state decision tree per topology."""

    __tablename__ = "topology_playground_trees"

    topology_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("topologies.id", ondelete="CASCADE"), primary_key=True
    )
    tree_json: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    topology: Mapped["Topology"] = relationship(back_populates="playground_tree")


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    topology_id: Mapped[str] = mapped_column(String(36), ForeignKey("topologies.id"), nullable=False)
    mode: Mapped[str] = mapped_column(String(16), nullable=False)  # single | batch
    batch_run_group_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    algorithm_id: Mapped[str] = mapped_column(String(128), nullable=False)
    config_id: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # queued|running|done|failed|stopped
    worker_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    queue_priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    warning_topology_changed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    runtime_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    topology: Mapped["Topology"] = relationship(back_populates="runs")
    metrics: Mapped["RunMetric | None"] = relationship(
        back_populates="run", uselist=False, cascade="all, delete-orphan", passive_deletes=True
    )
    artifacts: Mapped[list["Artifact"]] = relationship(
        back_populates="run", cascade="all, delete-orphan", passive_deletes=True
    )


class RunMetric(Base):
    __tablename__ = "run_metrics"

    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("runs.id", ondelete="CASCADE"), primary_key=True)
    finished_delay: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lower_bound: Mapped[int | None] = mapped_column(Integer, nullable=True)
    best_delay_explored: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reward_final: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_states: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_state_actions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    decision_graph_edges: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    run: Mapped["Run"] = relationship(back_populates="metrics")


class RunPreset(Base):
    """Saved run configuration presets (QBR / GREEDY) for the UI."""

    __tablename__ = "run_presets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    backbone: Mapped[str] = mapped_column(String(16), nullable=False)
    algorithm_id: Mapped[str] = mapped_column(String(32), nullable=False)
    run_config_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("runs.id", ondelete="CASCADE"), nullable=False)
    artifact_type: Mapped[str] = mapped_column(String(64), nullable=False)
    uri: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checksum: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    run: Mapped["Run"] = relationship(back_populates="artifacts")

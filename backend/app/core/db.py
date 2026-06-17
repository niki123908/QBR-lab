from __future__ import annotations

import os
import threading
from contextlib import contextmanager

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from app.core.env import default_database_url, ensure_qbr_env

ensure_qbr_env()

def _normalize_database_url(url: str) -> str:
    """Use psycopg v3 (psycopg[binary]) — plain postgresql:// defaults to missing psycopg2."""
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://") :]
    return url


DATABASE_URL = _normalize_database_url(os.getenv("DATABASE_URL", "").strip() or default_database_url())

if DATABASE_URL.startswith("sqlite"):
    raise RuntimeError(
        "SQLite is no longer supported. Set DATABASE_URL to PostgreSQL "
        "(see .env.example and README.md)."
    )

if not DATABASE_URL.startswith("postgresql"):
    raise RuntimeError("DATABASE_URL must be a PostgreSQL connection URL.")

engine = create_engine(
    DATABASE_URL,
    future=True,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)
Base = declarative_base()

_db_initialized = False
_db_init_lock = threading.Lock()


def _ensure_run_queue_columns() -> None:
    inspector = inspect(engine)
    if "runs" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("runs")}
    ddl_by_column = {
        "worker_id": "ALTER TABLE runs ADD COLUMN worker_id VARCHAR(64)",
        "heartbeat_at": "ALTER TABLE runs ADD COLUMN heartbeat_at TIMESTAMP WITH TIME ZONE",
        "claimed_at": "ALTER TABLE runs ADD COLUMN claimed_at TIMESTAMP WITH TIME ZONE",
        "attempt_count": "ALTER TABLE runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
        "queue_priority": "ALTER TABLE runs ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 100",
        "payload_json": "ALTER TABLE runs ADD COLUMN payload_json TEXT",
    }

    with engine.begin() as connection:
        for column_name, ddl in ddl_by_column.items():
            if column_name not in existing_columns:
                connection.execute(text(ddl))

        connection.execute(text("UPDATE runs SET status = 'queued' WHERE status = 'pending'"))
        connection.execute(text("UPDATE runs SET queue_priority = 100 WHERE queue_priority IS NULL"))
        connection.execute(text("UPDATE runs SET attempt_count = 0 WHERE attempt_count IS NULL"))


def init_db() -> None:
    global _db_initialized
    if _db_initialized:
        return
    with _db_init_lock:
        if _db_initialized:
            return
        import app.models  # noqa: F401

        Base.metadata.create_all(bind=engine)
        _ensure_run_queue_columns()
        _ensure_batch_run_group_columns()
        _ensure_run_metrics_columns()
        _db_initialized = True


def _ensure_run_metrics_columns() -> None:
    inspector = inspect(engine)
    if "run_metrics" not in inspector.get_table_names():
        return
    existing_columns = {column["name"] for column in inspector.get_columns("run_metrics")}
    ddl_by_column = {
        "total_states": "ALTER TABLE run_metrics ADD COLUMN total_states INTEGER",
        "total_state_actions": "ALTER TABLE run_metrics ADD COLUMN total_state_actions INTEGER",
        "decision_graph_edges": "ALTER TABLE run_metrics ADD COLUMN decision_graph_edges INTEGER",
    }
    with engine.begin() as connection:
        for column_name, ddl in ddl_by_column.items():
            if column_name not in existing_columns:
                connection.execute(text(ddl))


def _ensure_batch_run_group_columns() -> None:
    inspector = inspect(engine)
    if "batch_run_groups" not in inspector.get_table_names():
        return
    existing_columns = {column["name"] for column in inspector.get_columns("batch_run_groups")}
    if "result_label" not in existing_columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE batch_run_groups ADD COLUMN result_label VARCHAR(512)"))


def get_db_session() -> Session:
    return SessionLocal()


@contextmanager
def db_session_scope() -> Session:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker


def _default_sqlite_url() -> str:
    # backend/app/core -> backend/app -> backend -> QBR
    qbr_root = Path(__file__).resolve().parents[3]
    db_path = qbr_root / "storage" / "db" / "qbr.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path.as_posix()}"


DATABASE_URL = os.getenv("DATABASE_URL", _default_sqlite_url())

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, future=True, echo=False, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)
Base = declarative_base()


def _ensure_run_queue_columns() -> None:
    inspector = inspect(engine)
    if "runs" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("runs")}
    datetime_sql = "TIMESTAMP WITH TIME ZONE" if engine.dialect.name == "postgresql" else "DATETIME"
    ddl_by_column = {
        "worker_id": "ALTER TABLE runs ADD COLUMN worker_id VARCHAR(64)",
        "heartbeat_at": f"ALTER TABLE runs ADD COLUMN heartbeat_at {datetime_sql}",
        "claimed_at": f"ALTER TABLE runs ADD COLUMN claimed_at {datetime_sql}",
        "attempt_count": "ALTER TABLE runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
        "queue_priority": "ALTER TABLE runs ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 100",
        "payload_json": "ALTER TABLE runs ADD COLUMN payload_json TEXT",
    }

    with engine.begin() as connection:
        for column_name, ddl in ddl_by_column.items():
            if column_name not in existing_columns:
                connection.execute(text(ddl))

        # Backward-compatible normalization for older rows created before queue semantics were aligned.
        connection.execute(text("UPDATE runs SET status = 'queued' WHERE status = 'pending'"))
        connection.execute(text("UPDATE runs SET queue_priority = 100 WHERE queue_priority IS NULL"))
        connection.execute(text("UPDATE runs SET attempt_count = 0 WHERE attempt_count IS NULL"))


def init_db() -> None:
    import app.models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_run_queue_columns()


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

"""Inspect DB and cancel stuck running runs (CLI)."""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.db import engine, init_db
from app.core.env import ensure_qbr_env

ensure_qbr_env()


def print_section(title: str) -> None:
    print(f"\n=== {title} ===")


def _rows_as_dicts(result) -> list[dict]:
    return [dict(row._mapping) for row in result]


def inspect() -> list[dict]:
    init_db()
    with engine.connect() as conn:
        print_section("database")
        print(engine.url.render_as_string(hide_password=True))

        print_section("running / queued runs")
        active = _rows_as_dicts(
            conn.execute(
                text(
                    """
                    SELECT r.id, r.status, r.mode, r.algorithm_id, r.worker_id,
                           r.started_at, r.heartbeat_at, r.claimed_at,
                           t.name AS topo_name, t.node_count, r.batch_run_group_id
                    FROM runs r
                    LEFT JOIN topologies t ON t.id = r.topology_id
                    WHERE r.status IN ('running', 'queued', 'pending')
                    ORDER BY COALESCE(r.started_at, r.created_at) DESC
                    """
                )
            )
        )
        for row in active:
            print(row)

        print_section("tp >= 250 nodes active")
        tp_active = _rows_as_dicts(
            conn.execute(
                text(
                    """
                    SELECT r.id, r.status, t.name, t.node_count, r.started_at, r.batch_run_group_id
                    FROM runs r
                    JOIN topologies t ON t.id = r.topology_id
                    WHERE t.node_count >= 250
                      AND r.status IN ('running', 'queued', 'pending')
                    """
                )
            )
        )
        for row in tp_active:
            print(row)

        print_section("batch groups active")
        batches = _rows_as_dicts(
            conn.execute(
                text(
                    """
                    SELECT id, status, stop_requested, total_topologies, started_at
                    FROM batch_run_groups
                    WHERE status IN ('running', 'queued', 'stopped')
                    ORDER BY started_at DESC
                    LIMIT 10
                    """
                )
            )
        )
        for row in batches:
            print(row)

    return tp_active


def cancel_run_ids(run_ids: list[str], *, mark_failed: bool = False) -> None:
    if not run_ids:
        print("No run ids to cancel.")
        return
    now = datetime.now(timezone.utc)
    status = "failed" if mark_failed else "stopped"
    with engine.begin() as conn:
        for run_id in run_ids:
            conn.execute(
                text(
                    """
                    UPDATE runs
                    SET status = :status, ended_at = :ended_at, error_message = :message,
                        worker_id = NULL, heartbeat_at = NULL, claimed_at = NULL
                    WHERE id = :run_id
                    """
                ),
                {
                    "status": status,
                    "ended_at": now,
                    "message": "Cancelled by admin script.",
                    "run_id": run_id,
                },
            )
        conn.execute(
            text(
                f"""
                UPDATE topologies
                SET status = 'done'
                WHERE id IN (
                    SELECT topology_id FROM runs WHERE id IN ({",".join(f":rid{i}" for i in range(len(run_ids)))})
                )
                """
            ),
            {f"rid{i}": run_id for i, run_id in enumerate(run_ids)},
        )
    print(f"Cancelled {len(run_ids)} run(s) -> {status}")


def cancel_batch_groups(batch_ids: list[str]) -> None:
    if not batch_ids:
        return
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        for batch_id in batch_ids:
            conn.execute(
                text(
                    """
                    UPDATE batch_run_groups
                    SET status = 'stopped', stop_requested = 0, ended_at = :ended_at
                    WHERE id = :batch_id
                    """
                ),
                {"ended_at": now, "batch_id": batch_id},
            )
            conn.execute(
                text(
                    """
                    UPDATE runs
                    SET status = 'stopped', ended_at = :ended_at, error_message = 'Batch stopped by admin script.',
                        worker_id = NULL, heartbeat_at = NULL, claimed_at = NULL
                    WHERE batch_run_group_id = :batch_id AND status IN ('running', 'queued', 'pending')
                    """
                ),
                {"ended_at": now, "batch_id": batch_id},
            )
    print(f"Stopped batch group(s): {batch_ids}")


def show_tp300_recent() -> None:
    with engine.connect() as conn:
        print_section("recent tp_300 runs")
        rows = _rows_as_dicts(
            conn.execute(
                text(
                    """
                    SELECT r.id, r.status, r.error_message, t.name, t.status AS topo_status
                    FROM runs r
                    JOIN topologies t ON t.id = r.topology_id
                    WHERE t.name LIKE 'tp_300%'
                    ORDER BY r.started_at DESC
                    LIMIT 6
                    """
                )
            )
        )
        for row in rows:
            print(row)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cancel-tp300", action="store_true", help="Cancel active runs on topologies with >=250 nodes")
    parser.add_argument("--run-ids", nargs="*", default=[])
    parser.add_argument("--mark-failed", action="store_true")
    args = parser.parse_args()

    tp_active = inspect()

    if args.run_ids:
        cancel_run_ids(args.run_ids, mark_failed=args.mark_failed)
        return

    if args.cancel_tp300:
        run_ids = [str(r["id"]) for r in tp_active]
        batch_ids = list({str(r["batch_run_group_id"]) for r in tp_active if r["batch_run_group_id"]})
        cancel_run_ids(run_ids, mark_failed=args.mark_failed)
        cancel_batch_groups(batch_ids)


if __name__ == "__main__":
    main()
    show_tp300_recent()

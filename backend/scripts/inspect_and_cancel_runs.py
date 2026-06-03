"""Inspect DB and cancel stuck running runs (CLI)."""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "storage" / "db" / "qbr.db"


def connect_rw() -> sqlite3.Connection:
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def connect_ro() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def print_section(title: str) -> None:
    print(f"\n=== {title} ===")


def inspect() -> list[sqlite3.Row]:
    conn = connect_ro()
    cur = conn.cursor()
    print_section("integrity_check")
    print(cur.execute("PRAGMA integrity_check").fetchone()[0])
    print_section("journal_mode")
    print(cur.execute("PRAGMA journal_mode").fetchone()[0])
    print_section("busy / wal")
    for pragma in ("wal_checkpoint",):
        try:
            print(cur.execute(f"PRAGMA {pragma}").fetchall())
        except sqlite3.Error as exc:
            print(f"{pragma}: {exc}")

    print_section("running / queued runs")
    cur.execute(
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
    active = cur.fetchall()
    for row in active:
        print(dict(row))

    print_section("tp >= 250 nodes active")
    cur.execute(
        """
        SELECT r.id, r.status, t.name, t.node_count, r.started_at, r.batch_run_group_id
        FROM runs r
        JOIN topologies t ON t.id = r.topology_id
        WHERE t.node_count >= 250
          AND r.status IN ('running', 'queued', 'pending')
        """
    )
    tp_active = cur.fetchall()
    for row in tp_active:
        print(dict(row))

    print_section("batch groups active")
    cur.execute(
        """
        SELECT id, status, stop_requested, total_topologies, started_at
        FROM batch_run_groups
        WHERE status IN ('running', 'queued', 'stopped')
        ORDER BY started_at DESC
        LIMIT 10
        """
    )
    for row in cur.fetchall():
        print(dict(row))

    conn.close()
    return tp_active


def cancel_run_ids(run_ids: list[str], *, mark_failed: bool = False) -> None:
    if not run_ids:
        print("No run ids to cancel.")
        return
    conn = connect_rw()
    now = datetime.now(timezone.utc).isoformat()
    status = "failed" if mark_failed else "stopped"
    try:
        for run_id in run_ids:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, ended_at = ?, error_message = ?,
                    worker_id = NULL, heartbeat_at = NULL, claimed_at = NULL
                WHERE id = ?
                """,
                (status, now, "Cancelled by admin script.", run_id),
            )
        conn.execute(
            """
            UPDATE topologies
            SET status = 'done'
            WHERE id IN (
                SELECT topology_id FROM runs WHERE id IN ({})
            )
            """.format(",".join("?" * len(run_ids))),
            run_ids,
        )
        conn.commit()
        print(f"Cancelled {len(run_ids)} run(s) -> {status}")
    except sqlite3.Error as exc:
        conn.rollback()
        print(f"DB error: {exc}", file=sys.stderr)
        raise
    finally:
        conn.close()


def cancel_batch_groups(batch_ids: list[str]) -> None:
    if not batch_ids:
        return
    conn = connect_rw()
    now = datetime.now(timezone.utc).isoformat()
    try:
        for batch_id in batch_ids:
            conn.execute(
                """
                UPDATE batch_run_groups
                SET status = 'stopped', stop_requested = 0, ended_at = ?
                WHERE id = ?
                """,
                (now, batch_id),
            )
            conn.execute(
                """
                UPDATE runs
                SET status = 'stopped', ended_at = ?, error_message = 'Batch stopped by admin script.',
                    worker_id = NULL, heartbeat_at = NULL, claimed_at = NULL
                WHERE batch_run_group_id = ? AND status IN ('running', 'queued', 'pending')
                """,
                (now, batch_id),
            )
        conn.commit()
        print(f"Stopped batch group(s): {batch_ids}")
    except sqlite3.Error as exc:
        conn.rollback()
        print(f"DB error: {exc}", file=sys.stderr)
        raise
    finally:
        conn.close()


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


def show_tp300_recent() -> None:
    conn = connect_ro()
    cur = conn.cursor()
    print_section("recent tp_300 runs")
    cur.execute(
        """
        SELECT r.id, r.status, r.error_message, t.name, t.status AS topo_status
        FROM runs r
        JOIN topologies t ON t.id = r.topology_id
        WHERE t.name LIKE 'tp_300%'
        ORDER BY r.started_at DESC
        LIMIT 6
        """
    )
    for row in cur.fetchall():
        print(dict(row))
    conn.close()


if __name__ == "__main__":
    main()
    show_tp300_recent()

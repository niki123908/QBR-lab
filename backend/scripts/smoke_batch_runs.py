"""Smoke-check batch runs + backfill run_metrics from consolidated artifacts.

Usage:
  python scripts/smoke_batch_runs.py
  python scripts/smoke_batch_runs.py --batch-run-id <uuid> --batch-run-id <uuid>
  python scripts/smoke_batch_runs.py --match "baseline 2/6" --match "baseline nonET 2/6"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.core.db import db_session_scope, init_db
from app.models import Run, RunMetric
from app.repositories.run_repo import get_batch_run_result, list_batch_runs
from app.services.artifact_payload import resolve_artifact_payload
from app.services.run_artifacts import decision_graph_counts, q_table_learning_stats


def backfill_run_metrics(run_id: str, *, dry_run: bool = False) -> dict[str, int | None]:
    qtable = resolve_artifact_payload(run_id, "q_table")
    graph = resolve_artifact_payload(run_id, "run_decision_graph")
    total_states, total_state_actions = q_table_learning_stats(qtable if isinstance(qtable, dict) else {})
    _, decision_graph_edges = decision_graph_counts(graph if isinstance(graph, dict) else None)

    if not dry_run:
        init_db()
        with db_session_scope() as session:
            metric = session.get(RunMetric, run_id)
            if metric is None:
                return {
                    "total_states": total_states,
                    "total_state_actions": total_state_actions,
                    "decision_graph_edges": decision_graph_edges,
                }
            if metric.total_states is None and total_states:
                metric.total_states = total_states
            if metric.total_state_actions is None and total_state_actions:
                metric.total_state_actions = total_state_actions
            if metric.decision_graph_edges is None and decision_graph_edges:
                metric.decision_graph_edges = decision_graph_edges

    return {
        "total_states": total_states,
        "total_state_actions": total_state_actions,
        "decision_graph_edges": decision_graph_edges,
    }


def verify_batch(batch_run_id: str) -> None:
    row = get_batch_run_result(batch_run_id)
    if row is None:
        raise SystemExit(f"Batch not found: {batch_run_id}")
    done = [t for t in row.topologies if t.status == "done"]
    with_paths = sum(1 for t in done if t.paths_count_by_delay)
    print(f"  result_label={row.result_label!r}")
    print(f"  custom_result_label={row.custom_result_label!r}")
    print(f"  topologies={len(row.topologies)} done={len(done)} with_paths_count_by_delay={with_paths}")
    if done:
        sample = done[0]
        print(
            f"  sample {sample.topology_name}: delay_series={len(sample.delay_per_episode)} "
            f"paths_by_delay={sample.paths_count_by_delay} states={sample.total_states}"
        )


def resolve_batch_ids(matches: list[str]) -> list[str]:
    rows = list_batch_runs()
    if not matches:
        return [rows[0].batch_run_id, rows[1].batch_run_id] if len(rows) >= 2 else [r.batch_run_id for r in rows[:1]]
    found: list[str] = []
    for needle in matches:
        needle_l = needle.lower()
        hit = next(
            (
                r
                for r in rows
                if needle_l in (r.result_label or "").lower()
                or needle_l in (r.custom_result_label or "").lower()
            ),
            None,
        )
        if hit is None:
            raise SystemExit(f"No batch run matching {needle!r}")
        found.append(hit.batch_run_id)
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke batch runs and backfill metrics")
    parser.add_argument("--batch-run-id", action="append", dest="batch_run_ids", default=[])
    parser.add_argument(
        "--match",
        action="append",
        default=[],
        help='Substring match on result label (default: two newest batches)',
    )
    parser.add_argument("--dry-run", action="store_true", help="Do not write run_metrics")
    args = parser.parse_args()

    init_db()
    batch_ids = args.batch_run_ids or resolve_batch_ids(args.match)
    if not batch_ids:
        raise SystemExit("No batch runs to check.")

    print(f"Checking {len(batch_ids)} batch run(s)...")
    for batch_run_id in batch_ids:
        print(f"\n=== batch {batch_run_id} ===")
        verify_batch(batch_run_id)

        with db_session_scope() as session:
            run_ids = session.scalars(
                select(Run.id).where(Run.batch_run_group_id == batch_run_id, Run.status == "done")
            ).all()

        updated = 0
        for run_id in run_ids:
            stats = backfill_run_metrics(run_id, dry_run=args.dry_run)
            if any(stats.values()):
                updated += 1
        print(f"  backfill {'(dry-run) ' if args.dry_run else ''}touched {updated}/{len(run_ids)} done runs")

    print("\nAll batch smoke checks passed.")


if __name__ == "__main__":
    main()

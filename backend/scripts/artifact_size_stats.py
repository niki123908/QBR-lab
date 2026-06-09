"""One-off stats: artifact folder size by run type."""
from __future__ import annotations

import statistics
import sys
from pathlib import Path

from sqlalchemy import inspect as sa_inspect, text

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.db import engine, init_db
from app.core.env import ensure_qbr_env
from app.core.paths import storage_root

ensure_qbr_env()

ART = storage_root() / "artifacts"

FULL_ARTIFACT_NAMES = {
    "resolved_run_config.json",
    "run_summary.json",
    "q_table.json",
    "delay_per_episode.csv",
    "policy_trace.csv",
    "path_signatures.csv",
    "path_action_transitions.csv",
    "state_action_last_epoch.json",
    "state_action_best_epoch.json",
    "transmission_last_epoch.json",
    "transmission_best_epoch.json",
}


def folder_bytes(run_id: str) -> int:
    p = ART / run_id
    if not p.is_dir():
        return 0
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def file_names(run_id: str) -> set[str]:
    p = ART / run_id
    if not p.is_dir():
        return set()
    return {f.name for f in p.iterdir() if f.is_file()}


def summarize(label: str, sizes_mb: list[float]) -> None:
    if not sizes_mb:
        print(f"{label}: (no data)")
        return
    sizes_mb_sorted = sorted(sizes_mb)
    n = len(sizes_mb)
    avg = statistics.mean(sizes_mb)
    med = statistics.median(sizes_mb)
    p90 = sizes_mb_sorted[int(0.9 * (n - 1))] if n > 1 else sizes_mb_sorted[0]
    print(
        f"{label}: n={n}  avg={avg:.2f} MB ({avg/1024:.4f} GB)  "
        f"median={med:.2f} MB  p90={p90:.2f} MB  max={max(sizes_mb):.2f} MB"
    )


def main() -> None:
    init_db()
    inspector = sa_inspect(engine)
    print("runs columns:", [c["name"] for c in inspector.get_columns("runs")])

    with engine.connect() as conn:
        sample = conn.execute(text("SELECT id, status, mode FROM runs WHERE status = 'done' LIMIT 5")).fetchall()
        print("sample done runs:", [dict(row._mapping) for row in sample])
        by_mode = conn.execute(text("SELECT mode, COUNT(*) FROM runs GROUP BY mode")).fetchall()
        print("runs by mode:", by_mode)
        all_runs = [
            (str(row.id), row.status, str(row.mode or "single"))
            for row in conn.execute(text("SELECT id, status, mode FROM runs")).fetchall()
        ]

    single_mb: list[float] = []
    batch_mb: list[float] = []
    full_mb: list[float] = []
    partial_mb: list[float] = []
    empty_count = 0

    for run_id, _status, mode in all_runs:
        b = folder_bytes(run_id)
        mb = b / (1024 * 1024)
        names = file_names(run_id)
        if b == 0:
            empty_count += 1
            continue
        is_full = FULL_ARTIFACT_NAMES.issubset(names) or len(names) >= 10
        is_partial = len(names) > 0 and not is_full

        if mode == "batch":
            batch_mb.append(mb)
        else:
            single_mb.append(mb)

        if is_full:
            full_mb.append(mb)
        elif is_partial:
            partial_mb.append(mb)

    print(f"\nTotal run rows: {len(all_runs)}  empty folders: {empty_count}")
    print(f"Artifact dirs on disk: {len(list(ART.iterdir())) if ART.is_dir() else 0}\n")

    summarize("mode=single", single_mb)
    summarize("mode=batch", batch_mb)
    summarize("Full artifact set (~11 files)", full_mb)
    summarize("Partial artifact set", partial_mb)
    summarize("All non-empty folders", single_mb + batch_mb)


if __name__ == "__main__":
    main()

from __future__ import annotations

import os
import sys
import threading
import time
import traceback
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.db import init_db
from app.repositories.run_repo import claim_next_queued_run, heartbeat_run, requeue_stale_runs
from app.services.run_engine_service import execute_queued_batch_run, execute_queued_single_run


WORKER_ID = os.getenv("WORKER_ID", f"worker-{os.getpid()}")
POLL_INTERVAL_SEC = float(os.getenv("POLL_INTERVAL_SEC", "2"))
HEARTBEAT_INTERVAL_SEC = float(os.getenv("HEARTBEAT_INTERVAL_SEC", "5"))
STALE_AFTER_SEC = int(os.getenv("STALE_AFTER_SEC", "30"))
STALE_SWEEP_INTERVAL_SEC = float(os.getenv("STALE_SWEEP_INTERVAL_SEC", "10"))


def _run_heartbeat_loop(run_id: str, stop_event: threading.Event) -> None:
    while not stop_event.wait(HEARTBEAT_INTERVAL_SEC):
        heartbeat_run(run_id=run_id, worker_id=WORKER_ID)


def run_worker_loop(stop_event: threading.Event | None = None, *, worker_id: str | None = None) -> None:
    global WORKER_ID
    if worker_id:
        WORKER_ID = str(worker_id)
    init_db()
    print(f"[worker] QBR worker started. worker_id={WORKER_ID}")
    last_stale_sweep = 0.0
    try:
        while stop_event is None or not stop_event.is_set():
            now = time.monotonic()
            if now - last_stale_sweep >= STALE_SWEEP_INTERVAL_SEC:
                reclaimed = requeue_stale_runs(stale_after_seconds=STALE_AFTER_SEC)
                if reclaimed:
                    print(f"[worker] reclaimed stale runs: {', '.join(reclaimed)}")
                last_stale_sweep = now

            claimed = claim_next_queued_run(WORKER_ID, modes=("single", "batch"))
            if claimed is None:
                if stop_event is None:
                    time.sleep(POLL_INTERVAL_SEC)
                else:
                    stop_event.wait(POLL_INTERVAL_SEC)
                continue

            print(f"[worker] claimed {claimed.mode} run {claimed.run_id} for topology {claimed.topology_id}")
            heartbeat_stop = threading.Event()
            heartbeat_thread = threading.Thread(
                target=_run_heartbeat_loop,
                args=(claimed.run_id, heartbeat_stop),
                daemon=True,
            )
            heartbeat_thread.start()
            try:
                if claimed.mode == "single":
                    execute_queued_single_run(claimed.run_id)
                else:
                    execute_queued_batch_run(claimed.run_id)
                print(f"[worker] completed {claimed.mode} run {claimed.run_id}")
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                print(f"[worker] failed {claimed.mode} run {claimed.run_id}: {exc}")
                traceback.print_exc()
            finally:
                heartbeat_stop.set()
                heartbeat_thread.join(timeout=HEARTBEAT_INTERVAL_SEC)
    except KeyboardInterrupt:
        print("[worker] stopped.")


def main() -> None:
    run_worker_loop()


if __name__ == "__main__":
    main()

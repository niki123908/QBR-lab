from __future__ import annotations

import os
import subprocess
import sys
import uuid
from dataclasses import dataclass
from app.core.paths import qbr_root
from app.repositories.run_repo import requeue_runs_for_worker

ROOT = qbr_root()
WORKER_SCRIPT = ROOT / "worker" / "jobs" / "worker_main.py"
MAX_MANAGED_WORKERS = max(1, int(os.getenv("QBR_MAX_MANAGED_WORKERS", "4")))


@dataclass
class ManagedWorkerRecord:
    worker_id: str
    pid: int
    process: subprocess.Popen[str]


_managed_workers: dict[str, ManagedWorkerRecord] = {}


def _cleanup_dead_workers() -> None:
    dead_ids: list[str] = []
    for worker_id, record in _managed_workers.items():
        if record.process.poll() is not None:
            dead_ids.append(worker_id)
    for worker_id in dead_ids:
        _managed_workers.pop(worker_id, None)


def list_managed_workers() -> list[dict[str, object]]:
    _cleanup_dead_workers()
    rows: list[dict[str, object]] = []
    for worker_id, record in sorted(_managed_workers.items(), key=lambda item: item[0]):
        alive = record.process.poll() is None
        rows.append(
            {
                "worker_id": worker_id,
                "pid": int(record.pid),
                "alive": alive,
                "managed": True,
            }
        )
    return rows


def spawn_managed_worker() -> dict[str, object]:
    if not WORKER_SCRIPT.is_file():
        raise ValueError("Failed.")

    _cleanup_dead_workers()
    if len(_managed_workers) >= MAX_MANAGED_WORKERS:
        raise ValueError(
            f"Failed: max {MAX_MANAGED_WORKERS} managed workers (npm run dev already starts one worker process)."
        )
    worker_id = f"worker-{uuid.uuid4().hex[:8]}"
    env = os.environ.copy()
    env["WORKER_ID"] = worker_id

    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP

    process = subprocess.Popen(
        [sys.executable, str(WORKER_SCRIPT)],
        cwd=str(ROOT),
        env=env,
        creationflags=creationflags,
    )
    _managed_workers[worker_id] = ManagedWorkerRecord(worker_id=worker_id, pid=int(process.pid), process=process)
    return {
        "worker_id": worker_id,
        "pid": int(process.pid),
        "alive": True,
        "managed": True,
    }


def kill_managed_worker(worker_id: str) -> bool:
    _cleanup_dead_workers()
    record = _managed_workers.get(worker_id)
    if record is None:
        return False

    requeue_runs_for_worker(worker_id)

    if record.process.poll() is None:
        record.process.terminate()
        try:
            record.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            record.process.kill()
            record.process.wait(timeout=5)

    _managed_workers.pop(worker_id, None)
    return True

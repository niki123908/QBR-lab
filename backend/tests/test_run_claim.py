from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone

from app.core.db import db_session_scope, init_db
from app.models import Run, Topology
from app.repositories.run_repo import claim_next_queued_run


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def test_claim_next_is_exclusive_under_contention() -> None:
    init_db()
    topology_id = str(uuid.uuid4())
    with db_session_scope() as session:
        session.add(
            Topology(
                id=topology_id,
                name="claim-test",
                node_count=3,
                space_width=10,
                space_height=10,
                tx_range=20.0,
                sink_mode="corner",
                sink_x=0,
                sink_y=0,
                created_at=_utcnow(),
                updated_at=_utcnow(),
            )
        )
        for idx in range(8):
            session.add(
                Run(
                    topology_id=topology_id,
                    mode="single",
                    algorithm_id="greedy",
                    config_id="default_v1",
                    status="queued",
                    attempt_count=0,
                    queue_priority=0,
                    payload_json="{}",
                    created_at=_utcnow(),
                )
            )

    claimed_ids: list[str] = []
    lock = threading.Lock()

    def worker_fn(worker_id: str) -> None:
        for _ in range(12):
            rec = claim_next_queued_run(worker_id, modes=("single",))
            if rec is not None:
                with lock:
                    claimed_ids.append(rec.run_id)

    threads = [threading.Thread(target=worker_fn, args=(f"w-{idx}",)) for idx in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(claimed_ids) == 8
    assert len(set(claimed_ids)) == 8

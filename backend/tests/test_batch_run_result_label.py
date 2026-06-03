from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from app.core.db import db_session_scope, init_db
from app.models import BatchRunGroup, Run, Topology
from app.repositories.run_repo import create_batch_run_enqueued, list_batch_runs, update_batch_run_result_label


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def test_update_batch_run_result_label_persists() -> None:
    init_db()
    batch_run_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    topology_id = str(uuid.uuid4())
    with db_session_scope() as session:
        session.add(
            BatchRunGroup(
                id=batch_run_id,
                status="completed",
                stop_requested=False,
                total_topologies=1,
                payload_json=json.dumps({"preset_name": "preset_a"}),
                created_at=_utcnow(),
            )
        )
        session.add(
            Run(
                id=run_id,
                topology_id=topology_id,
                mode="batch",
                status="done",
                algorithm_id="qbr",
                config_id="default_v1",
                batch_run_group_id=batch_run_id,
                created_at=_utcnow(),
            )
        )

    assert update_batch_run_result_label(batch_run_id, "My custom label")
    rows = list_batch_runs()
    match = next(item for item in rows if item.batch_run_id == batch_run_id)
    assert match.custom_result_label == "My custom label"
    assert match.result_label == "My custom label"

    assert update_batch_run_result_label(batch_run_id, None)
    rows = list_batch_runs()
    match = next(item for item in rows if item.batch_run_id == batch_run_id)
    assert match.custom_result_label is None
    assert " -- preset_a" in match.result_label


def test_create_batch_run_enqueued_sets_initial_label() -> None:
    init_db()
    batch_run_id = str(uuid.uuid4())
    topology_id = str(uuid.uuid4())
    with db_session_scope() as session:
        session.add(
            Topology(
                id=topology_id,
                name="tp_test",
                node_count=3,
                space_width=10,
                space_height=10,
                tx_range=1.0,
                sink_mode="corner",
                sink_x=0,
                sink_y=0,
                created_at=_utcnow(),
                updated_at=_utcnow(),
            )
        )
    create_batch_run_enqueued(
        batch_run_id=batch_run_id,
        topology_ids=[topology_id],
        algorithm_id="qbr",
        preset_id="default_v1",
        payload={"preset_name": "preset_a"},
        result_label="Queued label",
    )
    rows = list_batch_runs()
    match = next(item for item in rows if item.batch_run_id == batch_run_id)
    assert match.custom_result_label == "Queued label"

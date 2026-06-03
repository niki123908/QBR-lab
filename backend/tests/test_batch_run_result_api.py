from __future__ import annotations

from app.repositories.run_repo import BatchRunResultRecord


def test_batch_run_result_record_accepts_custom_label() -> None:
    row = BatchRunResultRecord(
        batch_run_id="b1",
        batch_name="batch",
        algorithm_id="qbr",
        preset_id="default_v1",
        preset_name="preset",
        run_config={},
        draft_preset_id=None,
        result_label="batch -- preset",
        custom_result_label="My label",
        total_topologies=1,
        successful=1,
        failed=0,
        density_groups=[],
        topologies=[],
    )
    assert row.custom_result_label == "My label"

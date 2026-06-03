"""Check run artifact files vs legacy API aliases used by the UI."""

from __future__ import annotations

import sys
from pathlib import Path

# backend/scripts -> backend
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.core.db import db_session_scope, init_db
from app.models import Artifact, Run
from app.services.artifact_payload import resolve_artifact_payload

LEGACY_UI_TYPES = [
    "run_bundle",
    "trace_epochs",
    "run_summary",
    "transmission_last_epoch",
    "transmission_best_epoch",
    "state_action_last_epoch",
    "state_action_best_epoch",
    "delay_per_episode",
    "path_signatures",
    "policy_trace",
    "q_table",
    "resolved_run_config",
    "run_decision_graph",
]


def main() -> None:
    init_db()
    with db_session_scope() as session:
        runs = session.scalars(select(Run).where(Run.status == "done").order_by(Run.created_at.desc()).limit(40)).all()

    print(f"Checking {len(runs)} recent done runs...\n")
    new_fmt = 0
    legacy_only = 0
    broken = 0

    for run in runs:
        rid = run.id
        root = Path(__file__).resolve().parents[2] / "storage" / "artifacts" / rid
        has_bundle_gz = (root / "run_bundle.json.gz").is_file()
        has_bundle_json = (root / "run_bundle.json").is_file()
        has_legacy_summary = (root / "run_summary.json").is_file()

        bundle = resolve_artifact_payload(rid, "run_bundle")
        delay = resolve_artifact_payload(rid, "delay_per_episode")
        state_last = resolve_artifact_payload(rid, "state_action_last_epoch")
        graph = resolve_artifact_payload(rid, "run_decision_graph")

        ok_delay = delay is not None and ("text" in delay if isinstance(delay, dict) else True)
        ok_state = state_last is not None
        ok_bundle = bundle is not None

        if has_bundle_gz or (ok_bundle and isinstance(bundle, dict) and bundle.get("schema_version")):
            new_fmt += 1
            tag = "NEW"
        elif has_legacy_summary or ok_bundle:
            legacy_only += 1
            tag = "LEGACY"
        else:
            broken += 1
            tag = "BROKEN"

        flags = []
        if not ok_delay:
            flags.append("no_delay")
        if not ok_state:
            flags.append("no_state_last")
        if graph is None:
            flags.append("no_graph")

        flag_txt = f" [{', '.join(flags)}]" if flags else ""
        print(f"{tag} {rid[:8]} mode={run.mode}{flag_txt}")

    print(f"\nSummary: new={new_fmt} legacy={legacy_only} broken={broken}")


if __name__ == "__main__":
    main()

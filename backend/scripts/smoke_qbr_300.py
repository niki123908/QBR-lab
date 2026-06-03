"""Smoke test QBR on a 300-node topology with user-like configs."""
from __future__ import annotations

import json
import time
import traceback
import uuid

from sqlalchemy import select

from app.core.db import db_session_scope, init_db
from app.models import Run, Topology, TopologyNode
from app.services.run_engine_service import _build_node_list
from app.services.run_registry import resolve_and_validate_run_config
from app.services.runners.base import RunnerContext, TOPOLOGY_RUN_TIMEOUT_SEC
from app.services.runners.qbr_runner import execute_qbr

TOPO_ID = "d0bea697-bbd7-4162-a352-4ccda8be60e6"  # tp_300_00
FAILED_RUN_ID = "6a5617e0-3e5f-4e39-8390-eb57c5cdbb67"


def run_once(topo, node_list, preset_id: str, run_config: dict) -> None:
    mode = run_config.get("action_aggregation_mode", "off")
    episodes = run_config.get("episodes", 1000)
    label = f"mode={mode} episodes={episodes} policy={run_config.get('policy_type')}"
    print(f"\n--- {label} ---")
    print(f"timeout={TOPOLOGY_RUN_TIMEOUT_SEC}s nodes={topo.node_count}")

    cfg = resolve_and_validate_run_config(
        "qbr",
        preset_id,
        run_config,
        topology_context={"node_count": topo.node_count},
    )
    ctx = RunnerContext(
        run_id=str(uuid.uuid4()),
        topology=topo,
        nodes=node_list,
        config=cfg,
    )
    started = time.monotonic()
    try:
        result = execute_qbr(ctx)
        elapsed = time.monotonic() - started
        print(
            f"OK finished_delay={result.finished_delay} "
            f"best={result.best_delay_explored} reward={result.reward_final:.1f} "
            f"elapsed={elapsed:.1f}s"
        )
    except Exception as exc:
        elapsed = time.monotonic() - started
        print(f"FAIL {type(exc).__name__}: {exc} elapsed={elapsed:.1f}s")
        traceback.print_exc(limit=12)


def main() -> None:
    init_db()
    with db_session_scope() as session:
        failed = session.get(Run, FAILED_RUN_ID)
        payload = json.loads(failed.payload_json or "{}")
        base_config = dict(payload.get("run_config") or {})
        preset_id = str(payload.get("preset_id") or "default_v1")

        topo = session.get(Topology, TOPO_ID)
        if topo is None:
            raise SystemExit(f"Topology {TOPO_ID} not found")
        node_rows = session.scalars(
            select(TopologyNode).where(TopologyNode.topology_id == TOPO_ID)
        ).all()
        node_list = _build_node_list(topo, list(node_rows))

    print(f"Topology: {topo.name} ({topo.node_count} nodes)")
    print(f"Base config from failed run: aggregation={base_config.get('action_aggregation_mode')}")

    # Quick sanity: 50 episodes each mode
    for mode in ("off", "incremental_merge", "exact_next_state"):
        cfg = {**base_config, "action_aggregation_mode": mode, "episodes": 50}
        run_once(topo, node_list, preset_id, cfg)

    # Full user config on best candidate mode first
    full_off = {**base_config, "action_aggregation_mode": "off", "episodes": 1000}
    run_once(topo, node_list, preset_id, full_off)

    full_inc = {**base_config, "action_aggregation_mode": "incremental_merge", "episodes": 1000}
    run_once(topo, node_list, preset_id, full_inc)


if __name__ == "__main__":
    main()

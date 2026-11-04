"""Durable, isolated Energy queue; consumed by the existing worker processes."""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
from uuid import uuid4
from sqlalchemy import select, update, case
from sqlalchemy.orm import defer
from app.core.db import db_session_scope
from app.core.errors import AppError
from app.models import EnergyRun, EnergyPreset
from app.services.energy_run_queries import read_runs, compact_result
from app.services import energy_topology_service as topologies
from app.services.runners.energy_qbr_runner import EnergyRunConfig, resolve_topology, train_energy_qbr


def now():
    return datetime.now(timezone.utc)


from app.services.runners.energy_greedy_runner import EnergyGreedyConfig, run_energy_greedy


def configuration(raw, algorithm_id="qbr"):
    try:
        return (EnergyGreedyConfig if algorithm_id == "greedy" else EnergyRunConfig)(**{k: None if v == "" else v for k, v in raw.items()})
    except ValueError as exc:
        raise AppError(str(exc), 400) from exc


def algorithm_metadata(algorithm_id, config_class):
    schema = config_class.model_json_schema()
    for key in ("capacity", "rx_cost", "tx_cost", "run_seed"):
        prop = schema["properties"][key]
        numeric = next(v for v in prop.pop("anyOf") if v.get("type") != "null")
        prop.update(numeric)
        prop["type"] = [prop["type"], "null"]
    schema["properties"].pop("run_seed")  # Existing dedicated seed control.
    return dict(algorithm_id=algorithm_id, display_name="Greedy heuristic" if algorithm_id == "greedy" else "QBR Energy", version="energy-v1",
        default_config=config_class().model_dump(), config_schema=schema,
        capabilities=dict(has_q_table=algorithm_id == "qbr", has_policy_trace=False, has_state_action_trace=True,
            has_transmission_trace=True, has_episode_series=True, has_epoch_compare=algorithm_id == "qbr",
            has_path_signatures=False))


def algorithms():
    return [algorithm_metadata("qbr", EnergyRunConfig), algorithm_metadata("greedy", EnergyGreedyConfig)]


def presets():
    with db_session_scope() as s:
        return [dict(id=r.id, **r.payload) for r in s.scalars(select(EnergyPreset))]


def save_preset(payload, preset_id=None):
    if preset_id:
        with db_session_scope() as s:
            existing = s.get(EnergyPreset, preset_id)
            if existing is None: raise AppError("Preset not found.", 404)
            from types import SimpleNamespace
            payload = SimpleNamespace(**{**existing.payload, **payload.model_dump(exclude_none=True)})
    if payload.algorithm_id not in {"qbr", "greedy"} or payload.backbone != payload.algorithm_id:
        raise AppError("Only QBR and Greedy are available in Energy mode.")
    data = dict(label=payload.label, backbone=payload.backbone, algorithm_id=payload.algorithm_id, run_config=configuration(payload.run_config, payload.algorithm_id).model_dump())
    with db_session_scope() as s:
        row = s.get(EnergyPreset, preset_id) if preset_id else EnergyPreset(id=str(uuid4()), payload=data)
        if row is None: raise AppError("Preset not found.", 404)
        row.payload = data
        s.add(row)
        return dict(id=row.id, **data)


def enqueue(payload, batch=False):
    if payload.algorithm_id not in {"qbr", "greedy"}: raise AppError("Only QBR and Greedy are available in Energy mode.")
    config = configuration(payload.run_config, payload.algorithm_id)
    ids = payload.topology_ids if batch else [payload.topology_id]
    if not ids: raise AppError("Select at least one topology.")
    graphs = [topologies.get_data(tid, "graph") for tid in ids]
    for graph in graphs:
        try: resolve_topology(graph, config)
        except ValueError as exc: raise AppError(str(exc)) from exc
    group_id = str(uuid4()) if batch else None
    run_ids = []
    with db_session_scope() as s:
        for index, graph in enumerate(graphs):
            run_id = str(uuid4()); run_ids.append(run_id)
            s.add(EnergyRun(id=run_id, topology_id=ids[index], group_id=group_id, status="queued_greedy" if payload.algorithm_id == "greedy" else "queued",
                payload=dict(graph=graph, algorithm_id=payload.algorithm_id, config=config.model_dump(), preset_id=payload.preset_id,
                    preset_name=payload.preset_name, index=index, progress=0,
                    result_label=getattr(payload, "result_label", None) or payload.preset_name)))
    return dict(batch_run_id=group_id, accepted=True, total_topologies=len(ids)) if batch else dict(run_id=run_ids[0], completed=False, message="Accepted.")


def claim_energy_run(worker_id):
    with db_session_scope() as s:
        # Restart abandoned claims; ownership prevents late workers from overwriting a retry.
        s.execute(update(EnergyRun).where(EnergyRun.status == "running", EnergyRun.heartbeat_at < now()-timedelta(seconds=180)).values(status=case((EnergyRun.payload["algorithm_id"].as_string() == "greedy", "queued_greedy"), else_="queued"), worker_id=None))
        row = s.scalar(select(EnergyRun).where(EnergyRun.status.in_(["queued", "queued_greedy"])).order_by(case((EnergyRun.status == "queued_greedy", 0), else_=1), EnergyRun.created_at).with_for_update(skip_locked=True).limit(1))
        if row is None: return None
        row.status = "running"; row.worker_id = worker_id; row.heartbeat_at = now()
        row.payload = {**row.payload, "started_at": now().isoformat(), "progress": 0}
        return row.id


def execute_energy_run(run_id, worker_id):
    with db_session_scope() as s:
        row = s.get(EnergyRun, run_id)
        if row is None or row.worker_id != worker_id or row.status != "running": return
        payload = deepcopy(row.payload)
    def progress(episode):
        with db_session_scope() as s:
            row = s.scalar(select(EnergyRun).where(EnergyRun.id == run_id).with_for_update())
            if row is None or row.worker_id != worker_id or row.status != "running":
                raise InterruptedError("Energy run stopped or claim lost.")
            row.heartbeat_at = now()
            row.payload = {**row.payload, "progress": episode}
    try:
        runner = run_energy_greedy if payload.get("algorithm_id") == "greedy" else train_energy_qbr
        result = runner(payload["graph"], payload["config"], progress)
        status, error = "done", None
    except InterruptedError:
        return
    except Exception as exc:
        result, status, error = None, "failed", str(exc)
    with db_session_scope() as s:
        row = s.scalar(select(EnergyRun).where(EnergyRun.id == run_id).with_for_update())
        if row is None or row.worker_id != worker_id or row.status != "running": return
        row.result = result; row.status = status
        row.payload = {**row.payload, "ended_at": now().isoformat(), "error_message": error, "result_summary": compact_result(result) if result else None}


def row_data(row):
    p, r = row.payload, row.result or {}
    best, last = r.get("best") or {}, r.get("last") or {}
    return dict(run_id=row.id, topology_id=row.topology_id, topology_name=p["graph"]["topology_name"],
        mode="batch" if row.group_id else "single", status="queued" if row.status == "queued_greedy" else row.status, warning_topology_changed=False,
        algorithm_id=p.get("algorithm_id", "qbr"), preset_id=p["preset_id"], preset_name=p["preset_name"], created_at=row.created_at.isoformat(),
        started_at=p.get("started_at"), ended_at=p.get("ended_at"), error_message=p.get("error_message"),
        runtime_sec=r.get("runtime_sec"), finished_delay=last.get("delay"), best_delay_explored=best.get("delay"),
        lower_bound=p["graph"].get("lower_bound"), reward_final=last.get("total_reward"),
        total_states=r.get("total_states"), total_state_actions=r.get("total_state_actions"),
        decision_graph_edges=None, rollout_runtime_ms=None, batch_run_id=row.group_id,
        batch_result_label=p["result_label"], completed=last.get("completed"), truncated=last.get("truncated"),
        completed_episodes=r.get("completed_episodes", sum(e["completed"] for e in r.get("episodes", []))),
        progress=p.get("progress", 0), run_config=p["config"], resolved_energy=r.get("resolved_energy"),
        artifacts=[dict(artifact_type=k, uri=k, created_at=row.created_at.isoformat()) for k in (("run_bundle", "trace_epochs") if p.get("algorithm_id") == "greedy" else ("run_bundle", "trace_epochs", "q_table")) ] if r.get("runtime_sec") is not None else [])


def get_run(run_id):
    with db_session_scope() as s:
        rows = read_runs(s, select(EnergyRun).where(EnergyRun.id == run_id))
        if not rows: raise AppError("Energy run not found.", 404)
        return row_data(rows[0])


def history(topology_id):
    with db_session_scope() as s:
        return [row_data(r) for r in read_runs(s, select(EnergyRun).where(EnergyRun.topology_id == topology_id).order_by(EnergyRun.created_at.desc()))]


def single_ids():
    with db_session_scope() as s:
        return list(s.scalars(select(EnergyRun.topology_id).where(EnergyRun.group_id.is_(None)).distinct()))


def transmission(episode):
    e = episode or {}
    return dict(episode=e.get("episode", 0), total_delay=e.get("delay"), completed=e.get("completed", False),
        truncated=e.get("truncated", False), timeslots=e.get("steps", []))


def artifact(run_id, kind):
    with db_session_scope() as s:
        fields_by_kind = {
            "q_table": ["qtable"], "trace_epochs": ["last", "best"],
            "resolved_run_config": ["config", "resolved_energy"],
            "checkpoint": ["qtable", "config"], "delay_per_episode": ["episodes"],
            "run_bundle": ["config", "resolved_energy", "episodes", "last", "best", "runtime_sec", "total_states", "total_state_actions"],
        }
        if kind not in fields_by_kind: raise AppError("Artifact not found.", 404)
        rows = read_runs(s, select(EnergyRun).where(EnergyRun.id == run_id, EnergyRun.result.is_not(None)), fields=fields_by_kind[kind])
        if not rows: raise AppError("Artifact not found.", 404)
        row = rows[0]
        result = row.result
        if kind == "run_bundle":
            data = dict(schema_version=1, algorithm_id=row.payload.get("algorithm_id", "qbr"), run_id=run_id,
                metrics=row_data(row), policy={"policy_type":"greedy" if row.payload.get("algorithm_id") == "greedy" else "epsilon_greedy", **result["config"]}, episodes=[{**e, "delay":e["delay"] if e["completed"] else "NA"} for e in result["episodes"]],
                transmission={k: transmission(result[k]) for k in ("last", "best")})
        elif kind == "trace_epochs": data = {k: result[k] for k in ("last", "best")}
        elif kind == "q_table":
            if not result.get("qtable"): raise AppError("No Q-table for this run.", 404)
            data = result["qtable"]
        elif kind == "resolved_run_config": data = {**result["config"], **{k:result["resolved_energy"][k] for k in ("capacity", "tx_cost", "rx_cost")}, "algorithm_id":row.payload.get("algorithm_id", "qbr"), "policy_type":"greedy" if row.payload.get("algorithm_id") == "greedy" else "epsilon_greedy", "max_slots":100, "run_id":run_id, "preset_name":row.payload["preset_name"], "resolved_completion_bonus":len(row.payload["graph"]["nodes"]) if result["config"].get("completion_bonus_mode")=="node_count" else result["config"].get("completion_bonus")}
        elif kind == "checkpoint": data = dict(qtable=result["qtable"], state_encoding="frontier-ternary-v1", wait_action=-1, config=result["config"], topology=row.payload["graph"])
        elif kind == "delay_per_episode": data = {"text":"episode,delay,total_reward,completed\n" + "".join(f"{e['episode']},{e['delay'] if e['completed'] else 'NA'},{e['total_reward']},{e['completed']}\n" for e in result["episodes"])}
        else: raise AppError("Artifact not available for Energy QBR.", 404)
        return dict(run_id=run_id, artifact_type=kind, payload=data)


def group_rows(s, group_id, *, detailed=False, mutable=False):
    statement = select(EnergyRun).where(EnergyRun.group_id == group_id).order_by(EnergyRun.created_at)
    rows = list(s.scalars(statement.options(defer(EnergyRun.result)))) if mutable else read_runs(s, statement, episodes=detailed)
    if not rows: raise AppError("Energy batch run not found.", 404)
    return rows


def group_status(rows):
    states = {"queued" if r.status == "queued_greedy" else r.status for r in rows}
    return "running" if "running" in states else "queued" if "queued" in states else "stopped" if "stopped" in states else "completed"


def batch_summary(rows):
    p = rows[0].payload
    return dict(batch_run_id=rows[0].group_id, batch_name="Energy", algorithm_id=p.get("algorithm_id", "qbr"), preset_id=p["preset_id"],
        preset_name=p["preset_name"], result_label=p["result_label"], custom_result_label=p["result_label"],
        total_topologies=len(rows), successful=sum(r.status=="done" and bool((r.result or {}).get("has_best", (r.result or {}).get("best"))) for r in rows),
        failed=sum(r.status=="failed" or (r.status=="done" and not (r.result or {}).get("has_best", (r.result or {}).get("best"))) for r in rows),
        created_at=rows[0].created_at.isoformat(), batch_status=group_status(rows),
        unique_topology_count=len({r.topology_id for r in rows}), run_config=p["config"])


def batches():
    with db_session_scope() as s:
        rows = read_runs(s, select(EnergyRun).where(EnergyRun.group_id.is_not(None)).order_by(EnergyRun.created_at.desc()))
        groups = {}
        for r in rows: groups.setdefault(r.group_id, []).append(r)
        return [batch_summary(v) for v in groups.values()]


def batch_progress(group_id):
    with db_session_scope() as s:
        rows = group_rows(s, group_id)
        return dict(batch_run_id=group_id, batch_status=group_status(rows), stop_requested=any(r.status=="stopped" for r in rows),
            total_topologies=len(rows), pending=sum(r.status in {"queued", "queued_greedy"} for r in rows),
            **{k:sum(r.status==k for r in rows) for k in ("running", "done", "failed", "stopped")},
            rows=[dict(run_id=r.id, topology_id=r.topology_id, topology_name=r.payload["graph"]["topology_name"],
                topology_index=r.payload["index"], status="queued" if r.status == "queued_greedy" else r.status, runtime_sec=(r.result or {}).get("runtime_sec")) for r in rows])


def batch_result(group_id):
    with db_session_scope() as s:
        rows = group_rows(s, group_id)
        points=[]
        for row in rows:
            d=row_data(row); result=row.result or {}
            delays = result.get("delay_series")
            if delays is None:
                stored = read_runs(s, select(EnergyRun).where(EnergyRun.id == row.id), fields=["episodes"])[0].result
                delays = [e["delay"] if e["completed"] else None for e in (stored.get("episodes") or [])]
            points.append(dict(topology_id=row.topology_id, topology_name=d["topology_name"], topology_index=row.payload["index"],
                node_count=len(row.payload["graph"]["nodes"]), status=("failed" if row.status=="done" and not result.get("has_best", result.get("best")) else row.status),
                last_delay=d["finished_delay"], best_delay=d["best_delay_explored"], lower_bound=d["lower_bound"],
                total_states=d["total_states"], total_state_actions=d["total_state_actions"], runtime_sec=d["runtime_sec"],
                delay_per_episode=[delay if delay is not None else "NA" for delay in delays], paths_count_by_delay={}))
        groups={}
        for p in points: groups.setdefault(p["node_count"], []).append(p)
        return {**batch_summary(rows), "topologies":points, "density_groups":[dict(node_count=n, topologies=p) for n,p in sorted(groups.items())]}


def batch_operation(group_id, operation, label=None):
    with db_session_scope() as s:
        rows=group_rows(s, group_id, mutable=True)
        for row in rows:
            if operation=="delete": s.delete(row)
            elif operation=="label": row.payload={**row.payload, "result_label":label or row.payload["preset_name"]}
            elif operation=="stop" and row.status in {"queued", "queued_greedy", "running"}: row.status="stopped"
            elif (operation=="resume" and row.status=="stopped") or (operation=="retry-failed" and row.status in {"failed", "stopped"}):
                row.status="queued_greedy" if row.payload.get("algorithm_id") == "greedy" else "queued"; row.worker_id=None
        return dict(message="Success.")


def queue():
    with db_session_scope() as s:
        rows=read_runs(s, select(EnergyRun).where(EnergyRun.status.in_(["queued", "queued_greedy", "running"])).order_by(EnergyRun.created_at))
        items=[{**row_data(r), "worker_id":r.worker_id, "queue_priority":100} for r in rows]
        running=[r for r in items if r["status"]=="running"]
        queued=[r for r in items if r["status"]=="queued"]
        lanes=[dict(lane_id=r["worker_id"], worker_id=r["worker_id"], running=r, queued=[]) for r in running]
        if queued: lanes.append(dict(lane_id="energy-queue", worker_id=None, running=None, queued=queued))
        return dict(total_running=len(running), total_queued=len(queued), lane_count=len(lanes), lanes=lanes)

"""Isolated Energy workspace shell; simulation endpoints arrive in the next phase.

Never delegate to broadcast repositories, even for a supplied broadcast resource ID.
"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.energy_schemas import EnergyGenerate, EnergyMultiGenerate
from app.schemas import CreateBatchRequest, UpdateBatchRequest, NodeCoordinatePatch
from app.services import energy_topology_service as service

router = APIRouter()

EMPTY_COLLECTIONS = {
    "presets", "algorithms", "workers",
    "runs/history", "runs/history/single/topology-ids", "runs/batch/results",
}


@router.get("/topologies")
def topologies(status: str | None = None, nodes: int | None = None, lower_bound: int | None = None):
    return service.list_data(status=status, nodes=nodes, lower_bound=lower_bound)


@router.get("/batches")
def batches(status: str | None = None, nodes: int | None = None, lower_bound: int | None = None):
    return service.list_data(batches=True, status=status, nodes=nodes, lower_bound=lower_bound)


@router.post("/batches")
def create_batch(payload: CreateBatchRequest):
    return service.manage_batch("create", name=payload.name)


@router.patch("/batches/{batch_id}")
def rename_batch(batch_id: str, payload: UpdateBatchRequest):
    return service.manage_batch("rename", batch_id, payload.name)


@router.post("/batches/{batch_id}/lock")
def lock_batch(batch_id: str):
    return service.manage_batch("lock", batch_id)


@router.post("/batches/{batch_id}/unlock")
def unlock_batch(batch_id: str):
    return service.manage_batch("unlock", batch_id)


@router.delete("/batches/{batch_id}")
def delete_batch(batch_id: str):
    return service.manage_batch("delete", batch_id)


@router.post("/topologies/generate")
def generate(payload: EnergyGenerate):
    return service.generate(payload)


@router.post("/topologies/generate/multi")
def generate_multi(payload: EnergyMultiGenerate):
    return service.generate(payload, multi=True)


@router.get("/topologies/{topology_id}/nodes")
def nodes(topology_id: str):
    return service.get_data(topology_id, "nodes")


@router.get("/topologies/{topology_id}/detail")
def detail(topology_id: str):
    return service.get_data(topology_id, "detail")


@router.get("/topologies/{topology_id}/graph")
def graph(topology_id: str):
    return service.get_data(topology_id, "graph")


@router.patch("/topologies/{topology_id}/nodes")
def patch_node(topology_id: str, payload: NodeCoordinatePatch):
    return service.edit_node(topology_id, payload)


@router.post("/topologies/{topology_id}/save")
def save(topology_id: str):
    return service.save_topology(topology_id)


@router.delete("/topologies/{topology_id}")
def delete_topology(topology_id: str):
    return service.remove_topology(topology_id)


from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

class PlaygroundEnergyCosts(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    capacity: float = Field(gt=0)
    rx_cost: float = Field(gt=0)
    tx_cost: float = Field(gt=0)

class EnergyPlaygroundAction(BaseModel):
    first_pick: int | None = None
    spread_mode: Literal["normal", "energy"] = "normal"

class EnergyPlaygroundRequest(EnergyPlaygroundAction):
    energy: PlaygroundEnergyCosts | None = None
    actions: list[int | None | EnergyPlaygroundAction] = Field(default_factory=list, max_length=99)
    first_pick: int | None = None

@router.post("/topologies/{topology_id}/playground-step")
def energy_playground_step(topology_id: str, payload: EnergyPlaygroundRequest):
    from app.services.energy_environment import playground_energy
    from app.services.energy_topology_service import AppError
    try:
        return playground_energy(
            service.get_data(topology_id, "graph"),
            [action.model_dump() if isinstance(action, EnergyPlaygroundAction) else action for action in payload.actions],
            payload.first_pick, payload.energy.model_dump() if payload.energy else None,
            payload.spread_mode,
        )
    except ValueError as exc:
        raise AppError(str(exc)) from exc


class EnergyGifRequest(BaseModel):
    frames: list[str] = Field(min_length=2, max_length=1501)
    durations: list[int] | None = Field(default=None, max_length=1501)

@router.post("/playground/export-gif")
def export_energy_gif(payload: EnergyGifRequest):
    from fastapi.responses import Response
    from app.services.energy_gif import encode_energy_gif
    from app.services.energy_topology_service import AppError
    if sum(map(len, payload.frames)) > 120_000_000:
        raise AppError("GIF frames exceed the 120 MB limit.")
    try:
        data = encode_energy_gif(payload.frames, payload.durations)
    except (ValueError, OSError) as exc:
        raise AppError("Invalid GIF frames: " + str(exc)) from exc
    return Response(data, media_type="image/gif", headers={"Content-Disposition": 'attachment; filename="energy-playground.gif"'})


from app.services import energy_run_service as runs
from app.schemas import RunSingleRequest, BatchRunRequest, RunPresetCreate, RunPresetUpdate, BatchRunResultLabelUpdate
from app.core.db import db_session_scope
from app.models import EnergyRun, EnergyPreset
from app.core.errors import AppError

from app.services.worker_manager_service import list_managed_workers, spawn_managed_worker, kill_managed_worker

@router.get("/workers")
def energy_workers(): return list_managed_workers()

@router.post("/workers")
def energy_worker_create(): return spawn_managed_worker()

@router.delete("/workers/{worker_id}")
def energy_worker_delete(worker_id: str):
    if not kill_managed_worker(worker_id): raise AppError("Worker not found.", 404)
    return {"message":"Success."}

@router.get("/algorithms")
def energy_algorithms(): return runs.algorithms()

@router.get("/presets")
def energy_presets(): return runs.presets()

@router.post("/presets")
def energy_create_preset(payload: RunPresetCreate): return runs.save_preset(payload)

@router.patch("/presets/{preset_id}")
def energy_update_preset(preset_id: str, payload: RunPresetUpdate): return runs.save_preset(payload, preset_id)

@router.delete("/presets/{preset_id}")
def energy_delete_preset(preset_id: str):
    with db_session_scope() as s:
        row=s.get(EnergyPreset, preset_id)
        if row is None: raise AppError("Preset not found.", 404)
        s.delete(row)
    return {"message":"Success."}

@router.post("/runs/single")
def energy_run_single(payload: RunSingleRequest): return runs.enqueue(payload)

@router.post("/runs/batch")
def energy_run_batch(payload: BatchRunRequest): return runs.enqueue(payload, batch=True)

@router.get("/runs/history")
def energy_run_history(topology_id: str): return runs.history(topology_id)

@router.get("/runs/history/single/topology-ids")
def energy_single_ids(): return runs.single_ids()

@router.get("/runs/queue")
def energy_queue(): return runs.queue()

@router.get("/runs/batch/results")
def energy_batch_results(): return runs.batches()

@router.get("/runs/batch/{group_id}/progress")
def energy_batch_progress(group_id: str): return runs.batch_progress(group_id)

@router.get("/runs/batch/{group_id}/result")
def energy_batch_result(group_id: str): return runs.batch_result(group_id)

@router.post("/runs/batch/{group_id}/{operation}")
def energy_batch_operation(group_id: str, operation: str):
    if operation not in {"stop", "resume", "retry-failed"}: raise AppError("Unsupported operation.", 404)
    return runs.batch_operation(group_id, operation)

@router.patch("/runs/batch/{group_id}/result-label")
def energy_batch_label(group_id: str, payload: BatchRunResultLabelUpdate):
    runs.batch_operation(group_id, "label", payload.result_label)
    return runs.batch_result(group_id)

@router.delete("/runs/batch/{group_id}")
def energy_batch_delete(group_id: str): return runs.batch_operation(group_id, "delete")

@router.get("/runs/{run_id}")
def energy_run_detail(run_id: str): return runs.get_run(run_id)

@router.get("/runs/{run_id}/artifacts/{kind}")
def energy_run_artifact(run_id: str, kind: str): return runs.artifact(run_id, kind)

@router.delete("/runs/{run_id}")
def energy_run_delete(run_id: str):
    with db_session_scope() as s:
        row=s.get(EnergyRun, run_id)
        if row is None: raise AppError("Energy run not found.", 404)
        s.delete(row)
    return {"message":"Success."}


@router.api_route("/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
def energy_workspace(path: str, request: Request):
    if request.method == "GET":
        if path in EMPTY_COLLECTIONS:
            return []
        if path == "runs/queue":
            return {"total_queued": 0, "total_running": 0, "lane_count": 0, "lanes": []}
        return JSONResponse(status_code=404, content={"message": "Not found in Energy mode."})
    return JSONResponse(status_code=409, content={"message": "Energy workspace setup is not available yet."})

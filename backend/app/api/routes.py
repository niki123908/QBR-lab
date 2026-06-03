from fastapi import APIRouter

from app.schemas import (
    ABCompareRequest,
    ABCompareResponse,
    AlgorithmSummary,
    BatchRunRequest,
    BatchRunResponse,
    BatchRunListItem,
    BatchRunResultLabelUpdate,
    BatchRunProgressResponse,
    BatchRunProgressRow,
    QueueRunItem,
    QueueSnapshotResponse,
    WorkerQueueLane,
    ManagedWorkerOut,
    BatchRunResultResponse,
    BatchRunDensityGroup,
    BatchRunTopologyPoint,
    BatchSummary,
    CreateBatchRequest,
    UpdateBatchRequest,
    BatchActionResponse,
    GenerateMultiTopologiesRequest,
    GenerateMultiTopologiesResponse,
    GenerateTopologyRequest,
    GenerateTopologyResponse,
    NodeCoordinateItem,
    TopologyGraphResponse,
    TopologyDetailResponse,
    NodeCoordinatePatch,
    RunArtifactPayloadResponse,
    RunDetailResponse,
    ArtifactRef,
    RunHistoryItem,
    RunSingleRequest,
    RunSingleResponse,
    RunPresetCreate,
    RunPresetOut,
    RunPresetUpdate,
    TopologySummary,
    PlaygroundTreeExpandResponse,
    PlaygroundTreeExpandStats,
    PlaygroundRunTreeResponse,
    PlaygroundTreeResponse,
    PlaygroundTreeEventRequest,
    PlaygroundTreeNode,
    PlaygroundTreeEdge,
)
from app.core.errors import AppError
from app.core.responses import MessageResponse
from app.repositories.run_repo import delete_run as delete_run_repo
from app.repositories.run_repo import delete_batch_run as delete_batch_run_repo
from app.repositories.run_repo import get_artifact_payload as get_artifact_payload_repo
from app.repositories.run_repo import get_batch_run_result as get_batch_run_result_repo
from app.repositories.run_repo import get_run_detail as get_run_detail_repo
from app.repositories.run_repo import get_batch_run_progress as get_batch_run_progress_repo
from app.repositories.run_repo import list_batch_runs as list_batch_runs_repo
from app.repositories.run_repo import update_batch_run_result_label as update_batch_run_result_label_repo
from app.repositories.run_repo import get_queue_snapshot as get_queue_snapshot_repo
from app.repositories.run_repo import request_batch_stop as request_batch_stop_repo
from app.repositories.run_repo import list_run_history
from app.repositories.run_repo import list_topology_ids_with_single_runs as list_topology_ids_with_single_runs_repo
from app.repositories.topology_memory_repo import delete_topology as delete_topology_repo
from app.repositories.topology_memory_repo import create_batch as create_batch_repo
from app.repositories.topology_memory_repo import delete_batch as delete_batch_repo
from app.repositories.topology_memory_repo import list_batches as list_batches_repo
from app.repositories.topology_memory_repo import rename_batch as rename_batch_repo
from app.repositories.topology_memory_repo import set_batch_locked as set_batch_locked_repo
from app.repositories.topology_memory_repo import get_topology as get_topology_repo
from app.repositories.topology_memory_repo import get_topology_nodes as get_topology_nodes_repo
from app.repositories.topology_memory_repo import list_topologies as list_topologies_repo
from app.services.playground_tree_service import (
    append_playground_tree_event,
    derive_playground_tree_from_run,
    expand_playground_tree,
    get_playground_tree,
    reset_playground_tree,
)
from app.services.topology_service import (
    commit_topology_updates,
    generate_connected_topology,
    generate_multi_topologies,
    stage_topology_node_update,
)
from app.services.run_engine_service import resume_batch_job as resume_batch_job_service
from app.services.run_engine_service import run_batch_topologies as run_batch_topologies_service
from app.services.run_engine_service import run_single_topology as run_single_topology_service
from app.services.worker_manager_service import kill_managed_worker, list_managed_workers, spawn_managed_worker
from app.services.run_registry import list_algorithms, resolve_and_validate_run_config
from app.repositories.preset_repo import PresetRecord
from app.repositories.preset_repo import create_preset as create_preset_repo
from app.repositories.preset_repo import delete_preset as delete_preset_repo
from app.repositories.preset_repo import list_presets as list_presets_repo
from app.repositories.preset_repo import update_preset as update_preset_repo

router = APIRouter()


def _preset_record_to_out(rec: PresetRecord) -> RunPresetOut:
    backbone = rec.backbone if rec.backbone in ("qbr", "greedy") else "greedy"
    algorithm_id = rec.algorithm_id if rec.algorithm_id in ("qbr", "greedy") else backbone
    return RunPresetOut(id=rec.id, label=rec.label, backbone=backbone, algorithm_id=algorithm_id, run_config=rec.run_config)


@router.get("/topologies", response_model=list[TopologySummary])
def list_topologies(
    status: str | None = None,
    nodes: int | None = None,
    lower_bound: int | None = None,
) -> list[TopologySummary]:
    items = list_topologies_repo(status=status, node_count=nodes, lower_bound=lower_bound)
    return [
        TopologySummary(
            topology_id=item.topology_id,
            topology_name=item.topology_name,
            status=item.status,
            node_count=item.node_count,
            finished_delay=item.finished_delay,
            lower_bound=item.lower_bound,
            best_delay_explored=item.best_delay_explored,
        )
        for item in items
    ]


@router.get("/batches", response_model=list[BatchSummary])
def list_batches(
    status: str | None = None,
    nodes: int | None = None,
    lower_bound: int | None = None,
) -> list[BatchSummary]:
    rows = list_batches_repo(status=status, node_count=nodes, lower_bound=lower_bound)
    return [
        BatchSummary(
            batch_id=row.batch_id,
            batch_name=row.batch_name,
            is_locked=row.is_locked,
            topologies=[
                TopologySummary(
                    topology_id=topology.topology_id,
                    topology_name=topology.topology_name,
                    status=topology.status,
                    node_count=topology.node_count,
                    finished_delay=topology.finished_delay,
                    lower_bound=topology.lower_bound,
                    best_delay_explored=topology.best_delay_explored,
                )
                for topology in row.topologies
            ],
        )
        for row in rows
    ]


@router.get("/algorithms", response_model=list[AlgorithmSummary])
def get_algorithms() -> list[AlgorithmSummary]:
    return [AlgorithmSummary(**item) for item in list_algorithms()]


@router.get("/presets", response_model=list[RunPresetOut])
def list_run_presets() -> list[RunPresetOut]:
    return [_preset_record_to_out(rec) for rec in list_presets_repo()]


@router.post("/presets", response_model=RunPresetOut)
def create_run_preset(payload: RunPresetCreate) -> RunPresetOut:
    label = payload.label.strip()
    if not label:
        raise AppError(message="Failed.", status_code=400)
    rec = create_preset_repo(
        label=label,
        backbone=payload.backbone,
        algorithm_id=payload.algorithm_id,
        run_config=payload.run_config,
    )
    return _preset_record_to_out(rec)


@router.patch("/presets/{preset_id}", response_model=RunPresetOut)
def update_run_preset(preset_id: str, payload: RunPresetUpdate) -> RunPresetOut:
    if not preset_id.strip():
        raise AppError(message="Failed.", status_code=400)
    rec = update_preset_repo(
        preset_id,
        label=payload.label,
        backbone=payload.backbone,
        algorithm_id=payload.algorithm_id,
        run_config=payload.run_config,
    )
    if rec is None:
        raise AppError(message="Failed.", status_code=404)
    return _preset_record_to_out(rec)


@router.delete("/presets/{preset_id}", response_model=MessageResponse)
def delete_run_preset(preset_id: str) -> MessageResponse:
    ok = delete_preset_repo(preset_id)
    if not ok:
        raise AppError(message="Failed.", status_code=404)
    return MessageResponse(message="Success.")


@router.post("/batches", response_model=BatchActionResponse)
def create_batch(payload: CreateBatchRequest) -> BatchActionResponse:
    try:
        batch_id = create_batch_repo(name=payload.name)
    except ValueError:
        raise AppError(message="Failed.", status_code=400) from None
    return BatchActionResponse(batch_id=batch_id, message="Success.")


@router.patch("/batches/{batch_id}", response_model=BatchActionResponse)
def update_batch(batch_id: str, payload: UpdateBatchRequest) -> BatchActionResponse:
    ok = rename_batch_repo(batch_id=batch_id, name=payload.name)
    if not ok:
        raise AppError(message="Failed.", status_code=400)
    return BatchActionResponse(batch_id=batch_id, message="Success.")


@router.post("/batches/{batch_id}/lock", response_model=BatchActionResponse)
def lock_batch(batch_id: str) -> BatchActionResponse:
    ok = set_batch_locked_repo(batch_id=batch_id, locked=True)
    if not ok:
        raise AppError(message="Failed.", status_code=404)
    return BatchActionResponse(batch_id=batch_id, message="Success.")


@router.post("/batches/{batch_id}/unlock", response_model=BatchActionResponse)
def unlock_batch(batch_id: str) -> BatchActionResponse:
    ok = set_batch_locked_repo(batch_id=batch_id, locked=False)
    if not ok:
        raise AppError(message="Failed.", status_code=404)
    return BatchActionResponse(batch_id=batch_id, message="Success.")


@router.delete("/batches/{batch_id}", response_model=BatchActionResponse)
def delete_batch(batch_id: str) -> BatchActionResponse:
    ok = delete_batch_repo(batch_id=batch_id)
    if not ok:
        raise AppError(message="Failed.", status_code=400)
    return BatchActionResponse(batch_id=batch_id, message="Success.")


@router.patch("/topologies/{topology_id}/nodes", response_model=NodeCoordinatePatch)
def patch_topology_node(topology_id: str, payload: NodeCoordinatePatch) -> NodeCoordinatePatch:
    """Edit node coordinates with clamp and duplicate checks."""
    updated, error = stage_topology_node_update(topology_id=topology_id, payload=payload)
    if updated is None:
        raise AppError(message=error or "Failed.", status_code=400)
    return updated


@router.get("/topologies/{topology_id}/nodes", response_model=list[NodeCoordinateItem])
def get_topology_nodes(topology_id: str) -> list[NodeCoordinateItem]:
    rows = get_topology_nodes_repo(topology_id=topology_id)
    if rows is None:
        raise AppError(message="Failed.", status_code=404)
    return [NodeCoordinateItem(node_id=row.node_id, x=row.x, y=row.y) for row in rows]


@router.get("/topologies/{topology_id}/graph", response_model=TopologyGraphResponse)
def get_topology_graph(topology_id: str) -> TopologyGraphResponse:
    topology = get_topology_repo(topology_id=topology_id)
    if topology is None:
        raise AppError(message="Failed.", status_code=404)
    return TopologyGraphResponse(
        topology_id=topology.topology_id,
        topology_name=topology.topology_name,
        space_width=topology.space_width,
        space_height=topology.space_height,
        tx_range=topology.tx_range,
        nodes=[NodeCoordinateItem(node_id=node.node_id, x=node.x, y=node.y) for node in topology.nodes],
    )


@router.get("/topologies/{topology_id}/detail", response_model=TopologyDetailResponse)
def get_topology_detail(topology_id: str) -> TopologyDetailResponse:
    topology = get_topology_repo(topology_id=topology_id)
    if topology is None:
        raise AppError(message="Failed.", status_code=404)
    return TopologyDetailResponse(
        topology_id=topology.topology_id,
        topology_name=topology.topology_name,
        status=topology.status,
        node_count=topology.node_count,
        space_width=topology.space_width,
        space_height=topology.space_height,
        tx_range=topology.tx_range,
        sink_mode=topology.sink_mode,
        sink_x=topology.sink_x,
        sink_y=topology.sink_y,
        seed=topology.seed,
        created_at=topology.created_at.isoformat(),
        finished_delay=topology.finished_delay,
        lower_bound=topology.lower_bound,
        best_delay_explored=topology.best_delay_explored,
    )


def _playground_tree_response(topology_id: str, payload: dict) -> PlaygroundTreeResponse:
    return PlaygroundTreeResponse(
        topology_id=topology_id,
        root_state_hash=str(payload.get("root_state_hash") or "0"),
        next_state_index=int(payload.get("next_state_index") or 1),
        nodes=[PlaygroundTreeNode(**node) for node in payload.get("nodes") or []],
        edges=[PlaygroundTreeEdge(**edge) for edge in payload.get("edges") or []],
    )


@router.get("/topologies/{topology_id}/playground-tree", response_model=PlaygroundTreeResponse)
def read_playground_tree(topology_id: str) -> PlaygroundTreeResponse:
    payload = get_playground_tree(topology_id)
    if payload is None:
        raise AppError(message="Failed.", status_code=404)
    return _playground_tree_response(topology_id, payload)


@router.post("/topologies/{topology_id}/playground-tree/event", response_model=PlaygroundTreeResponse)
def post_playground_tree_event(topology_id: str, body: PlaygroundTreeEventRequest) -> PlaygroundTreeResponse:
    try:
        payload = append_playground_tree_event(
            topology_id,
            from_state_hash=body.from_state_hash,
            to_state_hash=body.to_state_hash,
            action=body.action,
            mode=body.mode,
            to_covered_node_ids=body.to_covered_node_ids,
        )
    except ValueError:
        raise AppError(message="Failed.", status_code=400) from None
    if payload is None:
        raise AppError(message="Failed.", status_code=404)
    return _playground_tree_response(topology_id, payload)


@router.delete("/topologies/{topology_id}/playground-tree", response_model=PlaygroundTreeResponse)
def delete_playground_tree(topology_id: str) -> PlaygroundTreeResponse:
    payload = reset_playground_tree(topology_id)
    if payload is None:
        raise AppError(message="Failed.", status_code=404)
    return _playground_tree_response(topology_id, payload)


@router.post("/topologies/{topology_id}/playground-tree/expand", response_model=PlaygroundTreeExpandResponse)
def post_playground_tree_expand(topology_id: str) -> PlaygroundTreeExpandResponse:
    payload, stats = expand_playground_tree(topology_id)
    if payload is None or stats is None:
        raise AppError(message="Failed.", status_code=404)
    base = _playground_tree_response(topology_id, payload)
    return PlaygroundTreeExpandResponse(
        **base.model_dump(),
        expand_stats=PlaygroundTreeExpandStats(**stats),
    )


@router.get("/topologies/{topology_id}/playground-tree/run-derived", response_model=PlaygroundRunTreeResponse)
def read_playground_tree_from_run(topology_id: str, run_id: str) -> PlaygroundRunTreeResponse:
    payload, source_artifact, message = derive_playground_tree_from_run(topology_id=topology_id, run_id=run_id)
    if payload is None:
        raise AppError(message="Failed.", status_code=404)
    base = _playground_tree_response(topology_id, payload)
    return PlaygroundRunTreeResponse(
        **base.model_dump(),
        run_id=run_id,
        source_artifact=source_artifact,
        message=message,
    )


@router.post("/topologies/{topology_id}/save", response_model=MessageResponse)
def save_topology(topology_id: str) -> MessageResponse:
    ok, error = commit_topology_updates(topology_id=topology_id)
    if not ok:
        raise AppError(message=error or "Failed.", status_code=400)
    return MessageResponse(message="Success.")


@router.delete("/topologies/{topology_id}", response_model=MessageResponse)
def delete_topology(topology_id: str) -> MessageResponse:
    deleted = delete_topology_repo(topology_id=topology_id)
    if not deleted:
        raise AppError(message="Failed.", status_code=404)
    return MessageResponse(message="Success.")


@router.post("/topologies/generate", response_model=GenerateTopologyResponse)
def generate_topology(payload: GenerateTopologyRequest) -> GenerateTopologyResponse:
    """Generate topology with concise failure message policy."""
    topology, error = generate_connected_topology(payload)
    if topology is None:
        raise AppError(message=error or "Generate topology failed.", status_code=400)
    return GenerateTopologyResponse(
        topology_id=topology.topology_id,
        topology_name=topology.topology_name,
        message="Success.",
    )


@router.post("/topologies/generate/multi", response_model=GenerateMultiTopologiesResponse)
def generate_topologies_multi(payload: GenerateMultiTopologiesRequest) -> GenerateMultiTopologiesResponse:
    created, error = generate_multi_topologies(payload)
    if error is not None:
        raise AppError(message=error or "Failed.", status_code=400)
    return GenerateMultiTopologiesResponse(
        created_count=len(created),
        created_topology_ids=[item.topology_id for item in created],
        message="Success.",
    )


@router.post("/runs/single", response_model=RunSingleResponse)
def run_single_topology(payload: RunSingleRequest) -> RunSingleResponse:
    """Enqueue a single run and return immediately."""
    try:
        run_id = run_single_topology_service(
            topology_id=payload.topology_id,
            algorithm_id=payload.algorithm_id,
            preset_id=payload.preset_id,
            preset_name=payload.preset_name,
            run_config=payload.run_config,
            draft_preset_id=payload.draft_preset_id,
        )
    except ValueError:
        raise AppError(message="Failed.", status_code=400) from None
    except Exception:
        raise AppError(message="Failed.", status_code=500) from None
    return RunSingleResponse(run_id=run_id, completed=False, message="Accepted.")


@router.get("/runs/history", response_model=list[RunHistoryItem])
def get_run_history(topology_id: str) -> list[RunHistoryItem]:
    rows = list_run_history(topology_id=topology_id)
    return [
        RunHistoryItem(
            run_id=row.run_id,
            topology_id=row.topology_id,
            mode=row.mode,
            status=row.status,
            warning_topology_changed=row.warning_topology_changed,
            algorithm_id=row.algorithm_id,
            preset_id=row.preset_id,
            preset_name=row.preset_name,
            created_at=row.created_at.isoformat(),
            finished_delay=row.finished_delay,
            lower_bound=row.lower_bound,
            best_delay_explored=row.best_delay_explored,
            batch_run_id=row.batch_run_id,
            batch_result_label=row.batch_result_label,
            runtime_sec=row.runtime_sec,
            error_message=row.error_message,
            total_states=row.total_states,
            total_state_actions=row.total_state_actions,
            decision_graph_edges=row.decision_graph_edges,
        )
        for row in rows
    ]


@router.get("/runs/history/single/topology-ids", response_model=list[str])
def list_single_run_topology_ids() -> list[str]:
    return list_topology_ids_with_single_runs_repo()


@router.get("/runs/queue", response_model=QueueSnapshotResponse)
def get_run_queue() -> QueueSnapshotResponse:
    rec = get_queue_snapshot_repo()
    return QueueSnapshotResponse(
        total_queued=rec.total_queued,
        total_running=rec.total_running,
        lane_count=rec.lane_count,
        lanes=[
            WorkerQueueLane(
                lane_id=lane.lane_id,
                worker_id=lane.worker_id,
                running=(
                    QueueRunItem(
                        run_id=lane.running.run_id,
                        topology_id=lane.running.topology_id,
                        topology_name=lane.running.topology_name,
                        mode=lane.running.mode,
                        status=lane.running.status,
                        worker_id=lane.running.worker_id,
                        queue_priority=lane.running.queue_priority,
                        batch_run_id=lane.running.batch_run_id,
                        batch_label=lane.running.batch_label,
                        created_at=lane.running.created_at.isoformat(),
                    )
                    if lane.running is not None
                    else None
                ),
                queued=[
                    QueueRunItem(
                        run_id=item.run_id,
                        topology_id=item.topology_id,
                        topology_name=item.topology_name,
                        mode=item.mode,
                        status=item.status,
                        worker_id=item.worker_id,
                        queue_priority=item.queue_priority,
                        batch_run_id=item.batch_run_id,
                        batch_label=item.batch_label,
                        created_at=item.created_at.isoformat(),
                    )
                    for item in lane.queued
                ],
            )
            for lane in rec.lanes
        ],
    )


@router.get("/workers", response_model=list[ManagedWorkerOut])
def list_workers() -> list[ManagedWorkerOut]:
    return [ManagedWorkerOut(**row) for row in list_managed_workers()]


@router.post("/workers", response_model=ManagedWorkerOut)
def create_worker() -> ManagedWorkerOut:
    try:
        row = spawn_managed_worker()
    except ValueError:
        raise AppError(message="Failed.", status_code=400) from None
    return ManagedWorkerOut(**row)


@router.delete("/workers/{worker_id}", response_model=MessageResponse)
def delete_worker(worker_id: str) -> MessageResponse:
    if not worker_id.strip():
        raise AppError(message="Failed.", status_code=400)
    ok = kill_managed_worker(worker_id.strip())
    if not ok:
        raise AppError(message="Failed.", status_code=404)
    return MessageResponse(message="Success.")


@router.get("/runs/{run_id}", response_model=RunDetailResponse)
def get_run_detail(run_id: str) -> RunDetailResponse:
    row = get_run_detail_repo(run_id=run_id)
    if row is None:
        raise AppError(message="Failed.", status_code=404)
    return RunDetailResponse(
        run_id=row.run_id,
        topology_id=row.topology_id,
        mode=row.mode,
        status=row.status,
        warning_topology_changed=row.warning_topology_changed,
        algorithm_id=row.algorithm_id,
        preset_id=row.preset_id,
        preset_name=row.preset_name,
        created_at=row.created_at.isoformat(),
        started_at=row.started_at.isoformat() if row.started_at else None,
        ended_at=row.ended_at.isoformat() if row.ended_at else None,
        runtime_sec=row.runtime_sec,
        error_message=row.error_message,
        finished_delay=row.finished_delay,
        lower_bound=row.lower_bound,
        best_delay_explored=row.best_delay_explored,
        reward_final=row.reward_final,
        total_states=row.total_states,
        total_state_actions=row.total_state_actions,
        decision_graph_edges=row.decision_graph_edges,
        artifacts=[
            ArtifactRef(
                artifact_type=item.artifact_type,
                uri=item.uri,
                size_bytes=item.size_bytes,
                checksum=item.checksum,
                created_at=item.created_at.isoformat(),
            )
            for item in row.artifacts
        ],
    )


@router.delete("/runs/{run_id}", response_model=MessageResponse)
def delete_run(run_id: str) -> MessageResponse:
    deleted = delete_run_repo(run_id=run_id)
    if not deleted:
        raise AppError(message="Failed.", status_code=404)
    return MessageResponse(message="Success.")


@router.get("/runs/{run_id}/artifacts/{artifact_type}", response_model=RunArtifactPayloadResponse)
def get_run_artifact(run_id: str, artifact_type: str) -> RunArtifactPayloadResponse:
    payload = get_artifact_payload_repo(run_id=run_id, artifact_type=artifact_type)
    if payload is None:
        raise AppError(message="Failed.", status_code=404)
    return RunArtifactPayloadResponse(run_id=run_id, artifact_type=artifact_type, payload=payload)


@router.post("/runs/batch", response_model=BatchRunResponse)
def run_batch(payload: BatchRunRequest) -> BatchRunResponse:
    """Enqueue a batch: returns immediately; execution runs in a background worker."""
    try:
        batch_run_id = run_batch_topologies_service(
            topology_ids=payload.topology_ids,
            algorithm_id=payload.algorithm_id,
            preset_id=payload.preset_id,
            preset_name=payload.preset_name,
            run_config=payload.run_config,
            save_full_artifacts_for_selected_runs=payload.save_full_artifacts_for_selected_runs,
            selected_artifact_topology_ids=payload.selected_artifact_topology_ids,
            selected_artifact_types=payload.selected_artifact_types,
            draft_preset_id=payload.draft_preset_id,
            result_label=payload.result_label,
        )
    except ValueError:
        raise AppError(message="Failed.", status_code=400) from None
    except Exception:
        raise AppError(message="Failed.", status_code=500) from None
    return BatchRunResponse(batch_run_id=batch_run_id, accepted=True, total_topologies=len(payload.topology_ids))


@router.get("/runs/batch/results", response_model=list[BatchRunListItem])
def list_batch_results() -> list[BatchRunListItem]:
    rows = list_batch_runs_repo()
    return [
        BatchRunListItem(
            batch_run_id=item.batch_run_id,
            batch_name=item.batch_name,
            algorithm_id=item.algorithm_id,
            preset_id=item.preset_id,
            preset_name=item.preset_name,
            result_label=item.result_label,
            custom_result_label=item.custom_result_label,
            total_topologies=item.total_topologies,
            successful=item.successful,
            failed=item.failed,
            created_at=item.created_at.isoformat(),
            batch_status=item.batch_status,
        )
        for item in rows
    ]


@router.patch("/runs/batch/{batch_run_id}/result-label", response_model=BatchRunListItem)
def patch_batch_run_result_label(batch_run_id: str, body: BatchRunResultLabelUpdate) -> BatchRunListItem:
    if not update_batch_run_result_label_repo(batch_run_id, body.result_label):
        raise AppError(message="Failed.", status_code=404)
    rows = list_batch_runs_repo()
    row = next((item for item in rows if item.batch_run_id == batch_run_id), None)
    if row is None:
        raise AppError(message="Failed.", status_code=404)
    return BatchRunListItem(
        batch_run_id=row.batch_run_id,
        batch_name=row.batch_name,
        algorithm_id=row.algorithm_id,
        preset_id=row.preset_id,
        preset_name=row.preset_name,
        result_label=row.result_label,
        custom_result_label=row.custom_result_label,
        total_topologies=row.total_topologies,
        successful=row.successful,
        failed=row.failed,
        created_at=row.created_at.isoformat(),
        batch_status=row.batch_status,
    )


@router.get("/runs/batch/{batch_run_id}/progress", response_model=BatchRunProgressResponse)
def get_batch_progress(batch_run_id: str) -> BatchRunProgressResponse:
    rec = get_batch_run_progress_repo(batch_run_id)
    if rec is None:
        raise AppError(message="Failed.", status_code=404)
    return BatchRunProgressResponse(
        batch_run_id=rec.batch_run_id,
        batch_status=rec.batch_status,
        stop_requested=rec.stop_requested,
        total_topologies=rec.total_topologies,
        pending=rec.pending,
        running=rec.running,
        done=rec.done,
        failed=rec.failed,
        stopped=rec.stopped,
        rows=[
            BatchRunProgressRow(
                run_id=r.run_id,
                topology_id=r.topology_id,
                topology_name=r.topology_name,
                topology_index=r.topology_index,
                status=r.status,
            )
            for r in rec.rows
        ],
    )


@router.get("/runs/batch/{batch_run_id}/result", response_model=BatchRunResultResponse)
def get_batch_result(batch_run_id: str) -> BatchRunResultResponse:
    row = get_batch_run_result_repo(batch_run_id=batch_run_id)
    if row is None:
        raise AppError(message="Failed.", status_code=404)
    run_config = row.run_config if isinstance(row.run_config, dict) else {}
    temperature_mode = str(run_config.get("temperature_start_mode", "manual"))
    try:
        resolved_run_config = (
            None
            if temperature_mode == "node_count_multiplier"
            else resolve_and_validate_run_config(
                algorithm_id=row.algorithm_id,
                preset_id=row.preset_id,
                run_config=run_config,
            )
        )
    except ValueError:
        resolved_run_config = None
    return BatchRunResultResponse(
        batch_run_id=row.batch_run_id,
        batch_name=row.batch_name,
        algorithm_id=row.algorithm_id,
        preset_id=row.preset_id,
        preset_name=row.preset_name,
        run_config=run_config,
        resolved_run_config={
            "batch_run_id": row.batch_run_id,
            "algorithm_id": row.algorithm_id,
            "preset_id": row.preset_id,
            "preset_name": row.preset_name,
            "draft_preset_id": row.draft_preset_id,
            "resolved_run_config": resolved_run_config,
        }
        if resolved_run_config is not None
        else None,
        result_label=row.result_label,
        custom_result_label=row.custom_result_label,
        total_topologies=row.total_topologies,
        successful=row.successful,
        failed=row.failed,
        density_groups=[
            BatchRunDensityGroup(
                node_count=item.node_count,
                topologies=[
                    BatchRunTopologyPoint(
                        topology_id=topo.topology_id,
                        topology_name=topo.topology_name,
                        topology_index=topo.topology_index,
                        node_count=topo.node_count,
                        status=topo.status,
                        last_delay=topo.last_delay,
                        best_delay=topo.best_delay,
                        lower_bound=topo.lower_bound,
                        unique_path_count=topo.unique_path_count,
                        best_delay_unique_path_count=topo.best_delay_unique_path_count,
                        delay_per_episode=topo.delay_per_episode,
                        paths_count_by_delay=topo.paths_count_by_delay,
                        total_states=topo.total_states,
                        total_state_actions=topo.total_state_actions,
                    )
                    for topo in item.topologies
                ],
            )
            for item in row.density_groups
        ],
        topologies=[
            BatchRunTopologyPoint(
                topology_id=topo.topology_id,
                topology_name=topo.topology_name,
                topology_index=topo.topology_index,
                node_count=topo.node_count,
                status=topo.status,
                last_delay=topo.last_delay,
                best_delay=topo.best_delay,
                lower_bound=topo.lower_bound,
                unique_path_count=topo.unique_path_count,
                best_delay_unique_path_count=topo.best_delay_unique_path_count,
                delay_per_episode=topo.delay_per_episode,
                paths_count_by_delay=topo.paths_count_by_delay,
                total_states=topo.total_states,
                total_state_actions=topo.total_state_actions,
            )
            for topo in row.topologies
        ],
    )


@router.post("/runs/batch/{batch_run_id}/stop")
def stop_batch(batch_run_id: str) -> MessageResponse:
    """Request graceful stop: worker finishes the current topology then marks remaining queued items as stopped."""
    ok = request_batch_stop_repo(batch_run_id)
    if not ok:
        raise AppError(message="Failed.", status_code=400)
    return MessageResponse(message="Stop requested.")


@router.post("/runs/batch/{batch_run_id}/resume")
def resume_batch(batch_run_id: str) -> MessageResponse:
    """Resume queued execution for stopped topologies after a stopped batch."""
    ok, msg = resume_batch_job_service(batch_run_id)
    if not ok:
        raise AppError(message=msg or "Failed.", status_code=400)
    return MessageResponse(message="Resumed.")


@router.delete("/runs/batch/{batch_run_id}", response_model=MessageResponse)
def delete_batch(batch_run_id: str) -> MessageResponse:
    ok = delete_batch_run_repo(batch_run_id)
    if not ok:
        raise AppError(message="Failed.", status_code=404)
    return MessageResponse(message="Success.")


@router.post("/compare/ab", response_model=ABCompareResponse)
def compare_ab(payload: ABCompareRequest) -> ABCompareResponse:
    """A/B compare for same-topo or same-batch modes."""
    # TODO: run or load compare result.
    return ABCompareResponse(
        mode=payload.mode,
        include_lower_bound=True,
        include_greedy=False,
        series_labels=["config_a", "config_b", "lower_bound"],
    )

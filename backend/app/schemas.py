from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class TopologySummary(BaseModel):
    topology_id: str
    topology_name: str
    status: Literal["new", "done", "pending", "running"] = "new"
    node_count: int = 0
    finished_delay: int | None = None
    lower_bound: int | None = None
    best_delay_explored: int | None = None


class BatchSummary(BaseModel):
    batch_id: str
    batch_name: str
    is_locked: bool = False
    topologies: list[TopologySummary]


class CreateBatchRequest(BaseModel):
    name: str


class UpdateBatchRequest(BaseModel):
    name: str


class BatchActionResponse(BaseModel):
    batch_id: str
    message: str


class NodeCoordinatePatch(BaseModel):
    node_id: int
    x: int
    y: int
    min_bound: int = 0
    max_bound_x: int = 100
    max_bound_y: int = 100

    @field_validator("node_id")
    @classmethod
    def non_negative_node_id(cls, value: int) -> int:
        if value < 0:
            raise ValueError("node_id must be non-negative")
        return value


class NodeCoordinateItem(BaseModel):
    node_id: int
    x: int
    y: int


class TopologyGraphResponse(BaseModel):
    topology_id: str
    topology_name: str
    space_width: int
    space_height: int
    tx_range: float
    nodes: list[NodeCoordinateItem]


class TopologyDetailResponse(BaseModel):
    topology_id: str
    topology_name: str
    status: str
    node_count: int
    space_width: int
    space_height: int
    tx_range: float
    sink_mode: str
    sink_x: int
    sink_y: int
    seed: int | None = None
    created_at: str
    finished_delay: int | None = None
    lower_bound: int | None = None
    best_delay_explored: int | None = None


class RunSingleRequest(BaseModel):
    topology_id: str
    algorithm_id: str
    preset_id: str
    preset_name: str
    run_config: dict[str, Any] = Field(default_factory=dict)
    draft_preset_id: str | None = None


class RunSingleResponse(BaseModel):
    run_id: str
    completed: bool
    message: str


class BatchRunRequest(BaseModel):
    topology_ids: list[str] = Field(default_factory=list)
    algorithm_id: str
    preset_id: str
    preset_name: str
    run_config: dict[str, Any] = Field(default_factory=dict)
    draft_preset_id: str | None = None
    save_full_artifacts_for_selected_runs: bool = False
    selected_artifact_topology_ids: list[str] = Field(default_factory=list)
    selected_artifact_types: list[str] = Field(default_factory=list)


class BatchRunResponse(BaseModel):
    batch_run_id: str
    accepted: bool
    total_topologies: int


class BatchRunListItem(BaseModel):
    batch_run_id: str
    batch_name: str
    algorithm_id: str
    preset_id: str
    preset_name: str
    result_label: str
    total_topologies: int
    successful: int
    failed: int
    created_at: str
    batch_status: str = "completed"


class BatchRunTopologyPoint(BaseModel):
    topology_id: str
    topology_name: str
    topology_index: int
    node_count: int
    status: str
    last_delay: int | None = None
    best_delay: int | None = None
    lower_bound: int | None = None
    unique_path_count: int | None = None
    best_delay_unique_path_count: int | None = None
    delay_per_episode: list[int] = Field(default_factory=list)


class BatchRunDensityGroup(BaseModel):
    node_count: int
    topologies: list[BatchRunTopologyPoint] = Field(default_factory=list)


class BatchRunProgressRow(BaseModel):
    run_id: str
    topology_id: str
    topology_name: str
    topology_index: int
    status: str


class BatchRunProgressResponse(BaseModel):
    batch_run_id: str
    batch_status: str
    stop_requested: bool
    total_topologies: int
    pending: int
    running: int
    done: int
    failed: int
    stopped: int
    rows: list[BatchRunProgressRow] = Field(default_factory=list)


class QueueRunItem(BaseModel):
    run_id: str
    topology_id: str
    topology_name: str
    mode: str
    status: str
    worker_id: str | None = None
    queue_priority: int
    batch_run_id: str | None = None
    batch_label: str | None = None
    created_at: str


class WorkerQueueLane(BaseModel):
    lane_id: str
    worker_id: str | None = None
    running: QueueRunItem | None = None
    queued: list[QueueRunItem] = Field(default_factory=list)


class QueueSnapshotResponse(BaseModel):
    total_queued: int
    total_running: int
    lane_count: int
    lanes: list[WorkerQueueLane] = Field(default_factory=list)


class BatchRunResultResponse(BaseModel):
    batch_run_id: str
    batch_name: str
    algorithm_id: str
    preset_id: str
    preset_name: str
    resolved_run_config: dict[str, Any] | None = None
    result_label: str
    total_topologies: int
    successful: int
    failed: int
    density_groups: list[BatchRunDensityGroup] = Field(default_factory=list)
    topologies: list[BatchRunTopologyPoint] = Field(default_factory=list)


class ABCompareRequest(BaseModel):
    mode: Literal["same_topology", "same_batch"]
    target_id: str
    algorithm_a: str
    config_a: str
    algorithm_b: str
    config_b: str


class ABCompareResponse(BaseModel):
    mode: Literal["same_topology", "same_batch"]
    include_lower_bound: bool = True
    include_greedy: bool = False
    series_labels: list[str]


class GenerateTopologyRequest(BaseModel):
    num_nodes: int
    space_width: int
    space_height: int
    tx_range: float
    sink_mode: Literal["manual", "corner_tl", "corner_tr", "corner_bl", "corner_br", "center"] = "manual"
    sink_x: int | None = None
    sink_y: int | None = None
    seed: int | None = None
    max_retry: int = 200
    batch_id: str | None = None


class GenerateTopologyResponse(BaseModel):
    topology_id: str
    topology_name: str
    message: str


class GenerateMultiTopologiesRequest(BaseModel):
    node_counts: list[int] = Field(default_factory=list)
    count_per_node_count: int = 1
    space_width: int
    space_height: int
    tx_range: float
    sink_mode: Literal["manual", "corner_tl", "corner_tr", "corner_bl", "corner_br", "center"] = "manual"
    sink_x: int | None = None
    sink_y: int | None = None
    seed: int | None = None
    max_retry: int = 200
    batch_id: str | None = None


class GenerateMultiTopologiesResponse(BaseModel):
    created_count: int
    created_topology_ids: list[str]
    message: str


class RunHistoryItem(BaseModel):
    run_id: str
    topology_id: str
    mode: str
    status: str
    warning_topology_changed: bool
    algorithm_id: str
    preset_id: str
    preset_name: str
    created_at: str
    finished_delay: int | None = None
    lower_bound: int | None = None
    best_delay_explored: int | None = None
    batch_run_id: str | None = None
    batch_result_label: str | None = None


class RunArtifactPayloadResponse(BaseModel):
    run_id: str
    artifact_type: str
    payload: Any


class ArtifactRef(BaseModel):
    artifact_type: str
    uri: str
    size_bytes: int | None = None
    checksum: str | None = None
    created_at: str


class RunDetailResponse(BaseModel):
    run_id: str
    topology_id: str
    mode: str
    status: str
    warning_topology_changed: bool
    algorithm_id: str
    preset_id: str
    preset_name: str
    created_at: str
    started_at: str | None = None
    ended_at: str | None = None
    runtime_sec: float | None = None
    error_message: str | None = None
    finished_delay: int | None = None
    lower_bound: int | None = None
    best_delay_explored: int | None = None
    reward_final: float | None = None
    artifacts: list[ArtifactRef] = Field(default_factory=list)


class AlgorithmSummary(BaseModel):
    algorithm_id: str
    display_name: str
    version: str = "v1"
    default_config: dict[str, Any] = Field(default_factory=dict)
    config_schema: dict[str, Any] = Field(default_factory=dict)
    capabilities: dict[str, bool] = Field(default_factory=dict)


class RunPresetOut(BaseModel):
    id: str
    label: str
    backbone: Literal["qbr", "greedy"]
    algorithm_id: Literal["qbr", "greedy"]
    run_config: dict[str, Any] = Field(default_factory=dict)


class RunPresetCreate(BaseModel):
    label: str
    backbone: Literal["qbr", "greedy"]
    algorithm_id: Literal["qbr", "greedy"]
    run_config: dict[str, Any] = Field(default_factory=dict)


class RunPresetUpdate(BaseModel):
    label: str | None = None
    backbone: Literal["qbr", "greedy"] | None = None
    algorithm_id: Literal["qbr", "greedy"] | None = None
    run_config: dict[str, Any] | None = None

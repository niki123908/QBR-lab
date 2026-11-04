"""Energy topology persistence is deliberately separate from broadcast/run tables."""
from copy import deepcopy
from collections import deque
from dataclasses import asdict
import random
from uuid import uuid4

from sqlalchemy import select

from app.core.db import db_session_scope
from app.core.errors import AppError
from app.models import EnergyBatch, EnergyTopology, EnergyRun
from app.services.energy_run_queries import read_runs
from app.energy_schemas import EnergyGenerate, EnergyMultiGenerate
from app.services.topology_service import _resolve_sink_xy, _generate_unique_nodes

DEFAULT_ID = "energy-default"


def batch_row(session, batch_id, writable=False):
    if batch_id is None:
        # PostgreSQL upsert makes first-use default creation safe across concurrent requests.
        from sqlalchemy.dialects.postgresql import insert
        session.execute(insert(EnergyBatch).values(id=DEFAULT_ID, name="Default batch", is_locked=False,
                        is_deleted=False).on_conflict_do_nothing(index_elements=["id"]))
        batch_id = DEFAULT_ID
    row = session.scalar(select(EnergyBatch).where(EnergyBatch.id == batch_id).with_for_update())
    if row is None or row.is_deleted:
        raise AppError("Energy batch not found.", 404)
    if writable and row.is_locked:
        raise AppError("Batch is locked. Unlock it before editing.", 409)
    return row


def topology_row(session, topology_id, writable=False):
    # Lock batch before topology for consistent lock ordering with generation/deletion.
    batch_id = session.scalar(select(EnergyTopology.batch_id).where(EnergyTopology.id == topology_id))
    if batch_id is None:
        raise AppError("Energy topology not found.", 404)
    batch_row(session, batch_id, writable=writable)
    row = session.scalar(select(EnergyTopology).where(EnergyTopology.id == topology_id).with_for_update())
    if row is None or row.is_deleted:
        raise AppError("Energy topology not found.", 404)
    return row


def hop_bound(nodes, tx_range):
    """Source eccentricity; a topology-only lower bound, not an energy-delay prediction."""
    neighbors = [[] for _ in nodes]
    radius_sq = tx_range ** 2
    for i, a in enumerate(nodes):
        for j in range(i + 1, len(nodes)):
            b = nodes[j]
            if (a["x"]-b["x"])**2 + (a["y"]-b["y"])**2 <= radius_sq:
                neighbors[i].append(j)
                neighbors[j].append(i)
    distances = {0: 0}
    queue = deque([0])
    while queue:
        i = queue.popleft()
        for j in neighbors[i]:
            if j not in distances:
                distances[j] = distances[i]+1
                queue.append(j)
    return max(distances.values()) if len(distances) == len(nodes) else None


def build_payload(request: EnergyGenerate, seed: int):
    ok, sink = _resolve_sink_xy(request)
    if not ok or sink is None or not (0 <= sink[0] <= request.space_width and 0 <= sink[1] <= request.space_height):
        raise AppError("Source coordinates must be inside the topology area.")
    if request.num_nodes > (request.space_width+1)*(request.space_height+1):
        raise AppError("Too many nodes for distinct integer positions in this area.")
    if request.num_nodes > 1 and request.tx_range < 1:
        raise AppError("TX range must be at least 1 for distinct integer node positions.")
    for attempt in range(request.max_retry):
        nodes = [asdict(n) for n in _generate_unique_nodes(request.num_nodes, request.space_width,
                  request.space_height, sink, random.Random(seed+attempt))]
        lower_bound = hop_bound(nodes, request.tx_range)
        if lower_bound is not None:
            break
    else:
        raise AppError("No connected topology within Max retry. Increase TX range or retries, or reduce area size.")
    # Independent stream: geometry retries never change the energy sampling sequence.
    rng = random.Random(f"energy-v1:{seed}")
    e = request.energy
    for node in nodes:
        source = node["node_id"] == 0
        rate = (rng.triangular(e.harvest_min, e.harvest_max, e.harvest_mode)
                if e.distribution == "triangular" else rng.uniform(e.harvest_min, e.harvest_max))
        node.update(source_unlimited=source, harvest_rate=None if source else rate,
                    initial_energy=None if source else 0)
    return dict(schema_version=1, node_count=request.num_nodes, space_width=request.space_width,
                space_height=request.space_height, tx_range=request.tx_range, sink_mode=request.sink_mode,
                sink_x=sink[0], sink_y=sink[1], seed=seed, geometry_seed=seed+attempt,
                energy_defaults=e.model_dump(), nodes=nodes, lower_bound=lower_bound)


def summary(row, run=None):
    result = run.result or {} if run else {}
    return dict(topology_id=row.id, topology_name=row.name, status=run.status if run else "new", node_count=row.payload["node_count"],
                lower_bound=row.payload["lower_bound"], finished_delay=(result.get("last") or {}).get("delay"),
                best_delay_explored=(result.get("best") or {}).get("delay"))


def matches(row, status=None, nodes=None, lower_bound=None):
    return ((not status or status == "new") and (nodes is None or row.payload["node_count"] == nodes)
            and (lower_bound is None or row.payload["lower_bound"] == lower_bound))


def list_data(batches=False, **filters):
    with db_session_scope() as s:
        bs = s.scalars(select(EnergyBatch).where(EnergyBatch.is_deleted.is_(False)).order_by(EnergyBatch.name)).all()
        rows = s.scalars(select(EnergyTopology).where(EnergyTopology.is_deleted.is_(False),
                         EnergyTopology.batch_id.in_([b.id for b in bs])).order_by(EnergyTopology.name)).all()
        latest = {r.topology_id:r for r in read_runs(s, select(EnergyRun).where(EnergyRun.topology_id.in_([r.id for r in rows]))
                  .distinct(EnergyRun.topology_id).order_by(EnergyRun.topology_id, EnergyRun.created_at.desc()))}
        status = filters.pop("status", None)
        rows = [r for r in rows if matches(r, **filters) and (not status or summary(r, latest.get(r.id))["status"] == status)]
        if not batches:
            return [summary(r, latest.get(r.id)) for r in rows]
        return [dict(batch_id=b.id, batch_name=b.name, is_locked=b.is_locked,
                     topologies=[summary(r, latest.get(r.id)) for r in rows if r.batch_id == b.id]) for b in bs]


def generate(request: EnergyGenerate, multi=False):
    counts = ([n for n in request.node_counts for _ in range(request.count_per_node_count)]
              if multi else [request.num_nodes])
    # Validate the batch first, then recheck its lock under transaction before saving.
    if request.batch_id:
        with db_session_scope() as s:
            batch_row(s, request.batch_id, writable=True)
    seeds = random.SystemRandom().sample(range(2147483647), len(counts)) if request.seed is None else [
        (request.seed+i) % 2147483648 for i in range(len(counts))]
    payloads = [build_payload(request.model_copy(update={"num_nodes": n}), seed) for n, seed in zip(counts, seeds)]
    # Atomic multi-create: failed geometry never leaves half a generated batch.
    with db_session_scope() as s:
        batch = batch_row(s, request.batch_id, writable=True)
        names = set(s.scalars(select(EnergyTopology.name).where(EnergyTopology.batch_id == batch.id)).all())
        created = []
        for payload in payloads:
            n = payload["node_count"]
            i = 0
            while f"tp_{n}_{i:02d}" in names:
                i += 1
            name = f"tp_{n}_{i:02d}"
            names.add(name)
            row = EnergyTopology(id=str(uuid4()), batch_id=batch.id, name=name, payload=payload)
            s.add(row)
            created.append(row)
        s.flush()
        if multi:
            return dict(created_count=len(created), created_topology_ids=[r.id for r in created], message="Success.")
        return dict(topology_id=created[0].id, topology_name=created[0].name, message="Success.")


def get_data(topology_id, kind):
    with db_session_scope() as s:
        row = topology_row(s, topology_id)
        data = deepcopy(row.payload)
        if kind == "nodes":
            return row.draft_nodes if row.draft_nodes is not None else data["nodes"]
        latest_rows = read_runs(s, select(EnergyRun).where(EnergyRun.topology_id == row.id).order_by(EnergyRun.created_at.desc()).limit(1))
        latest = latest_rows[0] if latest_rows else None
        data.update(summary(row, latest), created_at=row.created_at.isoformat(), batch_id=row.batch_id)
        return data


def edit_node(topology_id, patch):
    with db_session_scope() as s:
        row = topology_row(s, topology_id, writable=True)
        data = row.payload
        nodes = deepcopy(row.draft_nodes if row.draft_nodes is not None else data["nodes"])
        node = next((n for n in nodes if n["node_id"] == patch.node_id), None)
        if node is None:
            raise AppError("Node not found.", 404)
        if not (0 <= patch.x <= data["space_width"] and 0 <= patch.y <= data["space_height"]):
            raise AppError("Coordinates must be inside the topology area.")
        if any(n["node_id"] != patch.node_id and (n["x"], n["y"]) == (patch.x, patch.y) for n in nodes):
            raise AppError("Two nodes cannot share the same position.")
        node.update(x=patch.x, y=patch.y)
        row.draft_nodes = nodes
        return patch.model_dump()


def save_topology(topology_id):
    with db_session_scope() as s:
        row = topology_row(s, topology_id, writable=True)
        data = deepcopy(row.payload)
        if row.draft_nodes is not None:
            lower_bound = hop_bound(row.draft_nodes, data["tx_range"])
            if lower_bound is None:
                raise AppError("Cannot save a disconnected topology. Adjust node positions first.")
            data["nodes"] = row.draft_nodes
            data["lower_bound"] = lower_bound
            source = next(n for n in row.draft_nodes if n["node_id"] == 0)
            if (source["x"], source["y"]) != (data["sink_x"], data["sink_y"]):
                data.update(sink_mode="manual", sink_x=source["x"], sink_y=source["y"])
            row.payload = data
            row.draft_nodes = None
        return {"message": "Success."}


def remove_topology(topology_id):
    with db_session_scope() as s:
        row = topology_row(s, topology_id, writable=True)
        row.is_deleted = True
        return {"message": "Success."}


def manage_batch(action, batch_id=None, name=None):
    with db_session_scope() as s:
        if action in ("create", "rename"):
            name = (name or "").strip()
            if not name or len(name) > 255:
                raise AppError("Batch name must contain 1–255 characters.")
            if s.scalar(select(EnergyBatch.id).where(EnergyBatch.name == name, EnergyBatch.id != (batch_id or ""))):
                raise AppError("A batch with this name already exists.", 409)
        if action == "create":
            if name == "Default batch":
                raise AppError("Default batch is created automatically.")
            row = EnergyBatch(id=str(uuid4()), name=name)
            s.add(row)
        else:
            row = batch_row(s, batch_id, writable=action in ("rename", "delete"))
            if action in ("rename", "delete") and row.id == DEFAULT_ID:
                raise AppError("The default batch cannot be renamed or deleted.")
            if action == "rename": row.name = name
            elif action == "lock": row.is_locked = True
            elif action == "unlock": row.is_locked = False
            elif action == "delete": row.is_deleted = True
        return {"batch_id": row.id, "message": "Success."}

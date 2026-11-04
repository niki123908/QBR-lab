"""Run with pytest backend/tests/test_energy_topologies.py (PostgreSQL configured)."""
from contextlib import contextmanager
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.energy_routes import router
from app.core.db import engine, init_db
from app.core.errors import AppError
from app.models import EnergyTopology, Topology
from app.services import energy_topology_service as service


@pytest.fixture
def client(monkeypatch):
    init_db()
    connection = engine.connect()
    transaction = connection.begin()

    @contextmanager
    def scope():
        with Session(bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False) as s:
            with s.begin():
                yield s

    monkeypatch.setattr(service, "db_session_scope", scope)
    app = FastAPI()
    app.include_router(router, prefix="/api/energy")

    @app.exception_handler(AppError)
    async def handle(_, exc):
        return JSONResponse(status_code=exc.status_code, content={"message": exc.message})

    with TestClient(app) as c:
        yield c
    transaction.rollback()
    connection.close()


def config(**updates):
    return dict(num_nodes=10, space_width=20, space_height=20, tx_range=30,
                sink_mode="center", seed=42, energy=dict(harvest_min=2, harvest_max=8,
                capacity=100, tx_cost=20, rx_cost=10), **updates)


def create(client, data=None):
    r = client.post("/api/energy/topologies/generate", json=data or config())
    assert r.status_code == 200, r.text
    return r.json()["topology_id"]


def test_generation_persistence_reproducibility_and_isolation(client):
    a, b = create(client), create(client)
    nodes = client.get(f"/api/energy/topologies/{a}/nodes").json()
    assert nodes == client.get(f"/api/energy/topologies/{b}/nodes").json()
    assert nodes[0]["source_unlimited"] and nodes[0]["harvest_rate"] is None
    assert all(2 <= n["harvest_rate"] <= 8 and n["initial_energy"] == 0 for n in nodes[1:])
    assert len({(n["x"], n["y"]) for n in nodes}) == 10
    assert service.hop_bound(nodes, 30) is not None
    detail = client.get(f"/api/energy/topologies/{a}/detail").json()
    assert detail["energy_defaults"]["capacity"] == 100
    with service.db_session_scope() as s:
        assert s.get(EnergyTopology, a).payload["nodes"] == nodes
        assert s.get(Topology, a) is None
        broadcast_id = s.scalar(select(Topology.id))
    if broadcast_id:
        assert client.get(f"/api/energy/topologies/{broadcast_id}/nodes").status_code == 404


@pytest.mark.parametrize("energy", [
    {"harvest_min": 10, "harvest_max": 2}, {"harvest_min": 0},
    {"capacity": 5, "tx_cost": 20}, {"rx_cost": -1},
    {"distribution": "triangular", "harvest_mode": 11},
])
def test_invalid_energy_rejected(client, energy):
    data = config()
    data["energy"].update(energy)
    assert client.post("/api/energy/topologies/generate", json=data).status_code == 422


def test_triangular_and_constant_rate(client):
    data = config()
    data["energy"].update(distribution="triangular", harvest_mode=3)
    a = create(client, data)
    assert all(2 <= n["harvest_rate"] <= 8 for n in client.get(f"/api/energy/topologies/{a}/nodes").json()[1:])
    data["energy"].update(harvest_min=3, harvest_max=3)
    a = create(client, data)
    assert all(n["harvest_rate"] == 3 for n in client.get(f"/api/energy/topologies/{a}/nodes").json()[1:])


def test_edit_preserves_rates_and_rejects_bad_positions(client):
    a = create(client)
    url = f"/api/energy/topologies/{a}"
    before = client.get(url+"/nodes").json()
    assert client.patch(url+"/nodes", json={"node_id":1,"x":-1,"y":0}).status_code == 400
    assert client.patch(url+"/nodes", json={"node_id":1,"x":before[0]["x"],"y":before[0]["y"]}).status_code == 400
    occupied = {(n["x"],n["y"]) for n in before}
    x,y = next((x,y) for x in range(21) for y in range(21) if (x,y) not in occupied)
    assert client.patch(url+"/nodes", json={"node_id":1,"x":x,"y":y}).status_code == 200
    assert client.post(url+"/save").status_code == 200
    after = client.get(url+"/nodes").json()
    assert [n["harvest_rate"] for n in before] == [n["harvest_rate"] for n in after]
    assert (after[1]["x"], after[1]["y"]) == (x,y)


def test_batch_lock_multigenerate_delete_and_failure_atomicity(client):
    batch = client.post("/api/energy/batches", json={"name":"test-"+str(uuid4())}).json()["batch_id"]
    data = config(batch_id=batch)
    data.update(node_counts=[5,10], count_per_node_count=2)
    r = client.post("/api/energy/topologies/generate/multi", json=data)
    assert r.status_code == 200 and r.json()["created_count"] == 4
    ids = r.json()["created_topology_ids"]
    assert len(set(ids)) == 4
    seeds = [client.get(f"/api/energy/topologies/{i}/detail").json()["seed"] for i in ids]
    assert len(set(seeds)) == 4
    client.post(f"/api/energy/batches/{batch}/lock")
    assert client.post("/api/energy/topologies/generate", json=config(batch_id=batch)).status_code == 409
    assert client.delete(f"/api/energy/topologies/{ids[0]}").status_code == 409
    client.post(f"/api/energy/batches/{batch}/unlock")
    data.update(space_width=1, space_height=1, node_counts=[2,10])
    assert client.post("/api/energy/topologies/generate/multi", json=data).status_code == 400
    batches = client.get("/api/energy/batches").json()
    assert len(next(b for b in batches if b["batch_id"] == batch)["topologies"]) == 4
    assert client.delete(f"/api/energy/topologies/{ids[0]}").status_code == 200
    assert client.get(f"/api/energy/topologies/{ids[0]}/nodes").status_code == 404
    assert client.delete(f"/api/energy/batches/{batch}").status_code == 200
    assert client.get(f"/api/energy/topologies/{ids[1]}/nodes").status_code == 404

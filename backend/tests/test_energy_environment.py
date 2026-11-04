from copy import deepcopy
import pytest
from app.services.energy_environment import EnergyEnvironment

def topology():
    points=[(10,50),(20,40),(20,60),(30,50),(40,40),(40,60),(50,50),(60,40),(60,60),(70,50)]
    return dict(space_width=80,space_height=80,tx_range=15,demo_scenario=True,
        energy_defaults=dict(capacity=12,tx_cost=4,rx_cost=2,harvest_min=2,harvest_max=6),
        nodes=[dict(node_id=i,x=x,y=y,harvest_rate=None if i==0 else 2+i%5) for i,(x,y) in enumerate(points)])

def test_demo():
    topo=topology(); original=deepcopy(topo)
    replay=run_test_schedule(topo); steps=replay["steps"]
    assert steps[0]["rx"]==[] and len(steps[0]["skipped"])==2
    assert steps[0]["after"]["energy"][1]==3
    assert steps[1]["new_received"]==[1,2]
    assert steps[2]["collisions"]==[3] and steps[2]["new_received"]==[]
    assert steps[2]["after_activity"][3]==steps[2]["before"]["energy"][3]-2
    assert steps[3]["new_received"]==[3]
    assert replay["final"]["completed"] and replay["final"]["slot"]<100
    assert topo==original
    assert replay==run_test_schedule(topo)
    for step in steps:
        for node,e in step["after"]["energy"].items():
            assert 0<=e<=12
            assert e==step["after_activity"][node]+step["harvested"][node]

def test_wait_timeout_and_overflow():
    env=EnergyEnvironment(topology())
    for _ in range(100): result=env.step()
    assert result["after"]["truncated"]
    assert all(e==12 for e in env.energy.values())
    assert sum(result["overflow"].values())>0
    with pytest.raises(ValueError): env.step()
    assert env.reset()["slot"]==0

def test_conflict_unknown_and_no_packet():
    env=EnergyEnvironment(topology())
    before=env.snapshot()
    with pytest.raises(ValueError): env.step([99],[])
    assert env.snapshot()==before
    result=env.step([1],[1,9])
    assert len(result["skipped"])==3 and result["after"]["slot"]==1
    env.step()
    result=env.step([], [9])
    assert result["no_signal"]==[9]
    assert result["after_activity"][9]==result["before"]["energy"][9]-2


def run_test_schedule(topology):
    env = EnergyEnvironment(topology)
    initial = env.snapshot()
    steps = []
    def take(tx, rx, label):
        result = env.step(tx, rx)
        result["label"] = label
        steps.append(result)
    if topology.get("demo_scenario"):
        take([0], [1,2], "RX thiếu năng lượng: bỏ nghe, vẫn harvest")
        take([0], [1,2], "Một nguồn broadcast tới hai sensor")
        take([1,2], [3], "Hai Tx cùng tới node 3: collision, RX vẫn mất năng lượng")
        take([2], [3], "Một Tx truyền lại: node 3 nhận thành công")
    while not env.snapshot()["completed"] and env.slot < 100:
        pending = set(env.nodes)-env.received.keys()
        choices = []
        for i in env.received:
            if i != 0 and env.energy[i] < env.config["tx_cost"]: continue
            receivers = sorted(j for j in env.neighbors[i] & pending if env.energy[j] >= env.config["rx_cost"])
            if receivers: choices.append((i, receivers))
        if choices:
            sender, receivers = max(choices, key=lambda item: len(item[1]))
            take([sender], receivers, "Truyền tiếp tới các node chưa nhận")
        else: take([], [], "Chờ thu năng lượng")
    return dict(initial=initial, steps=steps, final=env.snapshot(), max_slots=100)


def test_energy_spread_preview_and_commit():
    from app.services.energy_environment import playground_energy
    topo = topology()
    initial = deepcopy(topo)
    with pytest.raises(ValueError): playground_energy(topo, [], 0)
    assert topo == initial
    assert playground_energy(topo, [None], 0) == playground_energy(topo, [None], 0)
    waited = playground_energy(topo, [], None)
    assert waited["energyResult"]["after"]["slot"] == 1
    next_slot = playground_energy(topo, [None], 0)
    assert next_slot["receivers"] == [1, 2]
    assert next_slot["energyResult"]["after"]["energy"][1] == 4
    with pytest.raises(ValueError): playground_energy(topo, [], 1)


def test_playground_energy_overrides():
    from app.services.energy_environment import playground_energy
    topo = topology()
    original = deepcopy(topo)
    result = playground_energy(topo, [None], 0, dict(capacity=6, tx_cost=4, rx_cost=4))
    assert result["blocked"] == [1]
    assert result["receivers"] == [2]
    assert result["energyResult"]["after"]["energy"][2] == 4
    assert max(result["energyResult"]["after"]["energy"].values()) <= 6
    assert topo == original
    with pytest.raises(ValueError):
        playground_energy(topo, [], None, dict(capacity=1, tx_cost=4, rx_cost=2))


def spread_fixture():
    env = EnergyEnvironment(topology())
    env.received = {0:0, 1:1, 2:1}
    env.energy = {i:12.0 for i in range(1,10)}
    env.neighbors = {i:set() for i in range(10)}
    def connect(tx, receivers):
        for rx in receivers:
            env.neighbors[tx].add(rx)
            env.neighbors[rx].add(tx)
    return env, connect


def test_shared_unpowered_receiver_does_not_block_parallel_tx():
    from app.services.energy_environment import spread_energy_slot
    env, connect = spread_fixture()
    connect(0,[3,4]); connect(1,[4,5]); connect(2,[6])
    env.energy[4]=0
    env.energy[6]=0  # TX 2 has energy, but nobody can receive from it.
    result, blocked = spread_energy_slot(env,0)
    assert result["tx"] == [0,1]
    assert result["rx"] == [3,5]
    assert result["new_received"] == [3,5]
    assert result["collisions"] == []
    assert blocked == [4]
    assert result["after_activity"][2] == result["before"]["energy"][2]


def test_spread_ranks_ready_receivers_and_respects_first_pick():
    from app.services.energy_environment import spread_energy_slot
    env, connect = spread_fixture()
    connect(0,[3]); connect(1,[4,5,6]); connect(2,[4,7])
    env.energy[5]=env.energy[6]=0
    result, _ = spread_energy_slot(env,0)
    assert result["tx"] == [0,2]  # 2 ready beats 1 ready, despite fewer total neighbors.
    assert result["new_received"] == [3,4,7]
    assert result["collisions"] == []
    env.reset()
    env.received={0:0,1:1,2:1}
    env.energy={i:12.0 for i in range(1,10)}
    env.energy[5]=env.energy[6]=0
    result, _ = spread_energy_slot(env,1)
    assert result["tx"] == [0,1]  # Explicit first pick wins; conflicting TX 2 is excluded.
    assert result["collisions"] == []


@pytest.mark.parametrize("rates,counts,energies,winner", [
    ((6, 3), (1, 2), (8, 12), 1),  # Harvest rate precedes coverage and stored energy.
    ((4, 4), (1, 2), (12, 8), 2),  # Coverage precedes stored energy.
    ((4, 4), (2, 2), (8, 12), 2),  # Stored energy breaks equal rate/coverage.
    ((4, 4), (2, 2), (12, 12), 1), # ID is the last tie-breaker.
])
def test_energy_spread_priority(rates, counts, energies, winner):
    from app.services.energy_environment import spread_energy_slot
    env, connect = spread_fixture()
    connect(0, [3])
    connect(1, [4, 5][:counts[0]])
    connect(2, [4, 6][:counts[1]])
    for i, rate, energy in zip((1, 2), rates, energies):
        env.nodes[i]["harvest_rate"] = rate
        env.energy[i] = energy
    result, _ = spread_energy_slot(env, 0, "energy")
    assert result["tx"] == [0, winner]
    assert result["collisions"] == []


def test_energy_spread_first_pick_source_and_eligibility():
    from app.services.energy_environment import spread_energy_slot
    env, connect = spread_fixture()
    connect(0, [3]); connect(1, [3, 4]); connect(2, [5])
    result, _ = spread_energy_slot(env, 2, "energy")
    assert result["tx"] == [0, 2]  # Unlimited source wins the remaining conflict.

    env, connect = spread_fixture()
    connect(0, [3]); connect(1, [3, 4]); connect(2, [5])
    result, _ = spread_energy_slot(env, 1, "energy")
    assert result["tx"] == [1, 2]  # Explicit first pick even precedes the source.
    assert result["collisions"] == []

    env, connect = spread_fixture()
    connect(0, [3]); connect(1, [4]); connect(2, [5])
    env.energy[1] = 0
    env.energy[5] = 0
    result, _ = spread_energy_slot(env, 0, "energy")
    assert result["tx"] == [0]
    assert result["rx"] == [3]
    with pytest.raises(ValueError, match="Unsupported"):
        spread_energy_slot(env, None, "invalid")


def test_energy_spread_mixed_history_matches_direct_execution():
    from app.services.energy_environment import spread_energy_slot, playground_energy
    topo = topology()
    env = EnergyEnvironment(topo)
    actions = []
    for first_pick, mode in [(None, "energy"), (0, "normal"), (1, "energy")]:
        expected, blocked = spread_energy_slot(env, first_pick, mode)
        actual = playground_energy(topo, actions, first_pick, spread_mode=mode)
        assert actual["energyResult"] == expected
        assert actual["blocked"] == blocked
        assert actual["spreadMode"] == mode
        actions.append(dict(first_pick=first_pick, spread_mode=mode))

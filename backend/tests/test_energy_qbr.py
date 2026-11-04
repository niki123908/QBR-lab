from copy import deepcopy
import pytest
from test_energy_environment import topology
from app.services.energy_environment import EnergyEnvironment
from app.services.runners.energy_qbr_runner import (
    EnergyRunConfig, frontier_state, action_candidates, update_q, slot_reward,
    train_energy_qbr, WAIT, resolve_topology,
)


def test_frontier_three_levels_and_actions():
    env=EnergyEnvironment(topology())
    assert frontier_state(env)==((0,1),)
    assert action_candidates(frontier_state(env))==[WAIT]
    env.energy[1]=2
    assert frontier_state(env)==((0,2),)
    env.received={0:0,1:1,2:1}
    env.energy[1]=0; env.energy[2]=4
    assert frontier_state(env)==((1,0),(2,1))
    env.energy[3]=2
    assert frontier_state(env)==((1,0),(2,2))
    assert action_candidates(frontier_state(env))==[2,WAIT]


def test_update_masks_actions_and_terminal_bootstrap():
    q={"s":{}, "next":{99:1000, WAIT:-2}}
    assert update_q(q,"s",0,1,"next",[WAIT],False,1,0.5)==(0,0)
    q["next"][WAIT]=100
    assert update_q(q,"s",0,-1,"next",[WAIT],True,1,0.5)==(0,-1)


def test_reward_normalized_bonus_and_wait():
    cfg=EnergyRunConfig(reward_scale=2,slot_cost=0.5,completion_bonus_mode="fixed",completion_bonus=7)
    assert slot_reward({"new_received":[1,2],"after":{"completed":False}},cfg,5)==0.5
    assert slot_reward({"new_received":[],"after":{"completed":False}},cfg,5)==-0.5
    assert slot_reward({"new_received":[1],"after":{"completed":True}},cfg,5)==7
    cfg.completion_bonus_mode="node_count"
    assert slot_reward({"new_received":[1],"after":{"completed":True}},cfg,5)==5


@pytest.mark.parametrize("spread",["normal","energy"])
def test_training_and_playground_replay_agree(spread):
    from app.services.energy_environment import playground_energy
    graph=topology(); original=deepcopy(graph)
    cfg=dict(episodes=12,run_seed=42,spread_mode=spread)
    result=train_energy_qbr(graph,cfg)
    repeat=train_energy_qbr(graph,cfg)
    assert result["qtable"]==repeat["qtable"]
    assert result["episodes"]==repeat["episodes"]
    assert graph==original
    assert result["best"] is not None
    assert result["best"]["delay"]==min(e["delay"] for e in result["episodes"] if e["completed"])
    history=[]
    for step in result["best"]["steps"]:
        actual=playground_energy(graph,history,step["firstPick"],spread_mode=spread)
        assert actual["energyResult"]==step["energyResult"]
        history.append(dict(first_pick=step["firstPick"],spread_mode=spread))
    assert result["last"]["steps"][0]["energyResult"]["before"]["energy"]=={i:0 for i in range(1,10)}


def test_empty_frontier_is_not_success_and_limit_is_terminal():
    graph=topology(); graph["tx_range"]=0
    result=train_energy_qbr(graph,dict(episodes=1,run_seed=2))
    assert result["best"] is None
    assert result["last"]["slots"]==100
    assert result["last"]["truncated"]
    assert result["last"]["delay"] is None
    assert all(s["action"]=="WAIT" for s in result["last"]["steps"])
    final=result["last"]["steps"][-1]
    assert final["q_after"]==pytest.approx(final["q_before"]+0.2*(-1-final["q_before"]))


def test_run_cost_override_and_validation():
    graph=topology()
    resolved=resolve_topology(graph,EnergyRunConfig(capacity=20,rx_cost=3))
    assert resolved["energy_defaults"]["capacity"]==20
    assert resolved["energy_defaults"]["rx_cost"]==3
    assert graph["energy_defaults"]["capacity"]==12
    with pytest.raises(ValueError): resolve_topology(graph,EnergyRunConfig(capacity=1))
    with pytest.raises(ValueError): EnergyRunConfig(slot_cost=0)
    with pytest.raises(ValueError): EnergyRunConfig(epsilon_start=0.1,epsilon_end=0.9)
    with pytest.raises(ValueError): EnergyRunConfig(spread_mode="la")

from test_energy_environment import topology, spread_fixture
from app.services.runners.energy_greedy_runner import run_energy_greedy, pick_greedy_first
from app.services.energy_environment import playground_energy


def test_first_pick_coverage_eligibility_tie():
    env, connect = spread_fixture()
    connect(0,[3]); connect(1,[4,5]); connect(2,[6,7])
    assert pick_greedy_first(env)==1
    env.energy[1]=0
    assert pick_greedy_first(env)==2
    env.energy[6]=env.energy[7]=0
    assert pick_greedy_first(env)==0
    env.energy[3]=0
    assert pick_greedy_first(env) is None


def test_greedy_trace_matches_playground():
    for mode in ["normal","energy"]:
        graph=topology()
        result=run_energy_greedy(graph,{"spread_mode":mode})
        assert result["best"]["completed"]
        assert len(result["episodes"])==1
        assert "qtable" not in result
        actions=[]
        for step in result["last"]["steps"]:
            actual=playground_energy(graph,actions,step["firstPick"],spread_mode=mode)
            assert actual["energyResult"]==step["energyResult"]
            actions.append({"first_pick":step["firstPick"],"spread_mode":mode})


def test_timeout_and_overrides():
    result=run_energy_greedy(topology(),{"capacity":100000,"rx_cost":100000})
    assert result["last"]["truncated"] and result["last"]["slots"]==100
    assert result["best"] is None
    assert all(step["action"]=="WAIT" for step in result["last"]["steps"])

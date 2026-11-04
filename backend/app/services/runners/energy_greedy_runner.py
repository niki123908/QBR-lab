"""Deterministic coverage-first baseline; no Q-table or exploration."""
import time
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal
from app.services.energy_environment import EnergyEnvironment, spread_energy_slot
from app.services.runners.energy_qbr_runner import resolve_topology, frontier_state, action_candidates, WAIT

class EnergyGreedyConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    spread_mode: Literal["normal", "energy"] = "normal"
    capacity: float | None = Field(default=None, gt=0)
    tx_cost: float | None = Field(default=None, gt=0)
    rx_cost: float | None = Field(default=None, gt=0)
    run_seed: int | None = Field(default=None, ge=0)


def pick_greedy_first(env):
    candidates = [i for i in action_candidates(frontier_state(env)) if i != WAIT]
    ready = {i for i in env.nodes if i not in env.received and env.energy[i] >= env.config["rx_cost"]}
    return min(candidates, key=lambda i: (-len(env.neighbors[i] & ready), i)) if candidates else None


def run_energy_greedy(topology, config=None, progress=None):
    config = config if isinstance(config, EnergyGreedyConfig) else EnergyGreedyConfig(**(config or {}))
    started = time.monotonic()
    graph = resolve_topology(topology, config)
    env = EnergyEnvironment(graph)
    steps = []
    while True:
        first_pick = pick_greedy_first(env)
        state = frontier_state(env)
        result, blocked = spread_energy_slot(env, first_pick, config.spread_mode)
        steps.append(dict(time=env.slot, timeslot=env.slot, state=state, action="WAIT" if first_pick is None else first_pick,
            firstPick=first_pick, spreadMode=config.spread_mode, transmitters=result["tx"], receivers=result["new_received"],
            br_set=result["tx"], rcv_set=result["new_received"], blocked=blocked, energyResult=result))
        if progress: progress(0)
        if result["after"]["completed"] or result["after"]["truncated"]: break
    completed = env.snapshot()["completed"]
    episode = dict(episode=1, delay=env.slot if completed else None, slots=env.slot, completed=completed,
        truncated=not completed, total_reward=0, steps=steps)
    if progress: progress(1)
    return dict(config=config.model_dump(), resolved_energy=graph["energy_defaults"],
        episodes=[{k:v for k,v in episode.items() if k!="steps"}], last=episode, best=episode if completed else None,
        runtime_sec=time.monotonic()-started, total_states=None, total_state_actions=None)

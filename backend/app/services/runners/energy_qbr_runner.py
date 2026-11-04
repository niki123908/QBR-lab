"""Energy QBR: tabular Q-learning, frontier ternary state, no aggregation/traces."""
from copy import deepcopy
import json
import random
import time
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.energy_schemas import EnergyDefaults
from app.services.energy_environment import EnergyEnvironment, spread_energy_slot

WAIT = -1

class EnergyRunConfig(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    episodes: int = Field(default=1000, ge=1, le=100000)
    alpha: float = Field(default=0.2, gt=0, le=1, title="Learning rate")
    gamma: float = Field(default=0.8, ge=0, le=1)
    epsilon_start: float = Field(default=1, ge=0, le=1)
    epsilon_end: float = Field(default=0.01, ge=0, le=1)
    epsilon_decay: float = Field(default=0.001, ge=0)
    spread_mode: Literal["normal", "energy"] = "normal"
    reward_scale: float = Field(default=1, ge=0, title="Receiver reward weight (Î±)")
    slot_cost: float = Field(default=1, gt=0, title="Cost per slot (c)")
    completion_bonus_mode: Literal["fixed", "node_count"] = "node_count"
    completion_bonus: float = Field(default=10, ge=0, title="Fixed completion bonus (B)")
    capacity: float | None = Field(default=None, gt=0, title="Max E (blank: topology default)")
    tx_cost: float | None = Field(default=None, gt=0, title="TX energy (blank: topology default)")
    rx_cost: float | None = Field(default=None, gt=0, title="RX energy (blank: topology default)")
    run_seed: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def valid_schedule(self):
        if self.epsilon_end > self.epsilon_start:
            raise ValueError("Epsilon end must not exceed epsilon start.")
        return self


def resolve_topology(topology, config):
    graph = deepcopy(topology)
    overrides = {k: getattr(config, k) for k in ("capacity", "tx_cost", "rx_cost") if getattr(config, k) is not None}
    graph["energy_defaults"] = EnergyDefaults(**{**graph["energy_defaults"], **overrides}).model_dump()
    return graph


def frontier_state(env):
    uncovered = set(env.nodes) - env.received.keys()
    ready = {i for i in uncovered if env.energy[i] >= env.config["rx_cost"]}
    state = []
    for i in sorted(env.received):
        if not env.neighbors[i] & uncovered:
            continue
        level = 0 if i != 0 and env.energy[i] < env.config["tx_cost"] else (2 if env.neighbors[i] & ready else 1)
        state.append((i, level))
    return tuple(state)


def state_key(state):
    return json.dumps(state, separators=(",", ":"))


def action_candidates(state):
    # WAIT last gives deterministic node-first tie breaking, without excluding WAIT.
    return [i for i, level in state if level == 2] + [WAIT]


def slot_reward(result, config, node_count):
    bonus = node_count if config.completion_bonus_mode == "node_count" else config.completion_bonus
    return config.reward_scale * len(result["new_received"]) / (node_count - 1) - config.slot_cost + (bonus if result["after"]["completed"] else 0)


def update_q(qtable, state, action, reward, next_state, candidates, terminal, alpha, gamma):
    row = qtable.setdefault(state, {})
    previous = row.get(action, 0.0)
    future = 0.0 if terminal else max(qtable.get(next_state, {}).get(a, 0.0) for a in candidates)
    row[action] = previous + alpha * (reward + gamma * future - previous)
    return previous, row[action]


def train_energy_qbr(topology, config=None, progress=None):
    config = config if isinstance(config, EnergyRunConfig) else EnergyRunConfig(**(config or {}))
    graph = resolve_topology(topology, config)
    env = EnergyEnvironment(graph)
    rng = random.Random(config.run_seed)
    qtable, episodes = {}, []
    best = None
    last = None
    started = time.monotonic()
    last_progress = started
    for episode in range(1, config.episodes + 1):
        env.reset()
        steps, total_reward = [], 0.0
        epsilon = max(config.epsilon_end, config.epsilon_start - config.epsilon_decay * (episode - 1))
        while True:
            state = frontier_state(env)
            key = state_key(state)
            candidates = action_candidates(state)
            action = rng.choice(candidates) if rng.random() < epsilon else max(candidates, key=lambda a: qtable.get(key, {}).get(a, 0.0))
            result, blocked = spread_energy_slot(env, None if action == WAIT else action, config.spread_mode)
            next_state = frontier_state(env)
            terminal = result["after"]["completed"] or result["after"]["truncated"]
            reward = slot_reward(result, config, len(env.nodes))
            before_q, after_q = update_q(qtable, key, action, reward, state_key(next_state), action_candidates(next_state), terminal, config.alpha, config.gamma)
            total_reward += reward
            steps.append(dict(time=env.slot, timeslot=env.slot, state=state, state_hash=key,
                next_state=next_state, action="WAIT" if action == WAIT else action,
                firstPick=None if action == WAIT else action, spreadMode=config.spread_mode,
                action_candidates=candidates, reward=reward, q_before=before_q, q_after=after_q,
                transmitters=result["tx"], receivers=result["new_received"], br_set=result["tx"],
                rcv_set=result["new_received"], blocked=blocked, energyResult=result))
            now = time.monotonic()
            if progress and now - last_progress >= 2:
                progress(episode - 1)
                last_progress = now
            if terminal:
                break
        completed = env.snapshot()["completed"]
        last = dict(episode=episode, delay=env.slot if completed else None, slots=env.slot,
                    completed=completed, truncated=not completed, total_reward=total_reward, steps=steps)
        episodes.append({k: v for k, v in last.items() if k != "steps"} | {"epsilon": epsilon})
        if completed and (best is None or env.slot < best["delay"]):
            best = last
    if progress:
        progress(config.episodes)
    return dict(config=config.model_dump(), resolved_energy=graph["energy_defaults"],
                episodes=episodes, best=best, last=last, qtable=qtable,
                total_states=len(qtable), total_state_actions=sum(len(v) for v in qtable.values()),
                runtime_sec=time.monotonic()-started)

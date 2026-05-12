from __future__ import annotations

import math
import time
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from app.algorithms.br_env import Br_Env


class StateEncoder(Protocol):
    def encode_from_env(self, env: Br_Env) -> str: ...

    def encode_state(self, state: list[int]) -> str: ...


class ActionPolicy(Protocol):
    def select_action(
        self, env: Br_Env, qtable: dict[str, dict[int, float]], state_hash: str, episode: int
    ) -> int | tuple[int, int]: ...

    def episode_trace_row(self, episode: int) -> list[Any] | None: ...


class LearnerUpdateRule(Protocol):
    def update(
        self,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        action: int,
        reward: float,
        next_state_hash: str,
        alpha: float,
        gamma: float,
    ) -> tuple[float, float]: ...


class CandidateFinder(Protocol):
    def find(self, env: Br_Env) -> bool: ...


@dataclass
class TrainingResult:
    qtable: dict[str, dict[int, float]]
    qtable_all_epochs: list[dict[str, Any]]
    total_rewards: list[float]
    episodes_steps: list[dict[str, Any]]
    policy_rows: list[list[Any]]
    best_delay: float
    best_episode_index: int
    qtable_snapshots_by_episode: dict[int, dict[str, dict[int, float]]]


def train_with_template(
    env: Br_Env,
    episodes: int,
    timeout_sec: int,
    alpha: float,
    gamma: float,
    state_encoder: StateEncoder,
    action_policy: ActionPolicy,
    update_rule: LearnerUpdateRule,
    candidate_finder: CandidateFinder,
    on_episode_start: Callable[[Br_Env], None] | None = None,
    export_q_table_all_epoch: bool = False,
    completion_bonus_multiplier: float = 1.0,
    lambda_param: float = 0.0,
    trace_threshold: float = 0.01,
    action_axis: str = "broadcaster",
    q_snapshot_episodes: set[int] | None = None,
) -> TrainingResult:
    qtable: dict[str, dict[int, float]] = {}
    qtable_all_epochs: list[dict[str, Any]] = []
    total_rewards: list[float] = []
    episodes_steps: list[dict[str, Any]] = []
    state_id_mapping: dict[str, int] = {}
    state_id_counter = 1
    best_delay = math.inf
    best_episode_index = -1
    policy_rows: list[list[Any]] = []
    eligibility_traces: dict[str, dict[int, float]] = {}
    qtable_snapshots_by_episode: dict[int, dict[str, dict[int, float]]] = {}
    started = time.monotonic()
    for episode_idx in range(episodes):
        episode = episode_idx + 1
        if (time.monotonic() - started) > timeout_sec:
            raise TimeoutError("Failed.")

        done = env.reset()
        env.cur_time = 0
        eligibility_traces.clear()
        if on_episode_start is not None:
            on_episode_start(env)
        total_reward = 0.0
        step_rows: list[dict[str, Any]] = []

        while not done:
            if (time.monotonic() - started) > timeout_sec:
                raise TimeoutError("Failed.")

            env.cur_time += 1
            has_candidates = candidate_finder.find(env)
            if not has_candidates:
                continue

            br_candidate_count = int(len(env.br_cands))
            rcv_candidate_count = int(len(env.rcv_cands))
            action_candidate_count = rcv_candidate_count if str(action_axis) == "receiver" else br_candidate_count
            action_candidates = (
                sorted(list(env.rcv_cands)) if str(action_axis) == "receiver" else sorted(list(env.br_cands))
            )

            state_hash = state_encoder.encode_from_env(env)
            if state_hash not in qtable:
                qtable[state_hash] = {}

            selected = action_policy.select_action(env, qtable, state_hash, episode)
            if isinstance(selected, tuple):
                action, env_action = int(selected[0]), int(selected[1])
            else:
                action, env_action = int(selected), int(selected)
            if action not in qtable[state_hash]:
                qtable[state_hash][action] = 0.0

            next_state, reward, done, br_set, rcv_set = env.proceed_action(
                env_action,
                completion_bonus_multiplier=completion_bonus_multiplier,
                action_axis=action_axis,
            )
            next_state = list(set(next_state))
            next_state_hash = state_encoder.encode_state(next_state)

            if state_hash not in state_id_mapping:
                state_id_mapping[state_hash] = state_id_counter
                state_id_counter += 1
            if next_state_hash not in state_id_mapping:
                state_id_mapping[next_state_hash] = state_id_counter
                state_id_counter += 1

            q_before = float(qtable[state_hash][action])
            if lambda_param > 0.0:
                max_next_q = 0.0
                if next_state_hash in qtable and qtable[next_state_hash]:
                    max_next_q = max(qtable[next_state_hash].values())
                td_error = float(reward) + float(gamma) * float(max_next_q) - float(qtable[state_hash][action])

                # Decay all existing traces first, then add current state-action trace.
                for tr_state in list(eligibility_traces.keys()):
                    state_traces = eligibility_traces[tr_state]
                    for tr_action in list(state_traces.keys()):
                        state_traces[tr_action] = float(state_traces[tr_action]) * float(gamma) * float(lambda_param)
                        if state_traces[tr_action] < trace_threshold:
                            del state_traces[tr_action]
                    if not state_traces:
                        del eligibility_traces[tr_state]

                state_traces = eligibility_traces.setdefault(state_hash, {})
                # Use replacing traces to avoid uncontrolled trace growth on repeated (s, a) visits.
                state_traces[action] = 1.0

                for tr_state, tr_actions in eligibility_traces.items():
                    qtable.setdefault(tr_state, {})
                    for tr_action, trace_value in tr_actions.items():
                        old_q = float(qtable[tr_state].get(tr_action, 0.0))
                        qtable[tr_state][tr_action] = old_q + float(alpha) * td_error * float(trace_value)

                q_after = float(qtable[state_hash][action])
            else:
                q_before, q_after = update_rule.update(
                    qtable=qtable,
                    state_hash=state_hash,
                    action=action,
                    reward=reward,
                    next_state_hash=next_state_hash,
                    alpha=alpha,
                    gamma=gamma,
                )

            step_rows.append(
                {
                    "time": env.cur_time,
                    "state_id": state_id_mapping[state_hash],
                    "next_state_id": state_id_mapping[next_state_hash],
                    "state_hash": state_hash,
                    "next_state_hash": next_state_hash,
                    "action": action,
                    "env_action": env_action,
                    "br_candidate_count": br_candidate_count,
                    "rcv_candidate_count": rcv_candidate_count,
                    "action_candidate_count": int(action_candidate_count),
                    "action_candidates": [int(x) for x in action_candidates],
                    "reward": float(reward),
                    "q_before": float(q_before),
                    "q_after": float(q_after),
                    "rcv_set": sorted(list(set(rcv_set))),
                    "br_set": sorted(list(set(br_set))),
                }
            )

            env.V_s = next_state
            total_reward += reward

        total_rewards.append(float(total_reward))
        policy_row = action_policy.episode_trace_row(episode)
        if policy_row is not None:
            policy_rows.append(policy_row)
        episodes_steps.append(
            {
                "episode": episode,
                "delay": int(env.cur_time),
                "total_reward": float(total_reward),
                "steps": step_rows,
            }
        )

        if env.cur_time < best_delay:
            best_delay = env.cur_time
            best_episode_index = episode_idx
        if q_snapshot_episodes and episode in q_snapshot_episodes:
            qtable_snapshots_by_episode[episode] = deepcopy(qtable)
        if export_q_table_all_epoch:
            qtable_all_epochs.append({"episode": episode, "q_table": deepcopy(qtable)})

    return TrainingResult(
        qtable=qtable,
        qtable_all_epochs=qtable_all_epochs,
        total_rewards=total_rewards,
        episodes_steps=episodes_steps,
        policy_rows=policy_rows,
        best_delay=best_delay,
        best_episode_index=best_episode_index,
        qtable_snapshots_by_episode=qtable_snapshots_by_episode,
    )

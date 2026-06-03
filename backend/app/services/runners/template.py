from __future__ import annotations

import math
import time
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from app.algorithms.br_env import Br_Env
from app.services.runners.action_aggregation import (
    AGGREGATION_MODE_OFF,
    ActionGroup,
    IncrementalActionRegistry,
    ObservedMergeResult,
    StateActionRegistry,
    is_exact_next_state_aggregation,
    is_incremental_merge_aggregation,
)


class StateEncoder(Protocol):
    def encode_from_env(self, env: Br_Env) -> str: ...

    def encode_state(self, state: list[int]) -> str: ...


class ActionPolicy(Protocol):
    def select_action(
        self,
        env: Br_Env,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        episode: int,
        q_action_key_fn: Callable[[int], int] | None = ...,
    ) -> int | tuple[int, int]: ...

    def select_group(
        self,
        env: Br_Env,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        groups: list[ActionGroup],
        episode: int,
    ) -> tuple[int, int]: ...

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
    coverage_reward_enabled: bool = True,
    lambda_param: float = 0.0,
    trace_threshold: float = 0.01,
    action_axis: str = "broadcaster",
    action_aggregation_mode: str = AGGREGATION_MODE_OFF,
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
    use_exact_aggregation = is_exact_next_state_aggregation(action_aggregation_mode)
    use_incremental_aggregation = is_incremental_merge_aggregation(action_aggregation_mode)
    exact_registry = StateActionRegistry() if use_exact_aggregation else None
    incremental_registry = IncrementalActionRegistry() if use_incremental_aggregation else None
    started = time.monotonic()
    for episode_idx in range(episodes):
        episode = episode_idx + 1
        if (time.monotonic() - started) > timeout_sec:
            raise TimeoutError(f"Training exceeded {timeout_sec}s wall-clock limit.")

        done = env.reset()
        env.cur_time = 0
        eligibility_traces.clear()
        if on_episode_start is not None:
            on_episode_start(env)
        total_reward = 0.0
        step_rows: list[dict[str, Any]] = []

        while not done:
            if (time.monotonic() - started) > timeout_sec:
                raise TimeoutError(f"Training exceeded {timeout_sec}s wall-clock limit.")

            env.cur_time += 1
            has_candidates = candidate_finder.find(env)
            if not has_candidates:
                # Avoid spinning cur_time until timeout when the frontier is empty but V_ns is not.
                if len(env.V_ns) == 0:
                    done = True
                else:
                    done = True
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

            selected_group = None
            groups_at_step: list[ActionGroup] = []
            merge_result: ObservedMergeResult | None = None
            filtered_candidates = action_candidates

            if use_incremental_aggregation and incremental_registry is not None:
                q_action_key_fn = lambda candidate_id, sh=state_hash: incremental_registry.q_action_key(
                    sh, candidate_id
                )
                selected = action_policy.select_action(
                    env, qtable, state_hash, episode, q_action_key_fn=q_action_key_fn
                )
                if isinstance(selected, tuple):
                    action, env_action = int(selected[0]), int(selected[1])
                else:
                    action, env_action = int(selected), int(selected)
            elif use_exact_aggregation and exact_registry is not None:
                groups_at_step = exact_registry.get_or_build_groups(
                    env,
                    state_hash,
                    action_candidates,
                    encode_state=state_encoder.encode_state,
                    action_axis=action_axis,
                    completion_bonus_multiplier=completion_bonus_multiplier,
                    coverage_reward_enabled=coverage_reward_enabled,
                )
                action, env_action = action_policy.select_group(env, qtable, state_hash, groups_at_step, episode)
                selected_group = exact_registry.group_by_id(state_hash, action)
            else:
                selected = action_policy.select_action(env, qtable, state_hash, episode)
                if isinstance(selected, tuple):
                    action, env_action = int(selected[0]), int(selected[1])
                else:
                    action, env_action = int(selected), int(selected)
            if not use_incremental_aggregation:
                if action not in qtable[state_hash]:
                    qtable[state_hash][action] = 0.0

            next_state, reward, done, br_set, rcv_set = env.proceed_action(
                env_action,
                completion_bonus_multiplier=completion_bonus_multiplier,
                coverage_reward_enabled=coverage_reward_enabled,
                action_axis=action_axis,
            )
            next_state = list(set(next_state))
            next_state_hash = state_encoder.encode_state(next_state)

            if use_incremental_aggregation and incremental_registry is not None:
                merge_result = incremental_registry.register_observed_transition(
                    state_hash,
                    env_action,
                    next_state_hash,
                )
                action = int(merge_result.q_action)
                groups_at_step = incremental_registry.groups_at_state(state_hash)
                selected_group = merge_result.group
                if action not in qtable[state_hash]:
                    qtable[state_hash][action] = 0.0

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

            step_row: dict[str, Any] = {
                "time": env.cur_time,
                "state_id": state_id_mapping[state_hash],
                "next_state_id": state_id_mapping[next_state_hash],
                "state_hash": state_hash,
                "next_state_hash": next_state_hash,
                "action": action,
                "env_action": env_action,
                "br_candidate_count": br_candidate_count,
                "rcv_candidate_count": rcv_candidate_count,
                "action_candidate_count": int(len(filtered_candidates)),
                "action_candidates": [int(x) for x in action_candidates],
                "action_candidates_active": [int(x) for x in filtered_candidates],
                "reward": float(reward),
                "q_before": float(q_before),
                "q_after": float(q_after),
                "rcv_set": sorted(list(set(rcv_set))),
                "br_set": sorted(list(set(br_set))),
            }
            if selected_group is not None:
                step_row["action_aggregated"] = True
                step_row["action_aggregation_mode"] = (
                    "incremental_merge" if use_incremental_aggregation else "exact_next_state"
                )
                step_row["action_group_id"] = int(selected_group.group_id)
                step_row["action_group_members"] = [int(x) for x in selected_group.member_actions]
                step_row["action_group_next_state_hash"] = selected_group.next_state_hash
                step_row["action_groups"] = [
                    {
                        "group_id": int(group.group_id),
                        "member_actions": [int(x) for x in group.member_actions],
                        "next_state_hash": group.next_state_hash,
                    }
                    for group in groups_at_step
                ]
                if merge_result is not None and merge_result.merged:
                    step_row["action_merged_from"] = int(merge_result.env_action)
                    step_row["action_merged_into"] = int(merge_result.q_action)
            else:
                step_row["action_aggregated"] = False

            active_group_count = len(groups_at_step) if groups_at_step else len(filtered_candidates)
            if str(action_axis) == "receiver":
                rcv_group_count = int(active_group_count)
                br_group_count = int(br_candidate_count)
            else:
                br_group_count = int(active_group_count)
                rcv_group_count = int(rcv_candidate_count)
            step_row["action_group_count"] = int(active_group_count)
            step_row["br_group_count"] = br_group_count
            step_row["rcv_group_count"] = rcv_group_count

            step_rows.append(step_row)

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

from __future__ import annotations

import math
from collections.abc import Callable

import numpy as np

from app.algorithms.br_env import Br_Env, hash_state
from app.services.runners.action_aggregation import ActionGroup


def _resolve_q_action_key(action_id: int, q_action_key_fn: Callable[[int], int] | None) -> int:
    return int(q_action_key_fn(action_id)) if q_action_key_fn is not None else int(action_id)


class QbrStateEncoder:
    def encode_from_env(self, env: Br_Env) -> str:
        return hash_state(env.V_s)

    def encode_state(self, state: list[int]) -> str:
        return hash_state(state)


class EpsilonGreedyActionPolicy:
    def __init__(
        self, epsilon_start: float, epsilon_end: float, epsilon_decay: float, action_axis: str = "broadcaster"
    ) -> None:
        self.epsilon_start = float(epsilon_start)
        self.epsilon_end = float(epsilon_end)
        self.epsilon_decay = float(epsilon_decay)
        self.action_axis = str(action_axis)

    def _epsilon_before_episode(self, episode: int) -> float:
        return max(self.epsilon_end, self.epsilon_start - self.epsilon_decay * max(episode - 1, 0))

    def _epsilon_after_episode(self, episode: int) -> float:
        return max(self.epsilon_end, self.epsilon_start - self.epsilon_decay * max(episode, 0))

    def _action_candidates(self, env: Br_Env) -> list[int]:
        return sorted(list(env.rcv_cands if self.action_axis == "receiver" else env.br_cands))

    def select_action(
        self,
        env: Br_Env,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        episode: int,
        q_action_key_fn: Callable[[int], int] | None = None,
    ) -> int | tuple[int, int]:
        epsilon = self._epsilon_before_episode(episode)
        candidates = self._action_candidates(env)
        if not candidates:
            fallback = int(env.random_action())
            return fallback
        state_actions = qtable.get(state_hash, {})
        if np.random.rand() < epsilon:
            action = int(np.random.choice(candidates))
        else:
            action = int(
                max(
                    candidates,
                    key=lambda a: float(state_actions.get(_resolve_q_action_key(a, q_action_key_fn), 0.0)),
                )
            )
        return int(action)

    def select_group(
        self,
        env: Br_Env,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        groups: list[ActionGroup],
        episode: int,
    ) -> tuple[int, int]:
        if not groups:
            fallback = int(env.random_action())
            return fallback, fallback
        epsilon = self._epsilon_before_episode(episode)
        state_actions = qtable.get(state_hash, {})
        if np.random.rand() < epsilon:
            group = groups[int(np.random.choice(len(groups)))]
        else:
            group = max(groups, key=lambda item: float(state_actions.get(item.group_id, 0.0)))
        return int(group.group_id), int(group.representative_action)

    def episode_trace_row(self, episode: int) -> list[float]:
        return [episode, self._epsilon_before_episode(episode), self._epsilon_after_episode(episode)]


class SoftmaxActionPolicy:
    def __init__(
        self,
        temperature_start: float,
        temperature_end: float,
        temperature_decay: float,
        action_axis: str = "broadcaster",
        temperature_decay_mode: str = "linear",
    ) -> None:
        self.temperature_start = float(temperature_start)
        self.temperature_end = float(temperature_end)
        self.temperature_decay = float(temperature_decay)
        self.action_axis = str(action_axis)
        self.temperature_decay_mode = str(temperature_decay_mode)

    def _temperature_before_episode(self, episode: int) -> float:
        idx = max(episode - 1, 0)
        if self.temperature_decay_mode == "multiplicative":
            return max(self.temperature_end, self.temperature_start * (self.temperature_decay**idx))
        return max(self.temperature_end, self.temperature_start - self.temperature_decay * idx)

    def _temperature_after_episode(self, episode: int) -> float:
        idx = max(episode, 0)
        if self.temperature_decay_mode == "multiplicative":
            return max(self.temperature_end, self.temperature_start * (self.temperature_decay**idx))
        return max(self.temperature_end, self.temperature_start - self.temperature_decay * idx)

    def select_action(
        self,
        env: Br_Env,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        episode: int,
        q_action_key_fn: Callable[[int], int] | None = None,
    ) -> int | tuple[int, int]:
        candidates = sorted(list(env.rcv_cands if self.action_axis == "receiver" else env.br_cands))
        if not candidates:
            return int(env.random_action())

        temperature = self._temperature_before_episode(episode)
        state_q = qtable.get(state_hash, {})
        q_values = np.array(
            [float(state_q.get(_resolve_q_action_key(action, q_action_key_fn), 0.0)) for action in candidates],
            dtype=float,
        )

        # Very small temperature behaves like greedy argmax.
        if temperature <= 1e-12:
            max_q = float(np.max(q_values))
            tied = [cand for cand, q in zip(candidates, q_values) if float(q) == max_q]
            return int(min(tied))

        logits = q_values / temperature
        logits = logits - np.max(logits)
        exp_logits = np.exp(logits)
        probs = exp_logits / np.sum(exp_logits)
        picked_idx = int(np.random.choice(len(candidates), p=probs))
        return int(candidates[picked_idx])

    def select_group(
        self,
        env: Br_Env,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        groups: list[ActionGroup],
        episode: int,
    ) -> tuple[int, int]:
        if not groups:
            fallback = int(env.random_action())
            return fallback, fallback

        temperature = self._temperature_before_episode(episode)
        state_q = qtable.get(state_hash, {})
        q_values = np.array([float(state_q.get(group.group_id, 0.0)) for group in groups], dtype=float)

        if temperature <= 1e-12:
            max_q = float(np.max(q_values))
            tied = [group for group, q in zip(groups, q_values) if float(q) == max_q]
            group = min(tied, key=lambda item: item.group_id)
            return int(group.group_id), int(group.representative_action)

        logits = q_values / temperature
        logits = logits - np.max(logits)
        exp_logits = np.exp(logits)
        probs = exp_logits / np.sum(exp_logits)
        picked_idx = int(np.random.choice(len(groups), p=probs))
        group = groups[picked_idx]
        return int(group.group_id), int(group.representative_action)

    def episode_trace_row(self, episode: int) -> list[float]:
        return [episode, self._temperature_before_episode(episode), self._temperature_after_episode(episode)]


class UcbActionPolicy:
    def __init__(self, ucb_c: float, action_axis: str = "broadcaster") -> None:
        self.ucb_c = float(ucb_c)
        self.action_axis = str(action_axis)
        self.visit_counts: dict[str, dict[int, int]] = {}
        self.global_t = 0
        self._current_episode = 0
        self._t_at_episode_start = 0

    def _action_candidates(self, env: Br_Env) -> list[int]:
        return sorted(list(env.rcv_cands if self.action_axis == "receiver" else env.br_cands))

    def _visit_count(self, state_hash: str, action: int) -> int:
        return int(self.visit_counts.get(state_hash, {}).get(action, 0))

    def select_action(
        self,
        env: Br_Env,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        episode: int,
        q_action_key_fn: Callable[[int], int] | None = None,
    ) -> int | tuple[int, int]:
        if episode != self._current_episode:
            self._t_at_episode_start = self.global_t
            self._current_episode = episode

        candidates = self._action_candidates(env)
        if not candidates:
            return int(env.random_action())

        unvisited = [
            action
            for action in candidates
            if self._visit_count(state_hash, _resolve_q_action_key(action, q_action_key_fn)) == 0
        ]
        if unvisited:
            action = int(min(unvisited))
        else:
            state_q = qtable.get(state_hash, {})
            log_t = math.log(max(self.global_t, 1))

            def ucb_score(action: int) -> float:
                q_key = _resolve_q_action_key(action, q_action_key_fn)
                n_sa = self._visit_count(state_hash, q_key)
                q_value = float(state_q.get(q_key, 0.0))
                bonus = self.ucb_c * math.sqrt(log_t / n_sa)
                return q_value + bonus

            action = int(max(candidates, key=ucb_score))

        visit_key = _resolve_q_action_key(action, q_action_key_fn)
        state_visits = self.visit_counts.setdefault(state_hash, {})
        state_visits[visit_key] = int(state_visits.get(visit_key, 0)) + 1
        self.global_t += 1
        return int(action)

    def select_group(
        self,
        env: Br_Env,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        groups: list[ActionGroup],
        episode: int,
    ) -> tuple[int, int]:
        if episode != self._current_episode:
            self._t_at_episode_start = self.global_t
            self._current_episode = episode

        if not groups:
            fallback = int(env.random_action())
            return fallback, fallback

        unvisited = [group for group in groups if self._visit_count(state_hash, group.group_id) == 0]
        if unvisited:
            group = min(unvisited, key=lambda item: item.group_id)
        else:
            state_q = qtable.get(state_hash, {})
            log_t = math.log(max(self.global_t, 1))

            def ucb_score(group: ActionGroup) -> float:
                n_sa = self._visit_count(state_hash, group.group_id)
                q_value = float(state_q.get(group.group_id, 0.0))
                bonus = self.ucb_c * math.sqrt(log_t / n_sa)
                return q_value + bonus

            group = max(groups, key=ucb_score)

        state_visits = self.visit_counts.setdefault(state_hash, {})
        state_visits[group.group_id] = int(state_visits.get(group.group_id, 0)) + 1
        self.global_t += 1
        return int(group.group_id), int(group.representative_action)

    def episode_trace_row(self, episode: int) -> list[float]:
        return [episode, float(self._t_at_episode_start), float(self.global_t)]


class QLearningUpdateRule:
    def update(
        self,
        qtable: dict[str, dict[int, float]],
        state_hash: str,
        action: int,
        reward: float,
        next_state_hash: str,
        alpha: float,
        gamma: float,
    ) -> tuple[float, float]:
        if action not in qtable[state_hash]:
            qtable[state_hash][action] = 0.0

        q_before = qtable[state_hash][action]
        max_next_q = 0.0
        if next_state_hash in qtable and qtable[next_state_hash]:
            max_next_q = max(qtable[next_state_hash].values())

        td_target = reward + gamma * max_next_q
        q_after = q_before + alpha * (td_target - q_before)
        qtable[state_hash][action] = q_after
        return q_before, q_after


class BroadcastCandidateFinder:
    def find(self, env: Br_Env) -> bool:
        env._find_br_rcv_cands()
        return len(env.br_cands) > 0 and len(env.rcv_cands) > 0

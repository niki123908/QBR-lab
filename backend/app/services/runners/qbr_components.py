from __future__ import annotations

import numpy as np

from app.algorithms.br_env import Br_Env, hash_state


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
        self, env: Br_Env, qtable: dict[str, dict[int, float]], state_hash: str, episode: int
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
            action = int(max(candidates, key=lambda a: float(state_actions.get(a, 0.0))))
        return int(action)

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
        self, env: Br_Env, qtable: dict[str, dict[int, float]], state_hash: str, episode: int
    ) -> int | tuple[int, int]:
        candidates = sorted(list(env.rcv_cands if self.action_axis == "receiver" else env.br_cands))
        if not candidates:
            return int(env.random_action())

        temperature = self._temperature_before_episode(episode)
        state_q = qtable.get(state_hash, {})
        q_values = np.array([float(state_q.get(action, 0.0)) for action in candidates], dtype=float)

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

    def episode_trace_row(self, episode: int) -> list[float]:
        return [episode, self._temperature_before_episode(episode), self._temperature_after_episode(episode)]


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

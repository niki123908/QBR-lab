from __future__ import annotations

from app.services.runners.qbr_components import UcbActionPolicy
from app.services.run_registry import resolve_and_validate_run_config


class _FakeEnv:
    def __init__(self, candidates: list[int]) -> None:
        self.br_cands = set(candidates)
        self.rcv_cands = set(candidates)

    def random_action(self) -> int:
        return int(self.br_cands.pop())


def test_ucb_prefers_unvisited_action() -> None:
    policy = UcbActionPolicy(ucb_c=1.414, action_axis="broadcaster")
    env = _FakeEnv([1, 2, 3])
    qtable = {"state_a": {1: 10.0, 2: 0.0, 3: 0.0}}
    policy.visit_counts = {"state_a": {1: 5}}

    action = policy.select_action(env, qtable, "state_a", episode=1)

    assert action == 2
    assert policy.global_t == 1
    assert policy.visit_counts["state_a"][2] == 1


def test_ucb_picks_highest_score_when_all_visited() -> None:
    policy = UcbActionPolicy(ucb_c=1.414, action_axis="broadcaster")
    env = _FakeEnv([1, 2])
    qtable = {"state_a": {1: 0.0, 2: 5.0}}
    policy.visit_counts = {"state_a": {1: 1, 2: 1}}
    policy.global_t = 2

    action = policy.select_action(env, qtable, "state_a", episode=1)

    assert action == 2
    assert policy.global_t == 3


def test_ucb_visit_counts_persist_across_episodes() -> None:
    policy = UcbActionPolicy(ucb_c=1.0, action_axis="broadcaster")
    env = _FakeEnv([1, 2])
    qtable: dict[str, dict[int, float]] = {"state_a": {1: 0.0, 2: 0.0}}

    policy.select_action(env, qtable, "state_a", episode=1)
    policy.select_action(env, qtable, "state_a", episode=2)

    assert policy.global_t == 2
    assert sum(policy.visit_counts["state_a"].values()) == 2


def test_resolve_qbr_config_accepts_ucb_policy() -> None:
    resolved = resolve_and_validate_run_config(
        "qbr",
        "default_v1",
        {"policy_type": "ucb", "ucb_c": 1.414, "episodes": 10},
    )

    assert resolved["policy_type"] == "ucb"
    assert resolved["ucb_c"] == 1.414

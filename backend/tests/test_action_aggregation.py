from __future__ import annotations

from copy import deepcopy

from app.services.runners.action_aggregation import (
    IncrementalActionRegistry,
    StateActionRegistry,
    _probe_next_state_hash,
    is_action_aggregation_enabled,
    is_exact_next_state_aggregation,
    is_incremental_merge_aggregation,
)
from app.services.runners.qbr_components import EpsilonGreedyActionPolicy


class _MockEnv:
    def __init__(self, state: list[int], transitions: dict[int, list[int]]) -> None:
        self.V_s = list(state)
        self.V_ns = [99]
        self.br_cands = sorted(transitions.keys())
        self.rcv_cands = []
        self._transitions = transitions

    def random_action(self) -> int:
        return int(self.br_cands[0])

    def proceed_action(self, first_pick, completion_bonus_multiplier=1.0, coverage_reward_enabled=True, action_axis="broadcaster"):
        _ = completion_bonus_multiplier, coverage_reward_enabled, action_axis
        next_nodes = sorted(set(self.V_s) | set(self._transitions[int(first_pick)]))
        return next_nodes, float(len(self._transitions[int(first_pick)])), False, [int(first_pick)], self._transitions[int(first_pick)]


def _encode_state(state: list[int]) -> str:
    return "/".join(str(v) for v in sorted(state))


def test_is_action_aggregation_enabled() -> None:
    assert is_action_aggregation_enabled("off") is False
    assert is_exact_next_state_aggregation("exact_next_state") is True
    assert is_incremental_merge_aggregation("incremental_merge") is True
    assert is_action_aggregation_enabled("incremental_merge") is True


def test_incremental_merge_keeps_alias_selectable_and_maps_q_key_to_rep() -> None:
    registry = IncrementalActionRegistry()
    first = registry.register_observed_transition("0", 1, "0/2")
    assert first.q_action == 1
    assert first.merged is False
    assert registry.q_action_key("0", 1) == 1
    assert registry.q_action_key("0", 2) == 2

    second = registry.register_observed_transition("0", 2, "0/2")
    assert second.q_action == 1
    assert second.merged is True
    assert registry.q_action_key("0", 2) == 1
    assert registry.q_action_key("0", 3) == 3
    groups = registry.groups_at_state("0")
    assert len(groups) == 1
    assert groups[0].member_actions == [1, 2]


def test_incremental_merge_keeps_distinct_next_states_separate() -> None:
    registry = IncrementalActionRegistry()
    registry.register_observed_transition("0", 1, "0/2")
    registry.register_observed_transition("0", 3, "0/4")
    assert registry.q_action_key("0", 1) == 1
    assert registry.q_action_key("0", 3) == 3
    assert len(registry.groups_at_state("0")) == 2


def test_groups_actions_by_next_state_within_same_source_state() -> None:
    registry = StateActionRegistry()
    env = _MockEnv([0], {1: [2], 2: [2], 3: [4]})
    groups = registry.get_or_build_groups(
        env,
        "0",
        [1, 2, 3],
        encode_state=_encode_state,
        action_axis="broadcaster",
        completion_bonus_multiplier=1.0,
    )
    assert len(groups) == 2
    merged = next(group for group in groups if group.member_actions == [1, 2])
    assert merged.group_id == 1
    assert merged.next_state_hash == "0/2"
    assert merged.representative_action == 1


def test_different_source_states_do_not_share_groups() -> None:
    registry = StateActionRegistry()
    env_a = _MockEnv([0], {1: [2]})
    env_b = _MockEnv([0, 2], {4: [5]})
    groups_a = registry.get_or_build_groups(
        env_a,
        "0",
        [1],
        encode_state=_encode_state,
        action_axis="broadcaster",
        completion_bonus_multiplier=1.0,
    )
    groups_b = registry.get_or_build_groups(
        env_b,
        "0/2",
        [4],
        encode_state=_encode_state,
        action_axis="broadcaster",
        completion_bonus_multiplier=1.0,
    )
    assert len(groups_a) == 1
    assert len(groups_b) == 1
    assert groups_a[0].next_state_hash == "0/2"
    assert groups_b[0].next_state_hash == "0/2/5"
    assert groups_a[0].group_id != groups_b[0].group_id or groups_a[0].member_actions != groups_b[0].member_actions


def test_probe_next_state_hash_restores_v_ns() -> None:
    env = _MockEnv([0], {1: [2], 2: [3]})
    v_ns_before = list(env.V_ns)
    h1 = _probe_next_state_hash(
        env,
        1,
        action_axis="broadcaster",
        completion_bonus_multiplier=1.0,
        encode_state=_encode_state,
    )
    assert env.V_ns == v_ns_before
    h2 = _probe_next_state_hash(
        env,
        2,
        action_axis="broadcaster",
        completion_bonus_multiplier=1.0,
        encode_state=_encode_state,
    )
    assert env.V_ns == v_ns_before
    assert h1 == "0/2"
    assert h2 == "0/3"


def test_registry_reuses_cached_transitions_on_second_visit() -> None:
    registry = StateActionRegistry()
    env = _MockEnv([0], {1: [2], 2: [3]})

    registry.get_or_build_groups(
        env,
        "0",
        [1, 2],
        encode_state=_encode_state,
        action_axis="broadcaster",
        completion_bonus_multiplier=1.0,
    )
    assert len(registry.transition_seen) == 2

    registry.get_or_build_groups(
        env,
        "0",
        [1, 2],
        encode_state=_encode_state,
        action_axis="broadcaster",
        completion_bonus_multiplier=1.0,
    )
    assert len(registry.transition_seen) == 2

    cached = registry.get_or_build_groups(
        env,
        "0",
        [1, 2],
        encode_state=_encode_state,
        action_axis="broadcaster",
        completion_bonus_multiplier=1.0,
    )
    assert len(registry.transition_seen) == 2
    assert cached is registry.groups_by_state["0"]


def test_epsilon_greedy_select_group_returns_group_and_representative() -> None:
    policy = EpsilonGreedyActionPolicy(
        epsilon_start=0.0,
        epsilon_end=0.0,
        epsilon_decay=0.0,
        action_axis="broadcaster",
    )
    from app.services.runners.action_aggregation import ActionGroup

    groups = [
        ActionGroup(group_id=1, next_state_hash="0/2", member_actions=[1, 2]),
        ActionGroup(group_id=3, next_state_hash="0/3", member_actions=[3]),
    ]
    env = _MockEnv([0], {1: [2], 2: [2], 3: [3]})
    qtable = {"0": {1: 5.0, 3: 1.0}}
    group_id, env_action = policy.select_group(env, qtable, "0", groups, episode=1)
    assert group_id == 1
    assert env_action == 1


def test_resolve_qbr_config_accepts_action_aggregation_modes() -> None:
    from app.services.run_registry import resolve_and_validate_run_config

    exact = resolve_and_validate_run_config(
        "qbr",
        "default_v1",
        {"action_aggregation_mode": "exact_next_state", "episodes": 10},
    )
    assert exact["action_aggregation_mode"] == "exact_next_state"

    incremental = resolve_and_validate_run_config(
        "qbr",
        "default_v1",
        {"action_aggregation_mode": "incremental_merge", "episodes": 10},
    )
    assert incremental["action_aggregation_mode"] == "incremental_merge"

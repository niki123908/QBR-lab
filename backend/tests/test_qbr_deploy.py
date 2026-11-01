"""Tests for QBR deploy (greedy rollout from frozen Q-table)."""

from __future__ import annotations

import pytest

from app.algorithms.br_env import Br_Env, hash_state
from app.algorithms.common.node import Node
from app.services.runners.qbr_deploy_runner import _normalize_qtable, _pick_greedy_action
from app.services.runners.action_aggregation import StateActionRegistry
from app.services.runners.qbr_components import QbrStateEncoder


def _tiny_line_nodes() -> list[Node]:
    # 0 -- 1 -- 2
    nodes = [Node(ID=i, x=float(i) * 10, y=0.0, timeslot=1) for i in range(3)]
    for i, j in ((0, 1), (1, 2)):
        nodes[i].neighbors.append(j)
        nodes[j].neighbors.append(i)
    return nodes


def test_normalize_qtable_coerces_string_action_keys():
    raw = {"0": {"1": 3.5, "2": 1.0}, "0/1": {"2": 9.0}}
    q = _normalize_qtable(raw)
    assert q["0"][1] == 3.5
    assert q["0"][2] == 1.0
    assert q["0/1"][2] == 9.0


def test_pick_greedy_unknown_state_raises():
    env = Br_Env(_tiny_line_nodes(), 1)
    env.reset()
    env._find_br_rcv_cands()
    encoder = QbrStateEncoder()
    with pytest.raises(ValueError, match="Unknown state"):
        _pick_greedy_action(
            env=env,
            qtable={},
            state_hash=encoder.encode_from_env(env),
            action_axis="broadcaster",
            spread_mode="normal",
            action_aggregation_mode="off",
            completion_bonus_multiplier=1.0,
            coverage_reward_enabled=True,
            encoder=encoder,
            exact_registry=None,
        )


def test_pick_greedy_argmax_and_tie_break():
    env = Br_Env(_tiny_line_nodes(), 1)
    env.reset()
    env._find_br_rcv_cands()
    encoder = QbrStateEncoder()
    state_hash = encoder.encode_from_env(env)
    candidates = sorted(list(env.br_cands))
    assert candidates, "expected broadcaster candidates"
    # Give highest Q to the largest candidate id; argmax should return it.
    qtable = {state_hash: {int(c): float(c) for c in candidates}}
    best = max(candidates)
    action, qv = _pick_greedy_action(
        env=env,
        qtable=qtable,
        state_hash=state_hash,
        action_axis="broadcaster",
        spread_mode="normal",
        action_aggregation_mode="off",
        completion_bonus_multiplier=1.0,
        coverage_reward_enabled=True,
        encoder=encoder,
        exact_registry=None,
    )
    assert action == best
    assert qv == float(best)


def test_hash_state_stable():
    assert hash_state([0, 2, 1]) == "0/1/2"

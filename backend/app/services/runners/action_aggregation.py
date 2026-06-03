from __future__ import annotations

from dataclasses import dataclass

from collections.abc import Callable

from app.algorithms.br_env import Br_Env


AGGREGATION_MODE_OFF = "off"
AGGREGATION_MODE_EXACT_NEXT_STATE = "exact_next_state"
AGGREGATION_MODE_INCREMENTAL_MERGE = "incremental_merge"


def is_exact_next_state_aggregation(mode: str | None) -> bool:
    return str(mode or AGGREGATION_MODE_OFF).strip() == AGGREGATION_MODE_EXACT_NEXT_STATE


def is_incremental_merge_aggregation(mode: str | None) -> bool:
    return str(mode or AGGREGATION_MODE_OFF).strip() == AGGREGATION_MODE_INCREMENTAL_MERGE


def is_action_aggregation_enabled(mode: str | None) -> bool:
    return is_exact_next_state_aggregation(mode) or is_incremental_merge_aggregation(mode)


@dataclass(frozen=True)
class ActionGroup:
    """group_id is the representative node/action id (min member), not a synthetic index."""

    group_id: int
    next_state_hash: str
    member_actions: list[int]

    @property
    def representative_action(self) -> int:
        return int(self.group_id)


@dataclass(frozen=True)
class ObservedMergeResult:
    q_action: int
    env_action: int
    merged: bool
    group: ActionGroup


def _probe_next_state_hash(
    env: Br_Env,
    action_id: int,
    *,
    action_axis: str,
    completion_bonus_multiplier: float,
    coverage_reward_enabled: bool = True,
    encode_state: Callable[[list[int]], str],
) -> str:
    """Dry-run one action without deepcopy; proceed_action only mutates V_ns."""
    v_ns_snapshot = list(env.V_ns)
    try:
        next_state, _, _, _, _ = env.proceed_action(
            action_id,
            completion_bonus_multiplier=completion_bonus_multiplier,
            coverage_reward_enabled=coverage_reward_enabled,
            action_axis=action_axis,
        )
    finally:
        env.V_ns = v_ns_snapshot
    return encode_state(list(set(next_state)))


class StateActionRegistry:
    """Caches (S, a) -> S' via dry-run and builds action groups scoped to each source state."""

    def __init__(self) -> None:
        self.transition_seen: dict[tuple[str, int], str] = {}
        self.groups_by_state: dict[str, list[ActionGroup]] = {}

    def get_or_build_groups(
        self,
        env: Br_Env,
        state_hash: str,
        candidates: list[int],
        *,
        encode_state: Callable[[list[int]], str],
        action_axis: str,
        completion_bonus_multiplier: float,
        coverage_reward_enabled: bool = True,
    ) -> list[ActionGroup]:
        normalized = sorted({int(v) for v in candidates})
        if normalized and all((state_hash, action_id) in self.transition_seen for action_id in normalized):
            cached_groups = self.groups_by_state.get(state_hash)
            if cached_groups is not None:
                return cached_groups

        for action_id in normalized:
            key = (state_hash, action_id)
            if key in self.transition_seen:
                continue
            self.transition_seen[key] = _probe_next_state_hash(
                env,
                action_id,
                action_axis=action_axis,
                completion_bonus_multiplier=completion_bonus_multiplier,
                coverage_reward_enabled=coverage_reward_enabled,
                encode_state=encode_state,
            )

        buckets: dict[str, list[int]] = {}
        for action_id in normalized:
            next_hash = self.transition_seen[(state_hash, action_id)]
            buckets.setdefault(next_hash, []).append(action_id)

        groups: list[ActionGroup] = []
        for next_hash in sorted(buckets.keys()):
            members = sorted(buckets[next_hash])
            representative_id = int(min(members))
            groups.append(
                ActionGroup(
                    group_id=representative_id,
                    next_state_hash=next_hash,
                    member_actions=members,
                )
            )
        self.groups_by_state[state_hash] = groups
        return groups

    def group_by_id(self, state_hash: str, group_id: int) -> ActionGroup | None:
        for group in self.groups_by_state.get(state_hash, []):
            if int(group.group_id) == int(group_id):
                return group
        return None


class IncrementalActionRegistry:
    """Builds (S, g) online from executed transitions; aliases share the representative Q-entry."""

    def __init__(self) -> None:
        self.groups_by_state: dict[str, list[ActionGroup]] = {}
        self._group_by_next_hash: dict[str, dict[str, ActionGroup]] = {}
        self._alias_to_rep: dict[str, dict[int, int]] = {}

    def q_action_key(self, state_hash: str, candidate_id: int) -> int:
        """Q-table / trace key: representative when candidate is a known alias, else itself."""
        action_id = int(candidate_id)
        mapped = self._alias_to_rep.get(state_hash, {}).get(action_id)
        return int(mapped) if mapped is not None else action_id

    def groups_at_state(self, state_hash: str) -> list[ActionGroup]:
        return list(self.groups_by_state.get(state_hash, []))

    def register_observed_transition(
        self,
        state_hash: str,
        env_action: int,
        next_state_hash: str,
    ) -> ObservedMergeResult:
        action_id = int(env_action)
        next_hash = str(next_state_hash)
        by_next = self._group_by_next_hash.setdefault(state_hash, {})
        existing = by_next.get(next_hash)

        if existing is None:
            group = ActionGroup(
                group_id=action_id,
                next_state_hash=next_hash,
                member_actions=[action_id],
            )
            by_next[next_hash] = group
            self.groups_by_state.setdefault(state_hash, []).append(group)
            return ObservedMergeResult(
                q_action=action_id,
                env_action=action_id,
                merged=False,
                group=group,
            )

        rep = int(existing.group_id)
        if action_id == rep:
            return ObservedMergeResult(
                q_action=rep,
                env_action=action_id,
                merged=False,
                group=existing,
            )

        members = sorted(set(existing.member_actions) | {action_id})
        updated = ActionGroup(
            group_id=rep,
            next_state_hash=next_hash,
            member_actions=members,
        )
        by_next[next_hash] = updated
        state_groups = self.groups_by_state.setdefault(state_hash, [])
        for idx, group in enumerate(state_groups):
            if group.next_state_hash == next_hash:
                state_groups[idx] = updated
                break

        self._alias_to_rep.setdefault(state_hash, {})[action_id] = rep

        return ObservedMergeResult(
            q_action=rep,
            env_action=action_id,
            merged=True,
            group=updated,
        )

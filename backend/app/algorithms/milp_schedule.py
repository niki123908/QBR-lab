from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

import pulp

from app.algorithms.common.node import Node

ConflictMode = Literal["allow", "forbid"]


@dataclass(frozen=True)
class MilpScheduleResult:
    delay: int
    timeslots: list[dict[str, Any]]
    status: str  # optimal | timeout | infeasible
    lower_bound: int
    tried_horizons: list[int]
    conflict_mode: ConflictMode = "allow"


def _neighbors_list(nodes: list[Node]) -> list[list[int]]:
    out: list[list[int]] = []
    for node in nodes:
        self_id = int(node.ID)
        nbrs = sorted({int(v) for v in (node.neighbors or []) if int(v) != self_id})
        out.append(nbrs)
    return out


def _normalize_conflict_mode(value: Any) -> ConflictMode:
    raw = str(value or "allow").strip().lower()
    if raw in ("forbid", "conflict_free", "cf", "no_conflict"):
        return "forbid"
    return "allow"


def _solve_fixed_horizon(
    neighbors: list[list[int]],
    *,
    horizon: int,
    time_limit_sec: float,
    conflict_mode: ConflictMode = "allow",
) -> tuple[str, list[dict[str, Any]] | None]:
    """
    Feasibility MILP for broadcast.

    conflict_mode=\"allow\" (default):
      Receiver-side conflict — an uninformed node receives iff exactly one
      neighbor transmits; multiple TX ⇒ collision / no receive (allowed).

    conflict_mode=\"forbid\":
      An uninformed node may hear at most one transmitting neighbor. Already
      informed nodes may hear many transmitters (they do not receive again).
    """
    n = len(neighbors)
    t_slots = list(range(1, horizon + 1))
    node_ids = list(range(n))
    forbid = conflict_mode == "forbid"

    prob = pulp.LpProblem(f"broadcast_T{horizon}_{conflict_mode}", pulp.LpMinimize)
    x = pulp.LpVariable.dicts("x", ((i, t) for i in node_ids for t in t_slots), cat="Binary")
    y = pulp.LpVariable.dicts("y", ((i, t) for i in node_ids for t in range(0, horizon + 1)), cat="Binary")
    z = pulp.LpVariable.dicts("z", ((i, t) for i in node_ids for t in t_slots), cat="Binary")

    prob += 0

    for i in node_ids:
        prob += y[i, 0] == (1 if i == 0 else 0)

    for t in t_slots:
        for i in node_ids:
            prob += x[i, t] <= y[i, t - 1]

            nbrs = neighbors[i]
            if forbid and len(nbrs) >= 2:
                # Uninformed only: Σ x_nbr ≤ 1. Informed: vacuous.
                # y=0 ⇒ Σ ≤ 1; y=1 ⇒ Σ ≤ 1+|N|.
                prob += pulp.lpSum(x[j, t] for j in nbrs) <= 1 + len(nbrs) * y[i, t - 1]

            if not nbrs:
                prob += z[i, t] == 0
            else:
                s_tx = pulp.lpSum(x[j, t] for j in nbrs)
                prob += z[i, t] <= s_tx
                prob += z[i, t] <= 1 - y[i, t - 1]
                if forbid:
                    # Uninformed ⇒ s ≤ 1, so unique-TX force is enough via per-neighbor
                    # lower bounds (same form as allow). Do NOT use z ≥ s − y: when
                    # informed, s may be >1 and that would wrongly force z ≥ 1.
                    for j in nbrs:
                        others = [k for k in nbrs if k != j]
                        prob += z[i, t] >= x[j, t] - pulp.lpSum(x[k, t] for k in others) - y[i, t - 1]
                else:
                    # If z=1 then at most one neighbor transmits.
                    prob += s_tx <= 1 + (len(nbrs) - 1) * (1 - z[i, t])
                    # If a unique neighbor transmits (and i uninformed), force z=1.
                    for j in nbrs:
                        others = [k for k in nbrs if k != j]
                        prob += z[i, t] >= x[j, t] - pulp.lpSum(x[k, t] for k in others) - y[i, t - 1]

            prob += y[i, t] >= y[i, t - 1]
            prob += y[i, t] >= z[i, t]
            prob += y[i, t] <= y[i, t - 1] + z[i, t]

    for i in node_ids:
        prob += y[i, horizon] == 1

    limit = max(1.0, float(time_limit_sec))
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=limit)
    status_code = prob.solve(solver)

    if status_code != pulp.LpStatusOptimal:
        status_name = pulp.LpStatus.get(status_code, "unknown").lower()
        if status_name == "infeasible":
            return "infeasible", None
        return "timeout", None

    timeslots: list[dict[str, Any]] = []
    for t in t_slots:
        transmitters = [i for i in node_ids if int(round(pulp.value(x[i, t]) or 0)) == 1]
        receivers = [i for i in node_ids if int(round(pulp.value(z[i, t]) or 0)) == 1]
        if transmitters or receivers:
            timeslots.append(
                {
                    "timeslot": t,
                    "transmitters": transmitters,
                    "receivers": receivers,
                }
            )

    if not timeslots:
        return "infeasible", None
    return "optimal", timeslots


def validate_milp_schedule(
    nodes: list[Node],
    timeslots: list[dict[str, Any]],
    *,
    conflict_mode: ConflictMode | str = "allow",
) -> bool:
    """Replay schedule; forbid mode rejects collisions only on uninformed nodes."""
    mode = _normalize_conflict_mode(conflict_mode)
    n = len(nodes)
    neighbors = _neighbors_list(nodes)
    informed = {0}
    for slot in timeslots:
        transmitters = {int(v) for v in (slot.get("transmitters") or [])}
        if any(tx not in informed for tx in transmitters):
            return False
        hear_count = [0] * n
        for tx in transmitters:
            for rcv in neighbors[tx]:
                hear_count[rcv] += 1
        if mode == "forbid":
            if any(i not in informed and hear_count[i] > 1 for i in range(n)):
                return False
        newly = {i for i in range(n) if i not in informed and hear_count[i] == 1}
        expected = {int(v) for v in (slot.get("receivers") or [])}
        if newly != expected:
            return False
        informed |= newly
    return len(informed) == n


def schedule_milp(
    nodes: list[Node],
    *,
    lower_bound: int,
    solver_timeout_sec: float = 60.0,
    conflict_mode: ConflictMode | str = "allow",
) -> MilpScheduleResult:
    if not nodes:
        raise ValueError("Empty topology.")
    mode = _normalize_conflict_mode(conflict_mode)
    n = len(nodes)
    lb = max(1, int(lower_bound))
    t_max = max(lb, n - 1)
    neighbors = _neighbors_list(nodes)

    remaining = max(1.0, float(solver_timeout_sec))
    tried: list[int] = []
    saw_timeout = False
    started = time.monotonic()

    for horizon in range(lb, t_max + 1):
        elapsed = time.monotonic() - started
        left = remaining - elapsed
        if left <= 0.5:
            return MilpScheduleResult(
                delay=0,
                timeslots=[],
                status="timeout",
                lower_bound=lb,
                tried_horizons=tried,
                conflict_mode=mode,
            )
        horizons_left = t_max - horizon + 1
        slice_limit = max(1.0, min(left, remaining / max(1, horizons_left)))
        tried.append(horizon)
        status, timeslots = _solve_fixed_horizon(
            neighbors,
            horizon=horizon,
            time_limit_sec=slice_limit,
            conflict_mode=mode,
        )
        if status == "optimal" and timeslots is not None:
            dense = [
                {
                    "timeslot": idx,
                    "transmitters": sorted(slot["transmitters"]),
                    "receivers": sorted(slot["receivers"]),
                }
                for idx, slot in enumerate(timeslots, start=1)
            ]
            if not validate_milp_schedule(nodes, dense, conflict_mode=mode):
                # Solver returned a numerically odd solution; keep searching.
                continue
            return MilpScheduleResult(
                delay=len(dense),
                timeslots=dense,
                status="optimal",
                lower_bound=lb,
                tried_horizons=tried,
                conflict_mode=mode,
            )
        if status == "timeout":
            saw_timeout = True
        elif status == "infeasible":
            # Smaller T impossible ⇒ keep growing horizon.
            pass

    # Prefer timeout when we never proved infeasibility of the largest T,
    # or when optimal candidates failed validation.
    final_status = "timeout" if saw_timeout else "infeasible"
    return MilpScheduleResult(
        delay=0,
        timeslots=[],
        status=final_status,
        lower_bound=lb,
        tried_horizons=tried,
        conflict_mode=mode,
    )

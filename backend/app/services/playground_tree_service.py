from __future__ import annotations

import csv
import json
from collections import deque
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.core.db import db_session_scope
from app.models import Artifact, Run, Topology, TopologyNode, TopologyPlaygroundTree
from app.services.playground_simulation import enumerate_playground_transitions
from app.services.run_artifacts import read_artifact_file


ROOT_STATE_HASH = "0"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def canonical_state_hash(covered_node_ids: list[int] | None) -> str:
    ids = sorted({int(v) for v in (covered_node_ids or []) if int(v) >= 0})
    if ids == [0]:
        return ROOT_STATE_HASH
    return "/".join(str(v) for v in ids)


def empty_tree_payload() -> dict[str, Any]:
    return {
        "root_state_hash": ROOT_STATE_HASH,
        "next_state_index": 1,
        "nodes": [
            {
                "state_hash": ROOT_STATE_HASH,
                "state_index": 0,
                "depth": 0,
                "covered_node_ids": [0],
            }
        ],
        "edges": [],
    }


def empty_run_derived_tree_payload() -> dict[str, Any]:
    """Run-derived trees omit the synthetic playground root (state_index 0)."""
    return {
        "root_state_hash": "",
        "next_state_index": 1,
        "nodes": [],
        "edges": [],
    }


def _finalize_run_derived_tree(tree: dict[str, Any]) -> dict[str, Any]:
    nodes = [n for n in (tree.get("nodes") or []) if str(n.get("state_hash") or "") != ROOT_STATE_HASH]
    edges = tree.get("edges") or []
    tree["nodes"] = nodes
    tree["edges"] = edges
    if nodes:
        root_node = min(nodes, key=lambda row: (int(row.get("depth") or 0), int(row.get("state_index") or 0)))
        tree["root_state_hash"] = str(root_node["state_hash"])
        max_index = max(int(row.get("state_index") or 0) for row in nodes)
        tree["next_state_index"] = max(int(tree.get("next_state_index") or 1), max_index + 1)
    else:
        tree["root_state_hash"] = ""
        tree["next_state_index"] = 1
    return tree


def _normalize_tree_payload(raw: dict[str, Any] | None) -> dict[str, Any]:
    if not raw or not isinstance(raw, dict):
        return empty_tree_payload()

    nodes_in = raw.get("nodes") if isinstance(raw.get("nodes"), list) else []
    edges_in = raw.get("edges") if isinstance(raw.get("edges"), list) else []
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()

    for item in nodes_in:
        if not isinstance(item, dict):
            continue
        state_hash = str(item.get("state_hash") or "").strip()
        if not state_hash or state_hash in seen_hashes:
            continue
        covered = item.get("covered_node_ids")
        if not isinstance(covered, list):
            covered = [0]
        covered_ids = sorted({int(v) for v in covered if int(v) >= 0})
        if not covered_ids:
            covered_ids = [0]
        nodes.append(
            {
                "state_hash": state_hash,
                "state_index": int(item.get("state_index") or len(nodes)),
                "depth": max(0, int(item.get("depth") or 0)),
                "covered_node_ids": covered_ids,
            }
        )
        seen_hashes.add(state_hash)

    if ROOT_STATE_HASH not in seen_hashes:
        nodes.insert(
            0,
            {
                "state_hash": ROOT_STATE_HASH,
                "state_index": 0,
                "depth": 0,
                "covered_node_ids": [0],
            },
        )
        seen_hashes.add(ROOT_STATE_HASH)

    nodes.sort(key=lambda row: (int(row["depth"]), int(row["state_index"]), str(row["state_hash"])))
    next_state_index = max(int(raw.get("next_state_index") or 0), max((int(n["state_index"]) for n in nodes), default=0) + 1)

    for item in edges_in:
        if not isinstance(item, dict):
            continue
        from_hash = str(item.get("from_state_hash") or "").strip()
        to_hash = str(item.get("to_state_hash") or "").strip()
        if not from_hash or not to_hash:
            continue
        actions_raw = item.get("actions")
        if not isinstance(actions_raw, list):
            actions_raw = []
        actions = sorted({int(v) for v in actions_raw if int(v) >= 0})
        mode = str(item.get("mode") or "broadcaster")
        if mode not in {"broadcaster", "receiver"}:
            mode = "broadcaster"
        edges.append(
            {
                "from_state_hash": from_hash,
                "to_state_hash": to_hash,
                "actions": actions,
                "mode": mode,
            }
        )

    return {
        "root_state_hash": ROOT_STATE_HASH,
        "next_state_index": next_state_index,
        "nodes": nodes,
        "edges": edges,
    }


def _load_tree_row(session, topology_id: str) -> TopologyPlaygroundTree | None:
    return session.get(TopologyPlaygroundTree, topology_id)


def get_playground_tree(topology_id: str) -> dict[str, Any] | None:
    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            return None
        row = _load_tree_row(session, topology_id)
        if row is None:
            return empty_tree_payload()
        try:
            raw = json.loads(row.tree_json)
        except json.JSONDecodeError:
            raw = None
        return _normalize_tree_payload(raw)


def reset_playground_tree(topology_id: str) -> dict[str, Any] | None:
    payload = empty_tree_payload()
    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            return None
        row = _load_tree_row(session, topology_id)
        if row is None:
            row = TopologyPlaygroundTree(
                topology_id=topology_id,
                tree_json=json.dumps(payload),
                updated_at=_utcnow(),
            )
            session.add(row)
        else:
            row.tree_json = json.dumps(payload)
            row.updated_at = _utcnow()
    return payload


def append_playground_tree_event(
    topology_id: str,
    *,
    from_state_hash: str,
    to_state_hash: str,
    action: int,
    mode: str,
    to_covered_node_ids: list[int],
) -> dict[str, Any] | None:
    from_hash = str(from_state_hash or "").strip() or ROOT_STATE_HASH
    to_hash = canonical_state_hash(to_covered_node_ids)
    if to_hash == from_hash:
        return get_playground_tree(topology_id)

    action_id = int(action)
    if action_id < 0:
        raise ValueError("Failed.")

    policy_mode = str(mode or "broadcaster")
    if policy_mode not in {"broadcaster", "receiver"}:
        policy_mode = "broadcaster"

    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            return None

        row = _load_tree_row(session, topology_id)
        if row is None:
            tree = empty_tree_payload()
            row = TopologyPlaygroundTree(
                topology_id=topology_id,
                tree_json=json.dumps(tree),
                updated_at=_utcnow(),
            )
            session.add(row)
        else:
            try:
                tree = _normalize_tree_payload(json.loads(row.tree_json))
            except json.JSONDecodeError:
                tree = empty_tree_payload()

        tree = deepcopy(tree)
        nodes_by_hash = {str(n["state_hash"]): n for n in tree["nodes"]}

        if from_hash not in nodes_by_hash:
            nodes_by_hash[from_hash] = {
                "state_hash": from_hash,
                "state_index": int(tree["next_state_index"]),
                "depth": 0,
                "covered_node_ids": [0],
            }
            tree["next_state_index"] = int(tree["next_state_index"]) + 1

        from_node = nodes_by_hash[from_hash]
        if to_hash not in nodes_by_hash:
            nodes_by_hash[to_hash] = {
                "state_hash": to_hash,
                "state_index": int(tree["next_state_index"]),
                "depth": int(from_node["depth"]) + 1,
                "covered_node_ids": sorted({int(v) for v in to_covered_node_ids if int(v) >= 0}),
            }
            tree["next_state_index"] = int(tree["next_state_index"]) + 1
        else:
            existing = nodes_by_hash[to_hash]
            existing["covered_node_ids"] = sorted({int(v) for v in to_covered_node_ids if int(v) >= 0})

        tree["nodes"] = sorted(
            nodes_by_hash.values(),
            key=lambda row: (int(row["depth"]), int(row["state_index"]), str(row["state_hash"])),
        )

        merged = False
        for edge in tree["edges"]:
            if (
                edge["from_state_hash"] == from_hash
                and edge["to_state_hash"] == to_hash
                and edge.get("mode") == policy_mode
            ):
                actions = set(int(v) for v in edge.get("actions") or [])
                actions.add(action_id)
                edge["actions"] = sorted(actions)
                merged = True
                break

        if not merged:
            tree["edges"].append(
                {
                    "from_state_hash": from_hash,
                    "to_state_hash": to_hash,
                    "actions": [action_id],
                    "mode": policy_mode,
                }
            )

        row.tree_json = json.dumps(tree)
        row.updated_at = _utcnow()
        return tree


def count_unique_root_paths(tree: dict[str, Any]) -> int:
    """
    Count root-to-leaf routes in the current tree.
    Each edge with N action labels counts as N branches; cycles are not counted.
    """
    edges = tree.get("edges") if isinstance(tree.get("edges"), list) else []
    adjacency: dict[str, list[tuple[str, int]]] = {}
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        from_hash = str(edge.get("from_state_hash") or "").strip()
        to_hash = str(edge.get("to_state_hash") or "").strip()
        if not from_hash or not to_hash:
            continue
        actions = edge.get("actions") if isinstance(edge.get("actions"), list) else []
        branches = max(1, len({int(v) for v in actions if int(v) >= 0}))
        adjacency.setdefault(from_hash, []).append((to_hash, branches))

    def walk(node: str, visited: frozenset[str]) -> int:
        if node in visited:
            return 0
        outgoing = adjacency.get(node)
        if not outgoing:
            return 1
        next_visited = visited | {node}
        total = 0
        for to_hash, branches in outgoing:
            total += branches * walk(to_hash, next_visited)
        return total

    return walk(ROOT_STATE_HASH, frozenset())


def _apply_tree_transition(
    tree: dict[str, Any],
    *,
    from_state_hash: str,
    to_covered_node_ids: list[int],
    action: int,
    mode: str,
) -> tuple[dict[str, Any], bool, bool, bool]:
    """Returns (tree, node_created, edge_touched, target_was_existing)."""
    from_hash = str(from_state_hash or "").strip() or ROOT_STATE_HASH
    to_hash = canonical_state_hash(to_covered_node_ids)
    if to_hash == from_hash:
        return tree, False, False, False

    action_id = int(action)
    if action_id < 0:
        return tree, False, False, False

    policy_mode = str(mode or "broadcaster")
    if policy_mode not in {"broadcaster", "receiver"}:
        policy_mode = "broadcaster"

    nodes_by_hash = {str(n["state_hash"]): n for n in tree["nodes"]}
    target_was_existing = to_hash in nodes_by_hash
    node_created = False
    edge_touched = False

    if from_hash not in nodes_by_hash:
        nodes_by_hash[from_hash] = {
            "state_hash": from_hash,
            "state_index": int(tree["next_state_index"]),
            "depth": 0,
            "covered_node_ids": [0],
        }
        tree["next_state_index"] = int(tree["next_state_index"]) + 1

    from_node = nodes_by_hash[from_hash]
    if to_hash not in nodes_by_hash:
        nodes_by_hash[to_hash] = {
            "state_hash": to_hash,
            "state_index": int(tree["next_state_index"]),
            "depth": int(from_node["depth"]) + 1,
            "covered_node_ids": sorted({int(v) for v in to_covered_node_ids if int(v) >= 0}),
        }
        tree["next_state_index"] = int(tree["next_state_index"]) + 1
        node_created = True
    else:
        existing = nodes_by_hash[to_hash]
        existing["covered_node_ids"] = sorted({int(v) for v in to_covered_node_ids if int(v) >= 0})

    tree["nodes"] = sorted(
        nodes_by_hash.values(),
        key=lambda row: (int(row["depth"]), int(row["state_index"]), str(row["state_hash"])),
    )

    merged = False
    for edge in tree["edges"]:
        if (
            edge["from_state_hash"] == from_hash
            and edge["to_state_hash"] == to_hash
            and edge.get("mode") == policy_mode
        ):
            actions = set(int(v) for v in edge.get("actions") or [])
            if action_id not in actions:
                actions.add(action_id)
                edge["actions"] = sorted(actions)
            edge_touched = True
            merged = True
            break

    if not merged:
        tree["edges"].append(
            {
                "from_state_hash": from_hash,
                "to_state_hash": to_hash,
                "actions": [action_id],
                "mode": policy_mode,
            }
        )
        edge_touched = True

    return tree, node_created, edge_touched, target_was_existing


DEFAULT_EXPAND_MAX_TRANSITIONS = 10_000


def expand_playground_tree(
    topology_id: str,
    *,
    max_transitions: int = DEFAULT_EXPAND_MAX_TRANSITIONS,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """
    BFS from every state in the tree: enumerate all broadcaster/receiver actions,
    add missing states (by covered-node hash), always link edges to existing states too.
    """
    cap = max(1, int(max_transitions))
    stats = {
        "states_expanded": 0,
        "transitions_applied": 0,
        "nodes_added": 0,
        "edges_added": 0,
        "edges_to_existing_states": 0,
        "unique_paths": 0,
        "truncated": False,
    }

    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        if topology is None or topology.is_deleted:
            return None, None

        node_rows = list(
            session.scalars(
                select(TopologyNode)
                .where(TopologyNode.topology_id == topology_id)
                .order_by(TopologyNode.node_id.asc())
            ).all()
        )
        if not node_rows:
            return None, None

        tx_range = float(topology.tx_range)

        row = _load_tree_row(session, topology_id)
        if row is None:
            tree = empty_tree_payload()
            row = TopologyPlaygroundTree(
                topology_id=topology_id,
                tree_json=json.dumps(tree),
                updated_at=_utcnow(),
            )
            session.add(row)
        else:
            try:
                tree = _normalize_tree_payload(json.loads(row.tree_json))
            except json.JSONDecodeError:
                tree = empty_tree_payload()

        tree = deepcopy(tree)
        nodes_by_hash = {str(n["state_hash"]): n for n in tree["nodes"]}
        expanded_from: set[str] = set()
        queue: deque[str] = deque(nodes_by_hash.keys())

        while queue:
            from_hash = queue.popleft()
            if from_hash in expanded_from:
                continue
            expanded_from.add(from_hash)
            stats["states_expanded"] += 1

            from_node = nodes_by_hash.get(from_hash)
            if not from_node:
                continue

            covered = list(from_node.get("covered_node_ids") or [0])
            for transition in enumerate_playground_transitions(node_rows, tx_range, covered):
                if stats["transitions_applied"] >= cap:
                    stats["truncated"] = True
                    break

                tree, node_created, edge_touched, target_was_existing = _apply_tree_transition(
                    tree,
                    from_state_hash=from_hash,
                    to_covered_node_ids=transition["to_covered_node_ids"],
                    action=int(transition["action"]),
                    mode=str(transition["mode"]),
                )
                stats["transitions_applied"] += 1
                if node_created:
                    stats["nodes_added"] += 1
                if edge_touched:
                    stats["edges_added"] += 1
                    if target_was_existing:
                        stats["edges_to_existing_states"] += 1

                to_hash = canonical_state_hash(transition["to_covered_node_ids"])
                nodes_by_hash = {str(n["state_hash"]): n for n in tree["nodes"]}
                if to_hash not in expanded_from:
                    queue.append(to_hash)

            if stats["truncated"]:
                break

        stats["unique_paths"] = count_unique_root_paths(tree)

        row.tree_json = json.dumps(tree)
        row.updated_at = _utcnow()
        return tree, stats


def _run_state_id_key(state_id: int | str) -> str:
    return f"id:{int(state_id)}"


def _read_artifact_path(session, run_id: str, artifact_type: str) -> Path | None:
    row = session.scalars(
        select(Artifact).where(Artifact.run_id == run_id, Artifact.artifact_type == artifact_type).limit(1)
    ).first()
    if row is not None:
        path = Path(row.uri)
        if path.exists() and path.is_file():
            return path
    artifact_root = Path(__file__).resolve().parents[3] / "storage" / "artifacts" / run_id
    for name in (artifact_type, f"{artifact_type}.json", f"{artifact_type}.json.gz", f"{artifact_type}.csv"):
        candidate = artifact_root / name
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def _read_json_artifact(session, run_id: str, artifact_type: str) -> Any | None:
    path = _read_artifact_path(session, run_id, artifact_type)
    if path is None:
        return None
    return read_artifact_file(path)


def _read_csv_artifact(session, run_id: str, artifact_type: str) -> list[dict[str, str]] | None:
    path = _read_artifact_path(session, run_id, artifact_type)
    if path is None:
        return None
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))
    except OSError:
        return None


def _extract_episode_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        episodes = payload.get("episodes")
        if isinstance(episodes, list):
            return [item for item in episodes if isinstance(item, dict)]
        # Some payloads may already be a single episode-like record.
        if "steps" in payload and isinstance(payload.get("steps"), list):
            return [payload]
        return []
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _coerce_non_negative_int_list(raw: Any) -> list[int]:
    if not isinstance(raw, list):
        return []
    values: list[int] = []
    for item in raw:
        try:
            value = int(item)
        except (TypeError, ValueError):
            continue
        if value >= 0:
            values.append(value)
    return sorted(set(values))


def _upsert_transition_by_hash(
    tree: dict[str, Any],
    *,
    from_state_hash: str,
    to_state_hash: str,
    action: int,
    mode: str,
    to_covered_node_ids: list[int] | None = None,
    depth_hint: int | None = None,
) -> dict[str, Any]:
    from_hash = str(from_state_hash or "").strip() or ROOT_STATE_HASH
    to_hash = str(to_state_hash or "").strip()
    if not to_hash or to_hash == from_hash:
        return tree
    action_id = int(action)
    if action_id < 0:
        return tree
    policy_mode = str(mode or "broadcaster")
    if policy_mode not in {"broadcaster", "receiver"}:
        policy_mode = "broadcaster"

    nodes_by_hash = {str(n["state_hash"]): n for n in tree["nodes"]}
    if from_hash not in nodes_by_hash:
        nodes_by_hash[from_hash] = {
            "state_hash": from_hash,
            "state_index": int(tree["next_state_index"]),
            "depth": max(0, int(depth_hint or 0) - 1),
            "covered_node_ids": [0],
        }
        tree["next_state_index"] = int(tree["next_state_index"]) + 1
    else:
        if depth_hint is not None:
            nodes_by_hash[from_hash]["depth"] = min(int(nodes_by_hash[from_hash].get("depth") or 0), max(0, int(depth_hint) - 1))

    from_node = nodes_by_hash[from_hash]
    if to_hash not in nodes_by_hash:
        nodes_by_hash[to_hash] = {
            "state_hash": to_hash,
            "state_index": int(tree["next_state_index"]),
            "depth": int(depth_hint) if depth_hint is not None else int(from_node["depth"]) + 1,
            "covered_node_ids": to_covered_node_ids or [],
        }
        tree["next_state_index"] = int(tree["next_state_index"]) + 1
    else:
        existing = nodes_by_hash[to_hash]
        if depth_hint is not None:
            existing["depth"] = min(int(existing.get("depth") or 0), int(depth_hint))
        if to_covered_node_ids:
            existing["covered_node_ids"] = sorted(
                set(_coerce_non_negative_int_list(existing.get("covered_node_ids")) + list(to_covered_node_ids))
            )

    tree["nodes"] = sorted(
        nodes_by_hash.values(),
        key=lambda row: (int(row["depth"]), int(row["state_index"]), str(row["state_hash"])),
    )

    merged = False
    for edge in tree["edges"]:
        if (
            edge["from_state_hash"] == from_hash
            and edge["to_state_hash"] == to_hash
            and edge.get("mode") == policy_mode
        ):
            actions = set(int(v) for v in edge.get("actions") or [])
            actions.add(action_id)
            edge["actions"] = sorted(actions)
            merged = True
            break
    if not merged:
        tree["edges"].append(
            {
                "from_state_hash": from_hash,
                "to_state_hash": to_hash,
                "actions": [action_id],
                "mode": policy_mode,
            }
        )
    return tree


def _resolve_next_state_hash(step: dict[str, Any]) -> tuple[str, list[int]]:
    next_hash = str(step.get("next_state_hash") or "").strip()
    next_covered = _coerce_non_negative_int_list(step.get("next_state_covered_node_ids"))
    if next_hash:
        return next_hash, next_covered
    if next_covered:
        return canonical_state_hash(next_covered), next_covered
    next_state_id = step.get("next_state_id")
    if next_state_id is not None and str(next_state_id).strip():
        try:
            return _run_state_id_key(int(next_state_id)), next_covered
        except (TypeError, ValueError):
            return str(next_state_id), next_covered
    return "", next_covered


def _tree_nodes_index(tree: dict[str, Any]) -> dict[str, dict[str, Any]]:
    index = tree.get("_nodes_by_hash")
    if isinstance(index, dict):
        return index
    index = {str(n["state_hash"]): n for n in tree.get("nodes") or [] if isinstance(n, dict)}
    tree["_nodes_by_hash"] = index
    return index


def _tree_edge_index(tree: dict[str, Any]) -> dict[tuple[str, str, str], dict[str, Any]]:
    index = tree.get("_edge_index")
    if isinstance(index, dict):
        return index
    index: dict[tuple[str, str, str], dict[str, Any]] = {}
    for edge in tree.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        key = (
            str(edge.get("from_state_hash") or ""),
            str(edge.get("to_state_hash") or ""),
            str(edge.get("mode") or "broadcaster"),
        )
        index[key] = edge
    tree["_edge_index"] = index
    return index


def _materialize_run_derived_tree(tree: dict[str, Any]) -> dict[str, Any]:
    """Flush internal indexes to nodes/edges lists and finalize (call once after bulk inserts)."""
    nodes_by_hash = tree.pop("_nodes_by_hash", None)
    edge_index = tree.pop("_edge_index", None)
    if isinstance(nodes_by_hash, dict):
        tree["nodes"] = sorted(
            nodes_by_hash.values(),
            key=lambda row: (int(row.get("depth") or 0), int(row.get("state_index") or 0), str(row.get("state_hash") or "")),
        )
    if isinstance(edge_index, dict):
        tree["edges"] = list(edge_index.values())
    return _finalize_run_derived_tree(tree)


def _upsert_transition_by_state_id(
    tree: dict[str, Any],
    *,
    from_state_id: int,
    to_state_id: int,
    action: int,
    mode: str = "broadcaster",
    depth_hint: int | None = None,
    run_state_hash: str | None = None,
    run_next_state_hash: str | None = None,
    defer_materialize: bool = False,
) -> dict[str, Any]:
    from_key = _run_state_id_key(from_state_id)
    to_key = _run_state_id_key(to_state_id)
    if from_key == to_key:
        return tree
    action_id = int(action)
    if action_id < 0:
        return tree
    policy_mode = str(mode or "broadcaster")
    if policy_mode not in {"broadcaster", "receiver"}:
        policy_mode = "broadcaster"

    nodes_by_hash = _tree_nodes_index(tree)
    if from_key not in nodes_by_hash:
        nodes_by_hash[from_key] = {
            "state_hash": from_key,
            "state_index": int(from_state_id),
            "depth": max(0, int(depth_hint or 0) - 1),
            "covered_node_ids": [],
            "run_state_hash": str(run_state_hash or ""),
        }
    else:
        if depth_hint is not None:
            nodes_by_hash[from_key]["depth"] = min(
                int(nodes_by_hash[from_key].get("depth") or 0),
                max(0, int(depth_hint) - 1),
            )
        if run_state_hash:
            nodes_by_hash[from_key]["run_state_hash"] = str(run_state_hash)

    from_node = nodes_by_hash[from_key]
    if to_key not in nodes_by_hash:
        nodes_by_hash[to_key] = {
            "state_hash": to_key,
            "state_index": int(to_state_id),
            "depth": int(depth_hint) if depth_hint is not None else int(from_node["depth"]) + 1,
            "covered_node_ids": [],
            "run_state_hash": str(run_next_state_hash or ""),
        }
    else:
        existing = nodes_by_hash[to_key]
        if depth_hint is not None:
            existing["depth"] = min(int(existing.get("depth") or 0), int(depth_hint))
        if run_next_state_hash:
            existing["run_state_hash"] = str(run_next_state_hash)

    max_state_id = max(int(node.get("state_index") or 0) for node in nodes_by_hash.values())
    tree["next_state_index"] = max(int(tree.get("next_state_index") or 1), max_state_id + 1)

    edge_index = _tree_edge_index(tree)
    edge_key = (from_key, to_key, policy_mode)
    existing_edge = edge_index.get(edge_key)
    if existing_edge is not None:
        actions = set(int(v) for v in existing_edge.get("actions") or [])
        actions.add(action_id)
        existing_edge["actions"] = sorted(actions)
    else:
        edge_index[edge_key] = {
            "from_state_hash": from_key,
            "to_state_hash": to_key,
            "actions": [action_id],
            "mode": policy_mode,
        }

    if not defer_materialize:
        return _materialize_run_derived_tree(tree)
    return tree


def build_run_decision_graph_from_episodes(
    episodes_steps: list[dict[str, Any]], *, default_mode: str = "broadcaster"
) -> dict[str, Any]:
    """Merge all episode steps into a deduplicated decision graph (stored as run_decision_graph artifact)."""
    tree = empty_run_derived_tree_payload()
    for episode_payload in episodes_steps:
        steps = episode_payload.get("steps")
        if not isinstance(steps, list):
            continue
        for step_index, step in enumerate(steps, start=1):
            if not isinstance(step, dict):
                continue
            try:
                from_state_id = int(step.get("state_id"))
                to_state_id = int(step.get("next_state_id"))
                action_id = int(step.get("action"))
            except (TypeError, ValueError):
                continue
            tree = _upsert_transition_by_state_id(
                tree,
                from_state_id=from_state_id,
                to_state_id=to_state_id,
                action=action_id,
                mode=str(step.get("mode") or default_mode),
                depth_hint=step_index,
                run_state_hash=str(step.get("state_hash") or ""),
                run_next_state_hash=str(step.get("next_state_hash") or ""),
                defer_materialize=True,
            )
    finalized = _materialize_run_derived_tree(tree)
    return {
        "schema_version": 1,
        "source": "all_episodes_merged",
        "tree": finalized,
    }


def _derive_tree_from_path_action_rows(rows: list[dict[str, str]], *, default_mode: str = "broadcaster") -> dict[str, Any]:
    tree = empty_run_derived_tree_payload()
    for row in rows:
        try:
            from_state_id = int(row.get("state_id") or "")
            to_state_id = int(row.get("next_state_id") or "")
            action_id = int(row.get("action") or "")
            step_index = int(row.get("step_index") or row.get("timeslot") or 0)
        except (TypeError, ValueError):
            continue
        tree = _upsert_transition_by_state_id(
            tree,
            from_state_id=from_state_id,
            to_state_id=to_state_id,
            action=action_id,
            mode=default_mode,
            depth_hint=step_index if step_index > 0 else None,
            run_state_hash=str(row.get("state_hash") or ""),
            run_next_state_hash=str(row.get("next_state_hash") or ""),
            defer_materialize=True,
        )
    return _materialize_run_derived_tree(tree)


def _tree_from_run_decision_graph_artifact(graph_raw: Any) -> dict[str, Any] | None:
    if not isinstance(graph_raw, dict):
        return None
    tree = graph_raw.get("tree") if isinstance(graph_raw.get("tree"), dict) else graph_raw
    if not isinstance(tree, dict):
        return None
    if tree.get("edges"):
        return tree
    return None


def _tree_from_all_episode_steps(episodes_steps: list[dict[str, Any]], *, default_mode: str = "broadcaster") -> dict[str, Any]:
    graph_payload = build_run_decision_graph_from_episodes(episodes_steps, default_mode=default_mode)
    tree = graph_payload.get("tree") if isinstance(graph_payload.get("tree"), dict) else graph_payload
    return tree if isinstance(tree, dict) else empty_run_derived_tree_payload()


def derive_playground_tree_from_run(topology_id: str, run_id: str) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """
    Build a standalone decision tree from run artifacts (read-only, does not touch manual playground tree storage).
    Returns (tree_payload, source_artifact, message).
    """
    with db_session_scope() as session:
        topology = session.get(Topology, topology_id)
        run_row = session.get(Run, run_id)
        if topology is None or topology.is_deleted or run_row is None:
            return None, None, None
        if run_row.topology_id != topology_id:
            return None, None, None

        graph_raw = _read_json_artifact(session, run_id, "run_decision_graph")
        tree = _tree_from_run_decision_graph_artifact(graph_raw)
        if tree is not None:
            return tree, "run_decision_graph (all epochs)", None

        trace_raw = _read_json_artifact(session, run_id, "trace_epochs")
        if isinstance(trace_raw, dict):
            all_episodes = trace_raw.get("all_episodes")
            if isinstance(all_episodes, list) and all_episodes:
                merged = _tree_from_all_episode_steps(all_episodes)
                if merged.get("edges"):
                    return merged, "trace_epochs.all_episodes", None

        source_artifact = "path_action_transitions"
        csv_rows = _read_csv_artifact(session, run_id, "path_action_transitions")
        if csv_rows:
            tree = _derive_tree_from_path_action_rows(csv_rows)
            if tree.get("edges"):
                return tree, source_artifact, None

        source_artifact = "state_action_all_epochs"
        raw = _read_json_artifact(session, run_id, "state_action_all_epochs")
        if raw is not None:
            episodes = _extract_episode_rows(raw)
            if len(episodes) > 1:
                merged = _tree_from_all_episode_steps(episodes)
                if merged.get("edges"):
                    return merged, source_artifact, None

        raw = None
        source_artifact = "state_action_last_epoch"
        raw = _read_json_artifact(session, run_id, "state_action_last_epoch")
        if raw is None:
            source_artifact = "state_action_best_epoch"
            raw = _read_json_artifact(session, run_id, "state_action_best_epoch")
        if raw is None and isinstance(trace_raw, dict):
            for key in ("last", "best"):
                episode = trace_raw.get(key)
                if isinstance(episode, dict) and isinstance(episode.get("steps"), list) and episode.get("steps"):
                    raw = episode
                    source_artifact = f"trace_epochs.{key}"
                    break
        if raw is None:
            return (
                empty_run_derived_tree_payload(),
                None,
                "Run does not contain run_decision_graph, path_action_transitions, or trace_epochs artifact.",
            )

        episodes = _extract_episode_rows(raw)
        if not episodes:
            return (
                empty_run_derived_tree_payload(),
                source_artifact,
                "Run trace artifact has no episode/step data.",
            )

        tree = empty_run_derived_tree_payload()
        for episode in episodes:
            steps = episode.get("steps")
            if not isinstance(steps, list):
                continue
            for step_index, step in enumerate(steps, start=1):
                if not isinstance(step, dict):
                    continue
                try:
                    from_state_id = int(step.get("state_id"))
                    to_state_id = int(step.get("next_state_id"))
                    action_id = int(step.get("action"))
                except (TypeError, ValueError):
                    continue
                tree = _upsert_transition_by_state_id(
                    tree,
                    from_state_id=from_state_id,
                    to_state_id=to_state_id,
                    action=action_id,
                    mode=str(step.get("mode") or "broadcaster"),
                    depth_hint=step_index,
                    run_state_hash=str(step.get("state_hash") or ""),
                    run_next_state_hash=str(step.get("next_state_hash") or ""),
                    defer_materialize=True,
                )

        tree = _materialize_run_derived_tree(tree)
        if not tree.get("edges"):
            return (
                tree,
                source_artifact,
                "Run trace loaded but no valid transitions found.",
            )
        hint = None
        if source_artifact in {"state_action_last_epoch", "state_action_best_epoch"} or (
            source_artifact and source_artifact.startswith("trace_epochs.")
        ):
            hint = "Showing a single epoch only; use run_decision_graph (all epochs) when available."
        return tree, source_artifact, hint

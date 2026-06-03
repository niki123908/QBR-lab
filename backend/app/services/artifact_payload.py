"""Resolve artifact API payloads (new bundle format + legacy aliases)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.services.run_artifacts import (
    bundle_as_run_summary,
    episodes_to_delay_csv_text,
    episodes_to_path_signatures_csv_text,
    read_artifact_file,
)


def _artifact_root(run_id: str) -> Path:
    # backend/app/services -> QBR repo root (same as app.core.db)
    return Path(__file__).resolve().parents[3] / "storage" / "artifacts" / run_id


def _load_bundle(run_id: str, uri_path: Path | None = None) -> dict[str, Any] | None:
    candidates: list[Path] = []
    if uri_path is not None:
        candidates.append(uri_path)
    root = _artifact_root(run_id)
    candidates.extend([root / "run_bundle.json.gz", root / "run_bundle.json"])
    for path in candidates:
        payload = read_artifact_file(path)
        if isinstance(payload, dict) and payload.get("schema_version"):
            return payload
    return None


def _load_trace_epochs(run_id: str) -> dict[str, Any] | None:
    root = _artifact_root(run_id)
    for name in ("trace_epochs.json.gz", "trace_epochs.json"):
        payload = read_artifact_file(root / name)
        if isinstance(payload, dict):
            return payload
    return None


def resolve_artifact_payload(
    run_id: str,
    artifact_type: str,
    *,
    uri_path: Path | None = None,
) -> Any | None:
    """Return payload for API artifact_type (new or legacy name)."""
    if artifact_type in {"run_bundle", "trace_epochs", "run_decision_graph", "q_table"}:
        if uri_path is not None:
            return read_artifact_file(uri_path)
        root = _artifact_root(run_id)
        suffix = {
            "run_bundle": "run_bundle.json.gz",
            "trace_epochs": "trace_epochs.json.gz",
            "run_decision_graph": "run_decision_graph.json.gz",
            "q_table": "q_table.json.gz",
        }[artifact_type]
        legacy = suffix.replace(".gz", "")
        for name in (suffix, legacy):
            payload = read_artifact_file(root / name)
            if payload is not None:
                return payload
        return None

    bundle = _load_bundle(run_id, uri_path if artifact_type == "run_bundle" else None)

    if artifact_type == "run_summary":
        if bundle is not None:
            return bundle_as_run_summary(bundle)
        if uri_path is not None:
            return read_artifact_file(uri_path)
        return read_artifact_file(_artifact_root(run_id) / "run_summary.json")

    if bundle is not None:
        episodes = bundle.get("episodes") if isinstance(bundle.get("episodes"), list) else []
        transmission = bundle.get("transmission") if isinstance(bundle.get("transmission"), dict) else {}
        if artifact_type == "transmission_last_epoch":
            last = transmission.get("last")
            return last if isinstance(last, dict) else None
        if artifact_type == "transmission_best_epoch":
            best = transmission.get("best")
            return best if isinstance(best, dict) else None
        if artifact_type == "delay_per_episode":
            return {"text": episodes_to_delay_csv_text(episodes)}
        if artifact_type == "path_signatures":
            return {"text": episodes_to_path_signatures_csv_text(episodes)}
        if artifact_type == "policy_trace":
            policy = bundle.get("policy") if isinstance(bundle.get("policy"), dict) else {}
            if str(policy.get("policy_type") or "") == "ucb":
                return None
            return None

    trace = _load_trace_epochs(run_id)
    if trace is not None:
        if artifact_type == "state_action_last_epoch":
            last = trace.get("last")
            return last if isinstance(last, dict) else None
        if artifact_type == "state_action_best_epoch":
            best = trace.get("best")
            return best if isinstance(best, dict) else None

    if uri_path is not None:
        payload = read_artifact_file(uri_path)
        if payload is not None:
            return payload
        if uri_path.suffix.lower() == ".csv":
            try:
                return {"text": uri_path.read_text(encoding="utf-8")}
            except OSError:
                return None

    root = _artifact_root(run_id)
    legacy_names = {
        "transmission_last_epoch": "transmission_last_epoch.json",
        "transmission_best_epoch": "transmission_best_epoch.json",
        "state_action_last_epoch": "state_action_last_epoch.json",
        "state_action_best_epoch": "state_action_best_epoch.json",
        "delay_per_episode": "delay_per_episode.csv",
        "path_signatures": "path_signatures.csv",
        "policy_trace": "policy_trace.csv",
        "q_table": "q_table.json",
        "path_action_transitions": "path_action_transitions.csv",
    }
    legacy = legacy_names.get(artifact_type)
    if legacy:
        path = root / legacy
        if path.exists():
            return read_artifact_file(path)
    return None

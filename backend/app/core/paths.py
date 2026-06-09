from __future__ import annotations

import os
from pathlib import Path


def qbr_root() -> Path:
    """Repository root. Override with QBR_ROOT in Docker (/app)."""
    raw = os.getenv("QBR_ROOT", "").strip()
    if raw:
        return Path(raw).resolve()
    # backend/app/core -> QBR repo root (local dev)
    return Path(__file__).resolve().parents[3]


def storage_root() -> Path:
    path = qbr_root() / "storage"
    path.mkdir(parents=True, exist_ok=True)
    return path


def artifact_root_for_run(run_id: str) -> Path:
    path = storage_root() / "artifacts" / run_id
    path.mkdir(parents=True, exist_ok=True)
    return path

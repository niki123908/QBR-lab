from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from sqlalchemy import select

from app.core.db import db_session_scope
from app.models import RunPreset


@dataclass(frozen=True)
class PresetRecord:
    id: str
    label: str
    backbone: str
    algorithm_id: str
    run_config: dict[str, Any]


def list_presets() -> list[PresetRecord]:
    with db_session_scope() as session:
        rows = session.scalars(select(RunPreset).order_by(RunPreset.updated_at.desc())).all()
        out: list[PresetRecord] = []
        for row in rows:
            try:
                cfg = json.loads(row.run_config_json or "{}")
            except json.JSONDecodeError:
                cfg = {}
            out.append(
                PresetRecord(
                    id=row.id,
                    label=row.label,
                    backbone=row.backbone,
                    algorithm_id=row.algorithm_id,
                    run_config=cfg if isinstance(cfg, dict) else {},
                )
            )
        return out


def create_preset(*, label: str, backbone: str, algorithm_id: str, run_config: dict[str, Any]) -> PresetRecord:
    preset_id = str(uuid4())
    with db_session_scope() as session:
        row = RunPreset(
            id=preset_id,
            label=label.strip(),
            backbone=backbone,
            algorithm_id=algorithm_id,
            run_config_json=json.dumps(run_config or {}, ensure_ascii=False),
        )
        session.add(row)
        session.flush()
    return PresetRecord(
        id=preset_id,
        label=label.strip(),
        backbone=backbone,
        algorithm_id=algorithm_id,
        run_config=dict(run_config or {}),
    )


def update_preset(
    preset_id: str,
    *,
    label: str | None = None,
    backbone: str | None = None,
    algorithm_id: str | None = None,
    run_config: dict[str, Any] | None = None,
) -> PresetRecord | None:
    with db_session_scope() as session:
        row = session.get(RunPreset, preset_id)
        if row is None:
            return None
        if label is not None:
            row.label = label.strip()
        if backbone is not None:
            row.backbone = backbone
        if algorithm_id is not None:
            row.algorithm_id = algorithm_id
        if run_config is not None:
            row.run_config_json = json.dumps(run_config, ensure_ascii=False)
        session.flush()
        try:
            cfg = json.loads(row.run_config_json or "{}")
        except json.JSONDecodeError:
            cfg = {}
        return PresetRecord(
            id=row.id,
            label=row.label,
            backbone=row.backbone,
            algorithm_id=row.algorithm_id,
            run_config=cfg if isinstance(cfg, dict) else {},
        )


def delete_preset(preset_id: str) -> bool:
    with db_session_scope() as session:
        row = session.get(RunPreset, preset_id)
        if row is None:
            return False
        session.delete(row)
        return True

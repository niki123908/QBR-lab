"""Project Energy results in PostgreSQL; never transfer Q-tables for list views."""
from types import SimpleNamespace
from sqlalchemy import func, text
from app.models import EnergyRun


def summary_result():
    r = EnergyRun.result
    episode_summary = lambda name: func.json_build_object(
        "delay", r[name]["delay"], "completed", r[name]["completed"],
        "truncated", r[name]["truncated"], "total_reward", r[name]["total_reward"])
    fallback = func.json_build_object(
        "last", episode_summary("last"), "best", episode_summary("best"),
        "has_best", r["best"]["delay"].as_integer().is_not(None),
        "runtime_sec", r["runtime_sec"], "total_states", r["total_states"],
        "total_state_actions", r["total_state_actions"], "resolved_energy", r["resolved_energy"],
        "completed_episodes", text("(SELECT count(*) FROM json_array_elements(energy_runs.result->'episodes') AS e WHERE e->>'completed' = 'true')"))

    return func.coalesce(func.nullif(EnergyRun.payload["result_summary"].as_string(), "null").cast(EnergyRun.result.type), fallback)


def compact_result(result):
    return {**{k: result.get(k) for k in ("runtime_sec", "total_states", "total_state_actions", "resolved_energy")},
        "last": {k:(result.get("last") or {}).get(k) for k in ("delay", "completed", "truncated", "total_reward")},
        "best": {k:(result.get("best") or {}).get(k) for k in ("delay", "completed", "truncated", "total_reward")},
        "has_best": bool(result.get("best")),
        "delay_series": [e["delay"] if e["completed"] else None for e in result.get("episodes", [])],
        "completed_episodes": sum(e["completed"] for e in result.get("episodes", []))}


def read_runs(session, statement, *, fields=None, episodes=False):
    if fields is None:
        projection = summary_result()
        if episodes:
            from sqlalchemy import cast
            from sqlalchemy.dialects.postgresql import JSONB
            projection = cast(cast(projection, JSONB).op("||")(func.jsonb_build_object("episodes", EnergyRun.result["episodes"])), EnergyRun.result.type)
    else:
        projection = func.json_build_object(*[item for key in fields for item in (key, EnergyRun.result[key])])
    columns = [column for column in EnergyRun.__table__.columns if column.name != "result"]
    query = statement.with_only_columns(*columns, projection.label("result"))
    return [SimpleNamespace(**row) for row in session.execute(query).mappings()]

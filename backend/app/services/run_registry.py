import random as py_random
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable

from app.services.runners.base import AlgorithmRunner
from app.services.runners.cf_cas_runner import execute_cf_cas
from app.services.runners.greedy_runner import execute_greedy
from app.services.runners.qbr_runner import execute_qbr


ConfigResolver = Callable[[dict[str, Any], str, dict[str, Any] | None], dict[str, Any]]


@dataclass(frozen=True)
class AlgorithmSpec:
    runner: AlgorithmRunner
    resolve_and_validate_config: ConfigResolver


_QBR_DEFAULT_CONFIG: dict[str, Any] = {
    "episodes": 1000,
    "alpha": 0.2,
    "gamma": 0.8,
    "policy_type": "epsilon_greedy",
    "epsilon_start": 1.0,
    "epsilon_end": 0.01,
    "epsilon_decay": 0.001,
    "temperature_start": 1.0,
    "temperature_start_mode": "manual",
    "temperature_start_multiplier": 0.01,
    "temperature_end": 0.1,
    "temperature_decay": 0.001,
    "temperature_decay_mode": "linear",
    "ucb_c": 1.414,
    "action_axis": "broadcaster",
    "spread_mode": "normal",
    "completion_bonus_multiplier": 1.0,
    "coverage_reward_enabled": True,
    "lambda_param": 0.0,
    "trace_threshold": 0.01,
    "action_aggregation_mode": "off",
}

_QBR_CONFIG_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "episodes": {"type": "integer", "minimum": 1, "default": 1000},
        "alpha": {"type": "number", "minimum": 0.0, "maximum": 1.0, "default": 0.2},
        "gamma": {"type": "number", "minimum": 0.0, "maximum": 1.0, "default": 0.8},
        "policy_type": {"type": "string", "enum": ["epsilon_greedy", "softmax", "ucb"], "default": "epsilon_greedy"},
        "action_axis": {"type": "string", "enum": ["broadcaster", "receiver"], "default": "broadcaster"},
        "spread_mode": {"type": "string", "enum": ["normal", "la"], "default": "normal"},
        "epsilon_start": {"type": "number", "minimum": 0.0, "maximum": 1.0, "default": 1.0},
        "epsilon_end": {"type": "number", "minimum": 0.0, "maximum": 1.0, "default": 0.01},
        "epsilon_decay": {"type": "number", "minimum": 0.0, "default": 0.001},
        "temperature_start": {"type": "number", "exclusiveMinimum": 0.0, "default": 1.0},
        "temperature_start_mode": {
            "type": "string",
            "enum": ["manual", "node_count_multiplier"],
            "default": "manual",
        },
        "temperature_start_multiplier": {"type": "number", "exclusiveMinimum": 0.0, "default": 0.01},
        "temperature_end": {"type": "number", "exclusiveMinimum": 0.0, "default": 0.1},
        "temperature_decay": {"type": "number", "minimum": 0.0, "default": 0.001},
        "temperature_decay_mode": {"type": "string", "enum": ["linear", "multiplicative"], "default": "linear"},
        "ucb_c": {"type": "number", "exclusiveMinimum": 0.0, "default": 1.414},
        "completion_bonus_multiplier": {"type": "number", "minimum": 0.0, "default": 1.0},
        "coverage_reward_enabled": {"type": "boolean", "default": True},
        "lambda_param": {"type": "number", "minimum": 0.0, "maximum": 1.0, "default": 0.0},
        "trace_threshold": {"type": "number", "minimum": 0.0, "default": 0.01},
        "action_aggregation_mode": {
            "type": "string",
            "enum": ["off", "exact_next_state", "incremental_merge"],
            "default": "off",
        },
    },
    "required": [],
}

_QBR_CAPABILITIES: dict[str, bool] = {
    "has_q_table": True,
    "has_policy_trace": True,
    "has_state_action_trace": True,
    "has_transmission_trace": True,
    "has_episode_series": True,
    "has_epoch_compare": True,
    "has_path_signatures": True,
}

_GREEDY_DEFAULT_CONFIG: dict[str, Any] = {
    "action_axis": "broadcaster",
    "spread_mode": "normal",
}

_GREEDY_CONFIG_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "action_axis": {"type": "string", "enum": ["broadcaster", "receiver"], "default": "broadcaster"},
        "spread_mode": {"type": "string", "enum": ["normal", "la"], "default": "normal"},
    },
    "required": [],
}

_RUN_CONFIG_META_KEYS = frozenset({"run_seed"})


def _pick_allowed_config(merged: dict[str, Any], allowed_keys: set[str]) -> dict[str, Any]:
    return {key: merged[key] for key in merged if key in allowed_keys}


def allocate_unique_run_seed() -> int:
    return py_random.randint(1, 9_999_999)


def _resolve_run_seed_value(merged: dict[str, Any]) -> int:
    raw = merged.get("run_seed")
    if raw is None:
        return allocate_unique_run_seed()
    try:
        seed = int(raw)
    except (TypeError, ValueError):
        raise ValueError("Failed.") from None
    if not (0 <= seed <= 9_999_999):
        raise ValueError("Failed.")
    return seed


_GREEDY_CAPABILITIES: dict[str, bool] = {
    "has_q_table": False,
    "has_policy_trace": False,
    "has_state_action_trace": True,
    "has_transmission_trace": True,
    "has_episode_series": False,
    "has_epoch_compare": False,
    "has_path_signatures": False,
}

_CF_CAS_DEFAULT_CONFIG: dict[str, Any] = {}

_CF_CAS_CONFIG_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {},
    "required": [],
}

_CF_CAS_CAPABILITIES: dict[str, bool] = dict(_GREEDY_CAPABILITIES)


def _resolve_qbr_config(
    run_config: dict[str, Any], preset_id: str, topology_context: dict[str, Any] | None = None
) -> dict[str, Any]:
    preset: dict[str, Any] = {}
    if preset_id == "default_v1":
        preset = {}

    merged = {**_QBR_DEFAULT_CONFIG, **preset, **(run_config or {})}
    allowed_keys = set(_QBR_DEFAULT_CONFIG.keys()) | _RUN_CONFIG_META_KEYS
    unknown_keys = [key for key in merged.keys() if key not in allowed_keys]
    if unknown_keys:
        raise ValueError("Failed.")

    try:
        episodes = int(merged["episodes"])
        alpha = float(merged["alpha"])
        gamma = float(merged["gamma"])
        policy_type = str(merged["policy_type"])
        epsilon_start = float(merged["epsilon_start"])
        epsilon_end = float(merged["epsilon_end"])
        epsilon_decay = float(merged["epsilon_decay"])
        temperature_start_mode = str(merged["temperature_start_mode"])
        temperature_start = float(merged["temperature_start"])
        temperature_start_multiplier = float(merged["temperature_start_multiplier"])
        temperature_end = float(merged["temperature_end"])
        temperature_decay = float(merged["temperature_decay"])
        temperature_decay_mode = str(merged["temperature_decay_mode"])
        action_axis = str(merged["action_axis"])
        spread_mode = str(merged["spread_mode"])
        completion_bonus_multiplier = float(merged["completion_bonus_multiplier"])
        raw_coverage_reward_enabled = merged["coverage_reward_enabled"]
        lambda_param = float(merged["lambda_param"])
        trace_threshold = float(merged["trace_threshold"])
        ucb_c = float(merged["ucb_c"])
        action_aggregation_mode = str(merged["action_aggregation_mode"])
    except (TypeError, ValueError):
        raise ValueError("Failed.") from None

    if episodes <= 0:
        raise ValueError("Failed.")
    if episodes > 100_000:
        raise ValueError("Failed.")
    if not (0.0 <= alpha <= 1.0):
        raise ValueError("Failed.")
    if not (0.0 <= gamma <= 1.0):
        raise ValueError("Failed.")
    if policy_type not in {"epsilon_greedy", "softmax", "ucb"}:
        raise ValueError("Failed.")
    if temperature_start_mode not in {"manual", "node_count_multiplier"}:
        raise ValueError("Failed.")
    if temperature_decay_mode not in {"linear", "multiplicative"}:
        raise ValueError("Failed.")
    if action_axis not in {"broadcaster", "receiver"}:
        raise ValueError("Failed.")
    if spread_mode not in {"normal", "la"}:
        raise ValueError("Failed.")
    if action_aggregation_mode not in {"off", "exact_next_state", "incremental_merge"}:
        raise ValueError("Failed.")
    if completion_bonus_multiplier < 0.0:
        raise ValueError("Failed.")
    if isinstance(raw_coverage_reward_enabled, bool):
        coverage_reward_enabled = raw_coverage_reward_enabled
    elif isinstance(raw_coverage_reward_enabled, str):
        lowered = raw_coverage_reward_enabled.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            coverage_reward_enabled = True
        elif lowered in {"0", "false", "no", "off"}:
            coverage_reward_enabled = False
        else:
            raise ValueError("Failed.")
    else:
        coverage_reward_enabled = bool(raw_coverage_reward_enabled)
    if not (0.0 <= lambda_param <= 1.0):
        raise ValueError("Failed.")
    if trace_threshold < 0.0:
        raise ValueError("Failed.")

    if policy_type == "epsilon_greedy":
        if not (0.0 <= epsilon_start <= 1.0):
            raise ValueError("Failed.")
        if not (0.0 <= epsilon_end <= 1.0):
            raise ValueError("Failed.")
        if epsilon_start < epsilon_end:
            raise ValueError("Failed.")
        if epsilon_decay < 0.0:
            raise ValueError("Failed.")
    elif policy_type == "softmax":
        if temperature_start_mode == "node_count_multiplier":
            if temperature_start_multiplier <= 0.0:
                raise ValueError("Failed.")
            node_count = topology_context.get("node_count") if isinstance(topology_context, dict) else None
            try:
                node_count = int(node_count)
            except (TypeError, ValueError):
                raise ValueError("Failed.") from None
            if node_count <= 0:
                raise ValueError("Failed.")
            temperature_start = float(temperature_start_multiplier) * float(node_count)
        if temperature_start <= 0.0:
            raise ValueError("Failed.")
        if temperature_end <= 0.0:
            raise ValueError("Failed.")
        if temperature_decay_mode == "linear":
            if temperature_start < temperature_end:
                raise ValueError("Failed.")
            if temperature_decay < 0.0:
                raise ValueError("Failed.")
        else:
            if temperature_decay <= 0.0:
                raise ValueError("Failed.")
            if temperature_decay > 1.0:
                raise ValueError("Failed.")
    else:
        if ucb_c <= 0.0:
            raise ValueError("Failed.")

    run_seed = _resolve_run_seed_value(merged)

    return {
        "episodes": episodes,
        "alpha": alpha,
        "gamma": gamma,
        "policy_type": policy_type,
        "epsilon_start": epsilon_start,
        "epsilon_end": epsilon_end,
        "epsilon_decay": epsilon_decay,
        "temperature_start": temperature_start,
        "temperature_start_mode": temperature_start_mode,
        "temperature_start_multiplier": temperature_start_multiplier,
        "temperature_end": temperature_end,
        "temperature_decay": temperature_decay,
        "temperature_decay_mode": temperature_decay_mode,
        "ucb_c": ucb_c,
        "action_axis": action_axis,
        "spread_mode": spread_mode,
        "completion_bonus_multiplier": completion_bonus_multiplier,
        "coverage_reward_enabled": coverage_reward_enabled,
        "lambda_param": lambda_param,
        "trace_threshold": trace_threshold,
        "action_aggregation_mode": action_aggregation_mode,
        "run_seed": run_seed,
    }


def _resolve_greedy_config(
    run_config: dict[str, Any], preset_id: str, topology_context: dict[str, Any] | None = None
) -> dict[str, Any]:
    _ = topology_context
    preset: dict[str, Any] = {}
    if preset_id == "default_v1":
        preset = {}

    merged = {**_GREEDY_DEFAULT_CONFIG, **preset, **(run_config or {})}
    allowed_keys = set(_GREEDY_DEFAULT_CONFIG.keys()) | _RUN_CONFIG_META_KEYS
    picked = _pick_allowed_config(merged, allowed_keys)
    action_axis = str(picked.get("action_axis", "broadcaster"))
    spread_mode = str(picked.get("spread_mode", "normal"))
    if action_axis not in {"broadcaster", "receiver"}:
        raise ValueError("Failed.")
    if spread_mode not in {"normal", "la"}:
        raise ValueError("Failed.")
    run_seed = _resolve_run_seed_value(picked)
    return {
        "action_axis": action_axis,
        "spread_mode": spread_mode,
        "run_seed": run_seed,
    }


def _resolve_cf_cas_config(
    run_config: dict[str, Any], preset_id: str, topology_context: dict[str, Any] | None = None
) -> dict[str, Any]:
    _ = topology_context
    preset: dict[str, Any] = {}
    if preset_id == "default_v1":
        preset = {}

    merged = {**_CF_CAS_DEFAULT_CONFIG, **preset, **(run_config or {})}
    allowed_keys = set(_CF_CAS_DEFAULT_CONFIG.keys()) | _RUN_CONFIG_META_KEYS
    picked = _pick_allowed_config(merged, allowed_keys)
    run_seed = _resolve_run_seed_value(picked)
    return {"run_seed": run_seed}


_ALGORITHM_SPECS: dict[str, AlgorithmSpec] = {
    "qbr": AlgorithmSpec(
        runner=execute_qbr,
        resolve_and_validate_config=_resolve_qbr_config,
    ),
    "greedy": AlgorithmSpec(
        runner=execute_greedy,
        resolve_and_validate_config=_resolve_greedy_config,
    ),
    "cf_cas": AlgorithmSpec(
        runner=execute_cf_cas,
        resolve_and_validate_config=_resolve_cf_cas_config,
    ),
}


_ALGORITHMS_METADATA: list[dict[str, Any]] = [
    {
        "algorithm_id": "qbr",
        "display_name": "QBR",
        "version": "v1",
        "default_config": _QBR_DEFAULT_CONFIG,
        "config_schema": _QBR_CONFIG_SCHEMA,
        "capabilities": _QBR_CAPABILITIES,
    },
    {
        "algorithm_id": "greedy",
        "display_name": "GREEDY",
        "version": "v1",
        "default_config": _GREEDY_DEFAULT_CONFIG,
        "config_schema": _GREEDY_CONFIG_SCHEMA,
        "capabilities": _GREEDY_CAPABILITIES,
    },
    {
        "algorithm_id": "cf_cas",
        "display_name": "CF-CAS",
        "version": "v1",
        "default_config": _CF_CAS_DEFAULT_CONFIG,
        "config_schema": _CF_CAS_CONFIG_SCHEMA,
        "capabilities": _CF_CAS_CAPABILITIES,
    },
]


def get_algorithm_runner(algorithm_id: str) -> AlgorithmRunner:
    spec = _ALGORITHM_SPECS.get(algorithm_id)
    if spec is None:
        raise ValueError("Failed.")
    return spec.runner


def resolve_and_validate_run_config(
    algorithm_id: str,
    preset_id: str,
    run_config: dict[str, Any],
    topology_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spec = _ALGORITHM_SPECS.get(algorithm_id)
    if spec is None:
        raise ValueError("Failed.")
    return spec.resolve_and_validate_config(run_config, preset_id, topology_context)


def list_algorithms() -> list[dict[str, Any]]:
    return deepcopy(_ALGORITHMS_METADATA)

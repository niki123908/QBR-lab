import { useMemo, useState } from "react";
import { buildRunConfigResultFromResolved, mergeDisplayConfig } from "../utils/runConfigDisplay.js";
import { BatchPolicyTraceCard } from "./BatchResultDetailBody.jsx";
import RunConfigVisibilityTable from "./RunConfigVisibilityTable.jsx";
import PolicyTraceLineChart from "./PolicyTraceLineChart.jsx";

import { API_BASE } from "../apiBase.js";

function normalizeFieldValue(rawValue, schemaType) {
  if (schemaType === "boolean") return Boolean(rawValue);
  if (schemaType === "integer") {
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  if (schemaType === "number") {
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return rawValue;
}

function formatConfigLabel(fieldName) {
  if (fieldName === "export_q_table_all_epoch") return "Export q table of all epoch";
  if (fieldName === "action_axis") return "Action axis";
  if (fieldName === "policy_type") return "Policy type";
  if (fieldName === "lambda_param") return "Lambda (λ)";
  if (fieldName === "trace_threshold") return "Trace threshold";
  if (fieldName === "action_aggregation_mode") return "Action aggregation";
  if (fieldName === "completion_bonus_multiplier") return "Completion bonus multiplier";
  if (fieldName === "coverage_reward_enabled") return "Enable coverage reward (nodes covered / timeslot)";
  if (fieldName === "temperature_decay_mode") return "Temperature decay mode";
  if (fieldName === "epsilon_start") return "Epsilon start";
  if (fieldName === "epsilon_end") return "Epsilon end";
  if (fieldName === "epsilon_decay") return "Epsilon decay";
  if (fieldName === "ucb_c") return "UCB exploration constant (c)";
  return fieldName;
}

function formatEnumOptionLabel(fieldName, option) {
  if (fieldName === "action_axis") {
    if (option === "broadcaster") return "Broadcaster";
    if (option === "receiver") return "Receiver";
  }
  if (fieldName === "spread_mode") {
    if (option === "normal") return "Normal";
    if (option === "la") return "Latency ahead";
  }
  if (fieldName === "policy_type" && option === "ucb") return "UCB";
  if (fieldName === "action_aggregation_mode") {
    if (option === "off") return "Off";
    if (option === "exact_next_state") return "Exact next state";
    if (option === "incremental_merge") return "Incremental merge";
  }
  return option;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const BACKBONE_OPTIONS = [
  { id: "qbr", label: "QBR" },
  { id: "greedy", label: "GREEDY" },
  { id: "cf_cas", label: "CF-CAS" }
];

function presetOptionLabel(p) {
  if (!p || typeof p !== "object") return "";
  const tag =
    p.backbone === "qbr"
      ? "QBR"
      : p.backbone === "greedy"
        ? "GREEDY"
        : p.backbone === "cf_cas"
          ? "CF-CAS"
          : String(p.backbone || "");
  return `${p.label} · ${tag}`;
}

const IDLE_PRESET_WIZARD = { phase: "idle", draftClientId: "", snapshot: null };

function sortPresetsAlphabetically(presets) {
  function buildSortMeta(label) {
    const normalized = String(label ?? "")
      .toLowerCase()
      .replace(/[()]/g, " ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const parts = normalized.split("_").filter(Boolean);
    const hasEt = parts.includes("et");
    const hasFinal = parts.includes("final");
    const baseParts = parts.filter((part) => part !== "et" && part !== "final");
    return {
      baseGroup: baseParts.join("_"),
      variantRank: hasEt ? 1 : 0,
      finalRank: hasFinal ? 1 : 0,
      normalized
    };
  }

  return [...(presets ?? [])].sort((a, b) => {
    const aMeta = buildSortMeta(a?.label);
    const bMeta = buildSortMeta(b?.label);
    if (aMeta.baseGroup !== bMeta.baseGroup) {
      return aMeta.baseGroup.localeCompare(bMeta.baseGroup, undefined, { sensitivity: "base" });
    }
    if (aMeta.variantRank !== bMeta.variantRank) {
      return aMeta.variantRank - bMeta.variantRank;
    }
    if (aMeta.finalRank !== bMeta.finalRank) {
      return aMeta.finalRank - bMeta.finalRank;
    }
    return aMeta.normalized.localeCompare(bMeta.normalized, undefined, { sensitivity: "base" });
  });
}

const POLICY_AXIS_FIELDS = new Set(["policy_type", "action_axis"]);

/** Logical groups for run-config fields (order preserved within each block). */
const CONFIG_FIELD_BLOCKS = [
  { id: "training", title: "Training", fields: ["episodes"] },
  { id: "rl_core", title: "RL core", fields: ["alpha", "gamma"] },
  { id: "policy", title: "Policy & actions", fields: ["policy_type", "action_axis", "spread_mode"] },
  { id: "epsilon", title: "ε-greedy", fields: ["epsilon_start", "epsilon_end", "epsilon_decay"] },
  { id: "ucb", title: "UCB", fields: ["ucb_c"] },
  { id: "decay", title: "Decay schedule", fields: ["temperature_decay_mode"] },
  {
    id: "temperature",
    title: "Softmax temperature",
    fields: ["temperature_start", "temperature_end", "temperature_decay"]
  },
  {
    id: "reward",
    title: "Reward & trace",
    fields: ["coverage_reward_enabled", "completion_bonus_multiplier", "lambda_param", "trace_threshold"]
  },
  { id: "artifacts", title: "Artifacts", fields: ["export_q_table_all_epoch"] }
];

function groupConfigFieldNames(fieldNames) {
  const nameSet = new Set(fieldNames);
  const used = new Set();
  const blocks = [];
  CONFIG_FIELD_BLOCKS.forEach((def) => {
    const fields = def.fields.filter((f) => nameSet.has(f));
    if (!fields.length) return;
    fields.forEach((f) => used.add(f));
    blocks.push({ id: def.id, title: def.title, fields });
  });
  const other = fieldNames.filter((f) => !used.has(f));
  if (other.length) {
    blocks.push({ id: "other", title: "Other", fields: other });
  }
  return blocks;
}

function renderConfigField(fieldName, fieldSchema, runConfigForm, setRunConfigForm) {
  const rawType = fieldSchema?.type;
  const resolvedType = Array.isArray(rawType) ? rawType.find((t) => t !== "null") || "string" : rawType || "string";
  const currentValue = runConfigForm?.[fieldName];

  if (resolvedType === "boolean") {
    const isCoverageRewardToggle = fieldName === "coverage_reward_enabled";
    const checkedValue = isCoverageRewardToggle ? currentValue !== false : Boolean(currentValue);
    return (
      <label className="field-label inline-checkbox" key={fieldName}>
        <span>{formatConfigLabel(fieldName)}</span>
        <input
          type="checkbox"
          checked={checkedValue}
          onChange={(e) =>
            setRunConfigForm((prev) => ({
              ...prev,
              [fieldName]: e.target.checked
            }))
          }
        />
      </label>
    );
  }

  const enumOptions = Array.isArray(fieldSchema?.enum) ? fieldSchema.enum : null;
  if (resolvedType === "string" && enumOptions && enumOptions.length > 0) {
    const currentEnumValue = String(currentValue ?? enumOptions[0]);
    if (enumOptions.length === 2) {
      return (
        <label className="field-label" key={fieldName}>
          {formatConfigLabel(fieldName)}
          <div className="segmented-toggle segmented-toggle--dense">
            {enumOptions.map((option) => {
              const optionValue = String(option);
              return (
                <button
                  key={optionValue}
                  type="button"
                  className={`segment-btn ${currentEnumValue === optionValue ? "active" : ""}`}
                  onClick={() =>
                    setRunConfigForm((prev) => ({
                      ...prev,
                      [fieldName]: option
                    }))
                  }
                >
                  {formatEnumOptionLabel(fieldName, option)}
                </button>
              );
            })}
          </div>
        </label>
      );
    }
    return (
      <label className="field-label" key={fieldName}>
        {formatConfigLabel(fieldName)}
        <select
          value={currentEnumValue}
          onChange={(e) =>
            setRunConfigForm((prev) => ({
              ...prev,
              [fieldName]: e.target.value
            }))
          }
        >
          {enumOptions.map((option) => (
            <option key={option} value={option}>
              {formatEnumOptionLabel(fieldName, option)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const inputType = resolvedType === "integer" || resolvedType === "number" ? "number" : "text";
  return (
    <label className="field-label" key={fieldName}>
      {formatConfigLabel(fieldName)}
      <input
        type={inputType}
        value={currentValue ?? ""}
        onChange={(e) =>
          setRunConfigForm((prev) => ({
            ...prev,
            [fieldName]: normalizeFieldValue(e.target.value, resolvedType)
          }))
        }
      />
    </label>
  );
}

function resolveBackboneId(algorithmId) {
  if (algorithmId === "qbr") return "qbr";
  if (algorithmId === "greedy") return "greedy";
  return String(algorithmId || "");
}

function filterEntriesByPolicy(schemaEntries, policyType) {
  return schemaEntries.filter(([fieldName]) => {
    const isEpsilonField = ["epsilon_start", "epsilon_end", "epsilon_decay"].includes(fieldName);
    const isTemperatureField = [
      "temperature_start",
      "temperature_start_mode",
      "temperature_start_multiplier",
      "temperature_end",
      "temperature_decay",
      "temperature_decay_mode"
    ].includes(fieldName);
    const isUcbField = fieldName === "ucb_c";
    if (policyType === "softmax" && isEpsilonField) return false;
    if (policyType === "softmax" && isUcbField) return false;
    if (policyType === "epsilon_greedy" && isTemperatureField) return false;
    if (policyType === "epsilon_greedy" && isUcbField) return false;
    if (policyType === "ucb" && isEpsilonField) return false;
    if (policyType === "ucb" && isTemperatureField) return false;
    return true;
  });
}

function DynamicConfigGrid({ schemaEntries, runConfigForm, setRunConfigForm }) {
  if (!schemaEntries.length) return null;
  const selectedPolicyType = String(runConfigForm?.policy_type ?? "epsilon_greedy");
  const temperatureStartMode = String(runConfigForm?.temperature_start_mode ?? "manual");
  const visibleEntries = schemaEntries.filter(([fieldName]) => {
    if (fieldName === "temperature_start_mode" || fieldName === "temperature_start_multiplier") return false;
    if (fieldName === "temperature_start") return !(selectedPolicyType === "softmax" && temperatureStartMode === "node_count_multiplier");
    return true;
  });
  const schemaByName = Object.fromEntries(visibleEntries);
  const fieldNames = visibleEntries.map(([name]) => name);
  const blocks = groupConfigFieldNames(fieldNames);

  const softmaxExtras =
    selectedPolicyType === "softmax" ? (
      <>
        <label className="field-label">
          Temperature start mode
          <div className="segmented-toggle segmented-toggle--dense">
            <button
              type="button"
              className={`segment-btn ${temperatureStartMode === "manual" ? "active" : ""}`}
              onClick={() =>
                setRunConfigForm((prev) => ({
                  ...prev,
                  temperature_start_mode: "manual"
                }))
              }
            >
              Manual
            </button>
            <button
              type="button"
              className={`segment-btn ${temperatureStartMode === "node_count_multiplier" ? "active" : ""}`}
              onClick={() =>
                setRunConfigForm((prev) => ({
                  ...prev,
                  temperature_start_mode: "node_count_multiplier"
                }))
              }
            >
              By node count
            </button>
          </div>
        </label>
        {temperatureStartMode === "node_count_multiplier" ? (
          <label className="field-label">
            Temperature multiplier
            <input
              type="number"
              step="0.001"
              min="0.001"
              value={runConfigForm?.temperature_start_multiplier ?? ""}
              onChange={(e) =>
                setRunConfigForm((prev) => ({
                  ...prev,
                  temperature_start_multiplier: normalizeFieldValue(e.target.value, "number")
                }))
              }
            />
          </label>
        ) : null}
      </>
    ) : null;

  return (
    <div className="dynamic-config-blocks">
      {blocks.map((block) => (
        <section key={block.id} className={`config-field-block config-field-block--${block.id}`}>
          <h5 className="config-field-block__title">{block.title}</h5>
          <div className="config-field-block__fields">
            {block.fields.map((fieldName) =>
              renderConfigField(fieldName, schemaByName[fieldName], runConfigForm, setRunConfigForm)
            )}
            {block.id === "temperature" ? softmaxExtras : null}
          </div>
        </section>
      ))}
    </div>
  );
}

function RunSeedField({ form, setForm }) {
  return (
    <label className="field-label">
      Run RNG seed
      <div className="seed-toggle-row">
        <input
          type="checkbox"
          checked={Boolean(form.use_run_seed)}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              use_run_seed: e.target.checked
            }))
          }
          title="Use a fixed seed for action randomness during training"
        />
        <input
          type="number"
          min={0}
          max={9999999}
          step={1}
          disabled={!form.use_run_seed}
          value={form.run_seed ?? 2026}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              run_seed: Math.max(0, Math.trunc(Number(e.target.value) || 0))
            }))
          }
        />
      </div>
      <small className="muted">
        {form.use_run_seed ? "Fixed seed — same config can reproduce random actions." : "Auto — server assigns a unique seed per run."}
      </small>
    </label>
  );
}

function RunTopologyPanel({
  form,
  setForm,
  selectedTopology,
  onRun,
  isRunningSingle,
  selectedAlgorithmMeta,
  runConfigForm,
  setRunConfigForm,
  runPresets,
  loadRunPresets,
  setMessage,
  parseApiError,
  presetWizard,
  setPresetWizard,
  algorithmDefaultConfigById,
  setSharedRunConfigForBackbone,
  runBackbone
}) {
  const currentBackbone = runBackbone;
  const sortedRunPresets = useMemo(() => sortPresetsAlphabetically(runPresets), [runPresets]);
  const selectedPreset = useMemo(
    () => sortedRunPresets.find((p) => p.id === form.preset_id) ?? null,
    [sortedRunPresets, form.preset_id]
  );
  const phase = presetWizard.phase;

  const schemaProperties = selectedAlgorithmMeta?.config_schema?.properties ?? {};
  const allEntries = Object.entries(schemaProperties);
  const selectedPolicyType = String(runConfigForm?.policy_type ?? "epsilon_greedy");
  const policyEntries = allEntries.filter(([k]) => POLICY_AXIS_FIELDS.has(k));
  const hyperEntriesRaw = allEntries.filter(([k]) => !POLICY_AXIS_FIELDS.has(k));
  const hyperEntries = filterEntriesByPolicy(hyperEntriesRaw, selectedPolicyType);
  const idleConfigEntries = filterEntriesByPolicy(allEntries, selectedPolicyType);

  function applyOfficialPreset(preset) {
    if (!preset) return;
    setPresetWizard(IDLE_PRESET_WIZARD);
    setForm((prev) => ({
      ...prev,
      algorithm_id: preset.algorithm_id,
      preset_id: preset.id,
      preset_name: preset.label
    }));
    setSharedRunConfigForBackbone(preset.backbone, { ...(preset.run_config ?? {}) });
  }

  function onIdleBackboneChange(backboneId) {
    const algorithm_id = backboneId;
    const list = sortedRunPresets.filter((p) => p.backbone === backboneId);
    const pick = list[0] ?? null;
    setForm((prev) => ({
      ...prev,
      algorithm_id,
      preset_id: pick?.id ?? "default_v1",
      preset_name: pick?.label ?? "default_v1"
    }));
    if (pick) {
      setSharedRunConfigForBackbone(backboneId, { ...(pick.run_config ?? {}) });
    } else {
      setSharedRunConfigForBackbone(backboneId, { ...(algorithmDefaultConfigById[algorithm_id] ?? {}) });
    }
  }

  function startWizard() {
    setPresetWizard({
      phase: "add_backbone",
      draftClientId: `draft:${Date.now()}`,
      snapshot: {
        form: { ...form },
        backbone: currentBackbone,
        runConfig: { ...runConfigForm }
      }
    });
  }

  function cancelWizard() {
    const snap = presetWizard.snapshot;
    if (snap?.form) {
      setForm(snap.form);
    }
    if (snap && snap.backbone !== undefined && snap.backbone !== null) {
      setSharedRunConfigForBackbone(snap.backbone, { ...(snap.runConfig ?? {}) });
    }
    setPresetWizard(IDLE_PRESET_WIZARD);
  }

  function onWizardBackbonePick(backboneId) {
    const algorithm_id = backboneId;
    const defaults = { ...(algorithmDefaultConfigById[algorithm_id] ?? {}) };
    setForm((prev) => ({
      ...prev,
      algorithm_id,
      preset_id: "default_v1",
      preset_name: "draft"
    }));
    setSharedRunConfigForBackbone(backboneId, defaults);
    if (backboneId === "greedy") {
      setPresetWizard((w) => ({ ...w, phase: "add_params" }));
    } else {
      setPresetWizard((w) => ({ ...w, phase: "add_policy" }));
    }
  }

  async function saveCurrentPresetToLibrary() {
    const name = window.prompt("Tên preset (lưu vào thư viện):");
    const clean = name?.trim();
    if (!clean) return;
    const snapshot = { ...(runConfigForm ?? {}) };
    try {
      const res = await fetch(`${API_BASE}/presets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: clean,
          backbone: currentBackbone,
          algorithm_id: form.algorithm_id,
          run_config: snapshot
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      setPresetWizard(IDLE_PRESET_WIZARD);
      await loadRunPresets();
      if (data && data.id) {
        applyOfficialPreset(data);
      }
    } catch {
      setMessage("Failed.");
    }
  }

  async function saveDirtyOfficialPreset() {
    if (!selectedPreset) return;
    const snapshot = { ...(runConfigForm ?? {}) };
    try {
      const res = await fetch(`${API_BASE}/presets/${selectedPreset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_config: snapshot,
          algorithm_id: form.algorithm_id,
          backbone: currentBackbone
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      void data;
      await loadRunPresets();
    } catch {
      setMessage("Failed.");
    }
  }

  async function renameOfficialPreset() {
    if (!selectedPreset) return;
    const name = window.prompt("Đổi tên preset:", selectedPreset.label);
    const clean = name?.trim();
    if (!clean) return;
    try {
      const res = await fetch(`${API_BASE}/presets/${selectedPreset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: clean })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      setForm((prev) => ({ ...prev, preset_name: clean }));
      void data;
      await loadRunPresets();
    } catch {
      setMessage("Failed.");
    }
  }

  async function deleteOfficialPreset() {
    if (!selectedPreset) return;
    const confirmed = window.confirm(`Xóa preset «${selectedPreset.label}»?`);
    if (!confirmed) return;
    try {
      const res = await fetch(`${API_BASE}/presets/${selectedPreset.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      void data;
      const list = await loadRunPresets();
      const fallback = list[0] ?? null;
      if (fallback) {
        applyOfficialPreset(fallback);
      } else {
        setForm((prev) => ({ ...prev, preset_id: "default_v1", preset_name: "default_v1" }));
        setSharedRunConfigForBackbone(currentBackbone, { ...(algorithmDefaultConfigById[form.algorithm_id] ?? {}) });
      }
    } catch {
      setMessage("Failed.");
    }
  }

  const presetSelectValue = sortedRunPresets.some((p) => p.id === form.preset_id) ? form.preset_id : "";

  const showIdleFullConfig = phase === "idle" && sortedRunPresets.length > 0;
  const showWizardPolicy = phase === "add_policy";
  const showWizardParams = phase === "add_params";
  const runBlocked = phase === "add_backbone";

  return (
    <form
      className="control-form"
      onSubmit={(event) => {
        event.preventDefault();
        onRun();
      }}
    >
      <h4>Run topology</h4>
      <label className="field-label">
        Selected topology
        <input type="text" value={selectedTopology?.topology_name ?? ""} disabled placeholder="Choose a topology" />
      </label>

      <div className="preset-zone">
        {phase !== "idle" ? (
          <>
            <p className="preset-banner">Đang tạo preset nháp</p>
            {phase === "add_backbone" ? (
      <label className="field-label">
                Backbone
                <div className="segmented-toggle segmented-toggle--dense">
                  {BACKBONE_OPTIONS.map((o) => (
                    <button key={o.id} type="button" className="segment-btn" onClick={() => onWizardBackbonePick(o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
      </label>
            ) : null}
            {showWizardPolicy ? (
              <>
                <DynamicConfigGrid
                  schemaEntries={policyEntries}
                  runConfigForm={runConfigForm}
                  setRunConfigForm={setRunConfigForm}
                />
                <div className="preset-actions">
                  <button type="button" className="secondary-cta" onClick={() => setPresetWizard((w) => ({ ...w, phase: "add_params" }))}>
                    Tiếp tục đến tham số
                  </button>
                </div>
              </>
            ) : null}
            {showWizardParams ? (
              <>
                {hyperEntries.length > 0 ? (
                  <DynamicConfigGrid schemaEntries={hyperEntries} runConfigForm={runConfigForm} setRunConfigForm={setRunConfigForm} />
                ) : (
                  <p className="muted">Không có tham số cấu hình cho backbone này.</p>
                )}
                <div className="preset-actions">
                  <button type="button" className="secondary-cta" onClick={saveCurrentPresetToLibrary}>
                    Lưu vào thư viện
                  </button>
                </div>
              </>
            ) : null}
            <div className="preset-actions">
              <button type="button" className="secondary-cta" onClick={cancelWizard}>
                Huỷ nháp
              </button>
            </div>
          </>
        ) : sortedRunPresets.length === 0 ? (
          <>
            <p className="muted">Chưa có preset đã lưu.</p>
            <button type="button" className="secondary-cta" onClick={startWizard}>
              Thêm preset
            </button>
          </>
        ) : (
          <>
      <label className="field-label">
              Preset
              <select
                value={presetSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const p = sortedRunPresets.find((x) => x.id === v);
                  if (p) applyOfficialPreset(p);
                }}
              >
                <option value="">-- Chọn preset --</option>
                {sortedRunPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {presetOptionLabel(p)}
                  </option>
                ))}
              </select>
      </label>
            <div className="preset-actions">
              <button type="button" className="secondary-cta" onClick={startWizard}>
                Thêm
              </button>
              <button type="button" className="secondary-cta" disabled={!selectedPreset} onClick={renameOfficialPreset}>
                Đổi tên
              </button>
              <button type="button" className="secondary-cta" disabled={!selectedPreset} onClick={saveDirtyOfficialPreset}>
                Lưu
              </button>
              <button type="button" className="danger-ghost-btn" disabled={!selectedPreset} onClick={deleteOfficialPreset}>
                Xóa
              </button>
            </div>
      <label className="field-label">
              Backbone
              <div className="segmented-toggle segmented-toggle--dense">
                {BACKBONE_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={`segment-btn ${currentBackbone === o.id ? "active" : ""}`}
                    onClick={() => onIdleBackboneChange(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
      </label>
          </>
        )}
      </div>

      {showIdleFullConfig ? (
        idleConfigEntries.length > 0 ? (
          <DynamicConfigGrid schemaEntries={idleConfigEntries} runConfigForm={runConfigForm} setRunConfigForm={setRunConfigForm} />
        ) : (
          <p className="muted">No config schema for this algorithm.</p>
        )
      ) : null}

      <section className="config-field-block config-field-block--randomness">
        <h5 className="config-field-block__title">Run randomness</h5>
        <RunSeedField form={form} setForm={setForm} />
      </section>

      <button className="primary-cta" disabled={isRunningSingle || !selectedTopology || runBlocked} type="submit">
        {isRunningSingle ? "Running..." : "Run now"}
      </button>
    </form>
  );
}

function RunMultiPanel({
  form,
  setForm,
  onRun,
  isRunningBatch,
  selectedAlgorithmMeta,
  runConfigForm,
  setRunConfigForm,
  runPresets,
  loadRunPresets,
  setMessage,
  parseApiError,
  presetWizard,
  setPresetWizard,
  algorithmDefaultConfigById,
  setSharedRunConfigForBackbone,
  runBackbone,
  runMultiSubMode = "multi",
  repeatTopologyId = "",
  selectedTopology = null,
  repeatRunCount = 5,
  setRepeatRunCount
}) {
  const currentBackbone = runBackbone;
  const sortedRunPresets = useMemo(() => sortPresetsAlphabetically(runPresets), [runPresets]);
  const selectedPreset = useMemo(
    () => sortedRunPresets.find((p) => p.id === form.preset_id) ?? null,
    [sortedRunPresets, form.preset_id]
  );
  const phase = presetWizard.phase;

  const schemaProperties = selectedAlgorithmMeta?.config_schema?.properties ?? {};
  const allEntries = Object.entries(schemaProperties);
  const selectedPolicyType = String(runConfigForm?.policy_type ?? "epsilon_greedy");
  const policyEntries = allEntries.filter(([k]) => POLICY_AXIS_FIELDS.has(k));
  const hyperEntriesRaw = allEntries.filter(([k]) => !POLICY_AXIS_FIELDS.has(k));
  const hyperEntries = filterEntriesByPolicy(hyperEntriesRaw, selectedPolicyType);
  const idleConfigEntries = filterEntriesByPolicy(allEntries, selectedPolicyType);

  function applyOfficialPreset(preset) {
    if (!preset) return;
    setPresetWizard(IDLE_PRESET_WIZARD);
    setForm((prev) => ({
      ...prev,
      algorithm_id: preset.algorithm_id,
      preset_id: preset.id,
      preset_name: preset.label
    }));
    setSharedRunConfigForBackbone(preset.backbone, { ...(preset.run_config ?? {}) });
  }

  function onIdleBackboneChange(backboneId) {
    const algorithm_id = backboneId;
    const list = sortedRunPresets.filter((p) => p.backbone === backboneId);
    const pick = list[0] ?? null;
    setForm((prev) => ({
      ...prev,
      algorithm_id,
      preset_id: pick?.id ?? "default_v1",
      preset_name: pick?.label ?? "default_v1"
    }));
    if (pick) {
      setSharedRunConfigForBackbone(backboneId, { ...(pick.run_config ?? {}) });
    } else {
      setSharedRunConfigForBackbone(backboneId, { ...(algorithmDefaultConfigById[algorithm_id] ?? {}) });
    }
  }

  function startWizard() {
    setPresetWizard({
      phase: "add_backbone",
      draftClientId: `draft:${Date.now()}`,
      snapshot: {
        form: { ...form },
        backbone: currentBackbone,
        runConfig: { ...runConfigForm }
      }
    });
  }

  function cancelWizard() {
    const snap = presetWizard.snapshot;
    if (snap?.form) {
      setForm(snap.form);
    }
    if (snap && snap.backbone !== undefined && snap.backbone !== null) {
      setSharedRunConfigForBackbone(snap.backbone, { ...(snap.runConfig ?? {}) });
    }
    setPresetWizard(IDLE_PRESET_WIZARD);
  }

  function onWizardBackbonePick(backboneId) {
    const algorithm_id = backboneId;
    const defaults = { ...(algorithmDefaultConfigById[algorithm_id] ?? {}) };
    setForm((prev) => ({
      ...prev,
      algorithm_id,
      preset_id: "default_v1",
      preset_name: "draft"
    }));
    setSharedRunConfigForBackbone(backboneId, defaults);
    if (backboneId === "greedy") {
      setPresetWizard((w) => ({ ...w, phase: "add_params" }));
    } else {
      setPresetWizard((w) => ({ ...w, phase: "add_policy" }));
    }
  }

  async function saveCurrentPresetToLibrary() {
    const name = window.prompt("Tên preset (lưu vào thư viện):");
    const clean = name?.trim();
    if (!clean) return;
    const snapshot = { ...(runConfigForm ?? {}) };
    try {
      const res = await fetch(`${API_BASE}/presets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: clean,
          backbone: currentBackbone,
          algorithm_id: form.algorithm_id,
          run_config: snapshot
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      setPresetWizard(IDLE_PRESET_WIZARD);
      await loadRunPresets();
      if (data && data.id) {
        applyOfficialPreset(data);
      }
    } catch {
      setMessage("Failed.");
    }
  }

  async function saveDirtyOfficialPreset() {
    if (!selectedPreset) return;
    const snapshot = { ...(runConfigForm ?? {}) };
    try {
      const res = await fetch(`${API_BASE}/presets/${selectedPreset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_config: snapshot,
          algorithm_id: form.algorithm_id,
          backbone: currentBackbone
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      void data;
      await loadRunPresets();
    } catch {
      setMessage("Failed.");
    }
  }

  async function renameOfficialPreset() {
    if (!selectedPreset) return;
    const name = window.prompt("Đổi tên preset:", selectedPreset.label);
    const clean = name?.trim();
    if (!clean) return;
    try {
      const res = await fetch(`${API_BASE}/presets/${selectedPreset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: clean })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      setForm((prev) => ({ ...prev, preset_name: clean }));
      void data;
      await loadRunPresets();
    } catch {
      setMessage("Failed.");
    }
  }

  async function deleteOfficialPreset() {
    if (!selectedPreset) return;
    const confirmed = window.confirm(`Xóa preset «${selectedPreset.label}»?`);
    if (!confirmed) return;
    try {
      const res = await fetch(`${API_BASE}/presets/${selectedPreset.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setMessage(parseApiError(data, "Failed."));
        return;
      }
      void data;
      const list = await loadRunPresets();
      const fallback = list[0] ?? null;
      if (fallback) {
        applyOfficialPreset(fallback);
      } else {
        setForm((prev) => ({ ...prev, preset_id: "default_v1", preset_name: "default_v1" }));
        setSharedRunConfigForBackbone(currentBackbone, { ...(algorithmDefaultConfigById[form.algorithm_id] ?? {}) });
      }
    } catch {
      setMessage("Failed.");
    }
  }

  const presetSelectValue = sortedRunPresets.some((p) => p.id === form.preset_id) ? form.preset_id : "";

  const showIdleFullConfig = phase === "idle" && sortedRunPresets.length > 0;
  const showWizardPolicy = phase === "add_policy";
  const showWizardParams = phase === "add_params";
  const runBlocked = phase === "add_backbone";
  const isRepeatMode = runMultiSubMode === "repeat";
  const safeRepeatRunCount = Math.max(1, Math.min(100, Math.trunc(Number(repeatRunCount) || 0)));
  const canRunRepeat = Boolean(repeatTopologyId) && safeRepeatRunCount >= 1;
  const canRunMulti = (form.selected_topology_ids ?? []).length > 0;

  return (
    <form
      className="control-form"
      onSubmit={(event) => {
        event.preventDefault();
        onRun();
      }}
    >
      <h4>Run multi-topos</h4>
      <label className="field-label">
        Selected batch
        <input type="text" value={form.batch_id || ""} disabled placeholder="Pick batch in Panel 1" />
      </label>
      {isRepeatMode ? (
        <>
          <label className="field-label">
            Selected topology
            <input
              type="text"
              value={selectedTopology?.topology_name ?? (repeatTopologyId ? repeatTopologyId : "")}
              disabled
              placeholder="Pick one topology in Panel 1"
            />
          </label>
          <label className="field-label">
            Run count
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={safeRepeatRunCount}
              onChange={(e) => {
                const next = Math.max(1, Math.min(100, Math.trunc(Number(e.target.value) || 1)));
                if (setRepeatRunCount) setRepeatRunCount(next);
              }}
            />
          </label>
        </>
      ) : (
        <label className="field-label">
          Selected topologies
          <input type="text" value={(form.selected_topology_ids ?? []).length} disabled />
        </label>
      )}

      <div className="preset-zone">
        {phase !== "idle" ? (
          <>
            <p className="preset-banner">Đang tạo preset nháp</p>
            {phase === "add_backbone" ? (
      <label className="field-label">
                Backbone
                <div className="segmented-toggle segmented-toggle--dense">
                  {BACKBONE_OPTIONS.map((o) => (
                    <button key={o.id} type="button" className="segment-btn" onClick={() => onWizardBackbonePick(o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
      </label>
            ) : null}
            {showWizardPolicy ? (
              <>
                <DynamicConfigGrid
                  schemaEntries={policyEntries}
                  runConfigForm={runConfigForm}
                  setRunConfigForm={setRunConfigForm}
                />
                <div className="preset-actions">
                  <button type="button" className="secondary-cta" onClick={() => setPresetWizard((w) => ({ ...w, phase: "add_params" }))}>
                    Tiếp tục đến tham số
                  </button>
                </div>
              </>
            ) : null}
            {showWizardParams ? (
              <>
                {hyperEntries.length > 0 ? (
                  <DynamicConfigGrid schemaEntries={hyperEntries} runConfigForm={runConfigForm} setRunConfigForm={setRunConfigForm} />
                ) : (
                  <p className="muted">Không có tham số cấu hình cho backbone này.</p>
                )}
                <div className="preset-actions">
                  <button type="button" className="secondary-cta" onClick={saveCurrentPresetToLibrary}>
                    Lưu vào thư viện
                  </button>
                </div>
              </>
            ) : null}
            <div className="preset-actions">
              <button type="button" className="secondary-cta" onClick={cancelWizard}>
                Huỷ nháp
              </button>
            </div>
          </>
        ) : sortedRunPresets.length === 0 ? (
          <>
            <p className="muted">Chưa có preset đã lưu.</p>
            <button type="button" className="secondary-cta" onClick={startWizard}>
              Thêm preset
            </button>
          </>
        ) : (
          <>
            <label className="field-label">
              Preset
              <select
                value={presetSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const p = sortedRunPresets.find((x) => x.id === v);
                  if (p) applyOfficialPreset(p);
                }}
              >
                <option value="">-- Chọn preset --</option>
                {sortedRunPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {presetOptionLabel(p)}
                  </option>
                ))}
              </select>
            </label>
            <div className="preset-actions">
              <button type="button" className="secondary-cta" onClick={startWizard}>
                Thêm
              </button>
              <button type="button" className="secondary-cta" disabled={!selectedPreset} onClick={renameOfficialPreset}>
                Đổi tên
              </button>
              <button type="button" className="secondary-cta" disabled={!selectedPreset} onClick={saveDirtyOfficialPreset}>
                Lưu
              </button>
              <button type="button" className="danger-ghost-btn" disabled={!selectedPreset} onClick={deleteOfficialPreset}>
                Xóa
              </button>
            </div>
            <label className="field-label">
              Backbone
              <div className="segmented-toggle segmented-toggle--dense">
                {BACKBONE_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={`segment-btn ${currentBackbone === o.id ? "active" : ""}`}
                    onClick={() => onIdleBackboneChange(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </label>
          </>
        )}
      </div>

      {showIdleFullConfig ? (
        idleConfigEntries.length > 0 ? (
          <DynamicConfigGrid schemaEntries={idleConfigEntries} runConfigForm={runConfigForm} setRunConfigForm={setRunConfigForm} />
        ) : (
          <p className="muted">No config schema for this algorithm.</p>
        )
      ) : null}

      <label className="field-label inline-checkbox">
        <span>Path signature</span>
        <input
          type="checkbox"
          checked={Boolean(form.artifact_flags?.path_signature)}
          onChange={() =>
            setForm((prev) => ({
              ...prev,
              artifact_flags: {
                ...(prev.artifact_flags ?? {}),
                path_signature: !(prev.artifact_flags?.path_signature ?? false)
              }
            }))
          }
        />
      </label>
      <label className="field-label inline-checkbox">
        <span>Delay per episode</span>
        <input
          type="checkbox"
          checked={Boolean(form.artifact_flags?.delay_per_episode)}
          onChange={() =>
            setForm((prev) => ({
              ...prev,
              artifact_flags: {
                ...(prev.artifact_flags ?? {}),
                delay_per_episode: !(prev.artifact_flags?.delay_per_episode ?? false)
              }
            }))
          }
        />
      </label>
      <p className="muted batch-artifact-hint">
        Path signature: lưu run bundle (delay/path series), decision graph và trace epochs. Delay per episode: chỉ run bundle (không graph/trace).
      </p>

      <section className="config-field-block config-field-block--randomness">
        <h5 className="config-field-block__title">Run randomness</h5>
        <RunSeedField form={form} setForm={setForm} />
      </section>

      <button
        className="primary-cta"
        disabled={isRunningBatch || runBlocked || (isRepeatMode ? !canRunRepeat : !canRunMulti)}
        type="submit"
      >
        {isRunningBatch ? "Submitting..." : isRepeatMode ? "Run repeat" : "Run multi"}
      </button>
    </form>
  );
}

function parseCsvRows(payload) {
  const text = payload?.text;
  if (!text || typeof text !== "string") return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx]?.trim() ?? "";
    });
    return row;
  });
}

function CsvIconButton({ payload, filename = "artifact.csv" }) {
  if (!payload?.text) return null;
  return (
    <button
      type="button"
      className="csv-icon-btn"
      title="Open CSV"
      onClick={() => {
        const blob = new Blob([payload.text], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
      }}
    >
      CSV
    </button>
  );
}

function buildDelayPathCountRows(delayRows, pathRows) {
  const episodeDelay = new Map();
  delayRows.forEach((row) => {
    const episode = Number(row.episode);
    const delay = Number(row.delay);
    if (!Number.isFinite(episode) || !Number.isFinite(delay)) return;
    episodeDelay.set(episode, delay);
  });
  if (episodeDelay.size === 0) return [];

  const pathsByDelay = new Map();
  pathRows.forEach((row) => {
    const episode = Number(row.episode);
    const signature = typeof row.path_signature === "string" ? row.path_signature.trim() : "";
    if (!Number.isFinite(episode) || !signature) return;
    const delay = episodeDelay.get(episode);
    if (!Number.isFinite(delay)) return;
    if (!pathsByDelay.has(delay)) pathsByDelay.set(delay, new Set());
    pathsByDelay.get(delay).add(signature);
  });

  const delays =
    pathsByDelay.size > 0
      ? [...pathsByDelay.keys()]
      : [...new Set(episodeDelay.values())];

  return delays
    .sort((a, b) => a - b)
    .map((delay) => {
      const pathSet = pathsByDelay.get(delay);
      if (pathSet) {
        return { delay, pathCount: pathSet.size };
      }
      const episodeCount = [...episodeDelay.entries()].filter(([, d]) => d === delay).length;
      return { delay, pathCount: episodeCount };
    });
}

function DelayPathCountTable({ rows, hasPathSignatures }) {
  if (!rows?.length) return null;
  return (
    <div className="delay-path-count-table-wrap">
      <table className="delay-path-count-table">
        <thead>
          <tr>
            <th>Delay</th>
            <th>{hasPathSignatures ? "Path count" : "Episodes"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.delay}>
              <td>{row.delay}</td>
              <td>{row.pathCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DelayLineChart({ rows }) {
  if (!rows || rows.length === 0) {
    return <p className="muted">No delay-per-episode data.</p>;
  }
  const width = 320;
  const height = 120;
  const values = rows.map((row) => Number(row.delay)).filter((n) => Number.isFinite(n));
  if (values.length === 0) return <p className="muted">No delay-per-episode data.</p>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((val, idx) => {
      const x = (idx / Math.max(1, values.length - 1)) * (width - 16) + 8;
      const y = height - ((val - min) / span) * (height - 20) - 10;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="delay-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="delay-chart">
        <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
        <polyline points={points} fill="none" stroke="#7e6df2" strokeWidth="2" />
      </svg>
      <div className="delay-chart-meta">
        <span>Episodes: {values.length}</span>
        <span>
          Delay range: {min} - {max}
        </span>
      </div>
    </div>
  );
}

function ResultsPanel({
  runHistoryItems,
  focusedBatchRunResult,
  runSummaryPayload,
  latestCompletedRun,
  transmissionLastPayload,
  transmissionBestPayload,
  resultsViewMode,
  resultsEpochMode,
  replaySlot,
  stateActionLastPayload,
  stateActionBestPayload,
  delayPerEpisodePayload,
  policyTracePayload,
  pathSignaturesPayload,
  resolvedRunConfigPayload,
  stateActionAllPayload,
  transmissionAllPayload,
  qTableAllEpochsPayload,
  selectedEpisode,
  latestRunCapabilities
}) {
  const latestHistory =
    (latestCompletedRun
      ? runHistoryItems?.find((item) => item.run_id === latestCompletedRun.run_id) ?? null
      : null) ?? runHistoryItems?.[0] ?? null;
  const [stateActionEpoch, setStateActionEpoch] = useState("last");
  const allStateActionEpisodes = Array.isArray(stateActionAllPayload?.episodes) ? stateActionAllPayload.episodes : [];
  const allTransmissionEpisodes = Array.isArray(transmissionAllPayload?.episodes) ? transmissionAllPayload.episodes : [];
  const selectedEpisodeNum = Number(selectedEpisode) || 0;
  const selectedEpisodeStateAction =
    selectedEpisodeNum > 0
      ? allStateActionEpisodes.find((item) => Number(item.episode) === selectedEpisodeNum) ?? null
      : null;
  const selectedEpisodeTransmission =
    selectedEpisodeNum > 0
      ? allTransmissionEpisodes.find((item) => Number(item.episode) === selectedEpisodeNum) ?? null
      : null;
  const stateActionPayload = selectedEpisodeStateAction ?? (stateActionEpoch === "best" ? stateActionBestPayload : stateActionLastPayload);
  const delayRows = parseCsvRows(delayPerEpisodePayload);
  const policyRows = parseCsvRows(policyTracePayload);
  const pathRows = parseCsvRows(pathSignaturesPayload);
  const uniquePathCount = new Set(pathRows.map((row) => row.path_signature).filter(Boolean)).size;
  const bestDelay = Math.min(
    ...delayRows.map((row) => Number(row.delay)).filter((n) => Number.isFinite(n))
  );
  const bestDelayEpisodes = new Set(
    delayRows
      .filter((row) => Number(row.delay) === bestDelay)
      .map((row) => Number(row.episode))
      .filter((n) => Number.isFinite(n))
  );
  const bestDelayUniquePathCount = Number.isFinite(bestDelay)
    ? new Set(
        pathRows
          .filter((row) => bestDelayEpisodes.has(Number(row.episode)))
          .map((row) => row.path_signature)
          .filter(Boolean)
      ).size
    : 0;
  const hasPolicyTrace = (latestRunCapabilities?.has_policy_trace ?? true) && policyRows.length > 0;
  const hasStateActionTrace = latestRunCapabilities?.has_state_action_trace ?? true;
  const hasEpisodeSeries = latestRunCapabilities?.has_episode_series ?? true;
  const hasEpochCompare = latestRunCapabilities?.has_epoch_compare ?? true;
  const hasPathSignatures = latestRunCapabilities?.has_path_signatures ?? true;
  const currentTransmissionPayload =
    selectedEpisodeTransmission ?? (resultsEpochMode === "best" ? transmissionBestPayload : transmissionLastPayload);
  const timeslots = currentTransmissionPayload?.timeslots ?? [];
  const replaySlotNum = Number(replaySlot) || 0;
  const activeSlotInfo =
    replaySlotNum > 0
      ? timeslots.find((item) => Number(item.timeslot) === replaySlotNum) ?? timeslots[replaySlotNum - 1] ?? null
      : null;
  const singleRunConfigResult = useMemo(
    () => buildRunConfigResultFromResolved(resolvedRunConfigPayload, latestHistory),
    [resolvedRunConfigPayload, latestHistory]
  );
  const delayPathCountRows = useMemo(
    () => buildDelayPathCountRows(parseCsvRows(delayPerEpisodePayload), parseCsvRows(pathSignaturesPayload)),
    [delayPerEpisodePayload, pathSignaturesPayload]
  );
  return (
    <div className="results-panel">
      {singleRunConfigResult ? <RunConfigPanel result={singleRunConfigResult} showDivider={false} /> : null}
      {singleRunConfigResult ? <hr className="results-divider" /> : null}
      {hasEpisodeSeries ? (
        <>
          <h4>Delay per episode</h4>
          <DelayLineChart rows={delayRows} />
          <DelayPathCountTable rows={delayPathCountRows} hasPathSignatures={hasPathSignatures && pathRows.length > 0} />
        </>
      ) : null}
      {hasPolicyTrace ? (
        <>
          <hr className="results-divider" />
          <div className="inline-title-row">
            <h4>Policy trace</h4>
            <CsvIconButton payload={policyTracePayload} filename="policy_trace.csv" />
          </div>
          <PolicyTraceLineChart rows={policyRows} />
        </>
      ) : null}
      {hasPathSignatures ? (
        <>
          <hr className="results-divider" />
          <div className="inline-title-row">
            <h4>Unique path signatures</h4>
            <CsvIconButton payload={pathSignaturesPayload} filename="path_signatures.csv" />
          </div>
          <dl>
            <dt>Unique path count</dt>
            <dd>{uniquePathCount}</dd>
            <dt>Best delay unique path</dt>
            <dd>{bestDelayUniquePathCount}</dd>
            <dt>Episodes at best delay</dt>
            <dd>{Number.isFinite(bestDelay) ? bestDelayEpisodes.size : (runSummaryPayload?.best_delay_episode_count ?? "-")}</dd>
          </dl>
        </>
      ) : null}
      {hasStateActionTrace ? (
        <>
          <hr className="results-divider" />
          <div className="inline-title-row">
            <h4>State-action</h4>
            {hasEpochCompare ? (
              <div className="view-mode-toggle">
                <button
                  type="button"
                  className={stateActionEpoch === "last" ? "active" : ""}
                  onClick={() => setStateActionEpoch("last")}
                >
                  Last epoch
                </button>
                <button
                  type="button"
                  className={stateActionEpoch === "best" ? "active" : ""}
                  onClick={() => setStateActionEpoch("best")}
                >
                  Best epoch
                </button>
              </div>
            ) : null}
          </div>
          {stateActionPayload ? (
            <dl>
              {hasEpochCompare ? (
                <>
                  <dt>Episode</dt>
                  <dd>{stateActionPayload.episode ?? "-"}</dd>
                </>
              ) : null}
              <dt>Total delay</dt>
              <dd>{stateActionPayload.delay ?? "-"}</dd>
              <dt>Path signature</dt>
              <dd>{stateActionPayload.path_signature ?? "-"}</dd>
            </dl>
          ) : (
            <p className="muted">Not available.</p>
          )}
        </>
      ) : null}
      {resultsViewMode === "replay" ? (
        <>
          <hr className="results-divider" />
          <h4>Replay timeslot info</h4>
          {activeSlotInfo ? (
            <div className="table-scroll">
              <table className="node-edit-table">
                <thead>
                  <tr>
                    <th>timeslot</th>
                    <th>br_set</th>
                    <th>rcv_set</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{activeSlotInfo.timeslot ?? replaySlotNum}</td>
                    <td>{(activeSlotInfo.transmitters ?? []).join(", ") || "-"}</td>
                    <td>{(activeSlotInfo.receivers ?? []).join(", ") || "-"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Move replay slider to a timeslot &gt; 0.</p>
          )}
        </>
      ) : null}
      <hr className="results-divider" />
      <h4>Selected run metrics</h4>
      {latestHistory ? (
        <dl>
          <dt>Status</dt>
          <dd>{latestHistory.status}</dd>
          <dt>Preset</dt>
          <dd>{latestHistory.preset_name ?? latestHistory.preset_id ?? "-"}</dd>
          <dt>Created at</dt>
          <dd>{latestHistory.created_at}</dd>
          <dt>Finished delay</dt>
          <dd>{latestHistory.finished_delay ?? "-"}</dd>
          <dt>Lower bound</dt>
          <dd>{latestHistory.lower_bound ?? "-"}</dd>
          <dt>Best delay explored</dt>
          <dd>{latestHistory.best_delay_explored ?? "-"}</dd>
          <dt>States (Q-table)</dt>
          <dd>{latestHistory.total_states ?? "-"}</dd>
          <dt>State–action pairs</dt>
          <dd>{latestHistory.total_state_actions ?? "-"}</dd>
          <dt>Decision graph edges</dt>
          <dd>{latestHistory.decision_graph_edges ?? "-"}</dd>
        </dl>
      ) : (
        <p className="muted">No history yet for this topology.</p>
      )}
      <hr className="results-divider" />
      <h4>Artifacts summary</h4>
      {runSummaryPayload ? (
        <>
          <dl>
            <dt>Run ID</dt>
            <dd>{latestCompletedRun?.run_id ?? runSummaryPayload.run_id ?? "-"}</dd>
            <dt>Episodes</dt>
            <dd>{runSummaryPayload.episodes ?? "-"}</dd>
            <dt>Alpha / Gamma</dt>
            <dd>
              {runSummaryPayload.alpha ?? "-"} / {runSummaryPayload.gamma ?? "-"}
            </dd>
            <dt>Epsilon end</dt>
            <dd>{runSummaryPayload.epsilon_end ?? "-"}</dd>
            <dt>Best episode</dt>
            <dd>{runSummaryPayload.best_episode ?? "-"}</dd>
            <dt>Reward final</dt>
            <dd>{runSummaryPayload.reward_final ?? "-"}</dd>
          </dl>
        </>
      ) : (
        <p className="muted">No artifact summary loaded.</p>
      )}
    </div>
  );
}

function BatchDetailPanel({ batch }) {
  if (!batch) {
    return (
      <div className="placeholder-card">
        <p className="muted">Không tìm thấy batch.</p>
      </div>
    );
  }
  return (
    <div className="results-panel detail-panel">
      <h4>Batch</h4>
      <dl>
        <dt>Name</dt>
        <dd>{batch.batch_name}</dd>
        <dt>ID</dt>
        <dd>{batch.batch_id}</dd>
        <dt>Locked</dt>
        <dd>{batch.is_locked ? "Yes" : "No"}</dd>
        <dt>Topology count</dt>
        <dd>{batch.topologies?.length ?? 0}</dd>
      </dl>
    </div>
  );
}

function DetailPanel({ detail, isLoading }) {
  return (
    <div className="results-panel detail-panel">
      <h4>Topology detail</h4>
      {isLoading ? (
        <p className="muted">Loading...</p>
      ) : detail ? (
        <dl>
          <dt>Created at</dt>
          <dd>{detail.created_at}</dd>
          <dt>Status</dt>
          <dd>{detail.status}</dd>
          <dt>Node count</dt>
          <dd>{detail.node_count}</dd>
          <dt>Space</dt>
          <dd>
            {detail.space_width} x {detail.space_height}
          </dd>
          <dt>Sink mode</dt>
          <dd>{detail.sink_mode}</dd>
          <dt>Sink position</dt>
          <dd>
            ({detail.sink_x}, {detail.sink_y})
          </dd>
          <dt>Tx range</dt>
          <dd>{detail.tx_range}</dd>
          <dt>Seed</dt>
          <dd>{detail.seed ?? "-"}</dd>
          <dt>Finished delay</dt>
          <dd>{detail.finished_delay ?? "-"}</dd>
          <dt>Lower bound</dt>
          <dd>{detail.lower_bound ?? "-"}</dd>
          <dt>Best delay explored</dt>
          <dd>{detail.best_delay_explored ?? "-"}</dd>
        </dl>
      ) : (
        <p className="muted">No selected topology.</p>
      )}
    </div>
  );
}

function DecisionTreeLayoutControl({ label, value, min, max, step, onChange, formatValue }) {
  const display = formatValue ? formatValue(value) : `${Number(value).toFixed(2)}×`;
  return (
    <label className="field-label">
      {label}
      <div className="playground-tree-layout-row">
        <input
          type="number"
          className="playground-tree-layout-input"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange(clampLayoutValue(next, min, max));
          }}
        />
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="playground-tree-layout-value">{display}</span>
      </div>
    </label>
  );
}

function clampLayoutValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function PlaygroundPanel({
  selectedTopology,
  playgroundState,
  playgroundNextStateCount,
  setPlaygroundMode,
  setPlaygroundSpreadMode,
  setPlaygroundViewSlot,
  onReset,
  decisionTreeRowSpread,
  setDecisionTreeRowSpread,
  decisionTreeFontScale,
  setDecisionTreeFontScale,
  decisionTreeEdgeScale,
  setDecisionTreeEdgeScale,
  decisionTreeNodeScale,
  setDecisionTreeNodeScale,
  decisionTreeEdgeOpacity,
  setDecisionTreeEdgeOpacity,
  onSaveDecisionTreeLayoutDefaults
}) {
  const totalCovered = playgroundState?.coveredNodeIds?.length ?? 1;
  const totalSlots = playgroundState?.timeslots?.length ?? 0;
  const viewSlot = Math.min(Math.max(0, Number(playgroundState?.viewSlot) || 0), totalSlots);
  const isLatestView = viewSlot === totalSlots;
  const currentSlot = Number(playgroundState?.currentSlot) || 0;

  return (
    <div className="edit-panel">
      <div className="edit-panel-header">
        <h4>Playground</h4>
        <button type="button" className="secondary-cta" onClick={onReset}>
          Reset
        </button>
      </div>
      <div className="playground-side-block">
        <div className="playground-mode-switch">
          <button
            type="button"
            className={`tab-pill ${playgroundState?.mode === "broadcaster" ? "active" : ""}`}
            onClick={() => setPlaygroundMode("broadcaster")}
          >
            Broadcaster
          </button>
          <button
            type="button"
            className={`tab-pill ${playgroundState?.mode === "receiver" ? "active" : ""}`}
            onClick={() => setPlaygroundMode("receiver")}
          >
            Receiver
          </button>
        </div>
        <div className="playground-mode-switch">
          <button
            type="button"
            className={`tab-pill ${playgroundState?.spreadMode !== "la" ? "active" : ""}`}
            onClick={() => setPlaygroundSpreadMode("normal")}
          >
            Spread: Normal
          </button>
          <button
            type="button"
            className={`tab-pill ${playgroundState?.spreadMode === "la" ? "active" : ""}`}
            onClick={() => setPlaygroundSpreadMode("la")}
          >
            Spread: LA
          </button>
        </div>
        <dl>
          <dt>Topology</dt>
          <dd>{selectedTopology?.topology_name ?? "-"}</dd>
          <dt>Lower bound</dt>
          <dd>{selectedTopology?.lower_bound ?? "-"}</dd>
          <dt>Current timeslot</dt>
          <dd>{currentSlot}</dd>
          <dt>Viewing slot</dt>
          <dd>{viewSlot}</dd>
          <dt>Covered nodes</dt>
          <dd>{totalCovered}</dd>
          <dt>Status</dt>
          <dd>{playgroundState?.isComplete ? "Done" : isLatestView ? "Ready" : "History"}</dd>
          <dt>Next unique states</dt>
          <dd>{playgroundState?.isComplete ? 0 : isLatestView ? playgroundNextStateCount ?? 0 : "-"}</dd>
        </dl>
        {totalSlots > 0 ? (
          <label className="field-label">
            Timeline
            <input
              type="range"
              min="0"
              max={totalSlots}
              value={viewSlot}
              onChange={(e) => setPlaygroundViewSlot(Number(e.target.value))}
            />
          </label>
        ) : null}
        <p className="muted playground-help">
          {playgroundState?.isComplete
            ? "All nodes are covered."
            : isLatestView
              ? "Hover a red-outlined node to preview, then click to commit the next timeslot."
              : "Timeline is in history mode. Move back to the latest slot to continue."}
        </p>
      </div>
      <div className="playground-side-block playground-tree-layout-block">
        <h5 className="playground-tree-layout-title">Decision tree layout</h5>
        <label className="field-label">
          Vertical spread
          <div className="playground-tree-layout-row">
            <input
              type="number"
              className="playground-tree-layout-input"
              min="0.5"
              max="2.5"
              step="0.05"
              value={decisionTreeRowSpread}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) setDecisionTreeRowSpread(clampLayoutValue(next, 0.5, 2.5));
              }}
            />
            <input
              type="range"
              min="0.5"
              max="2.5"
              step="0.05"
              value={decisionTreeRowSpread}
              onChange={(e) => setDecisionTreeRowSpread(Number(e.target.value))}
            />
            <span className="playground-tree-layout-value">{Number(decisionTreeRowSpread).toFixed(2)}×</span>
          </div>
        </label>
        <DecisionTreeLayoutControl
          label="Font size"
          value={decisionTreeFontScale}
          min={0.5}
          max={3}
          step={0.05}
          onChange={setDecisionTreeFontScale}
        />
        <DecisionTreeLayoutControl
          label="Edge size"
          value={decisionTreeEdgeScale}
          min={0.4}
          max={3}
          step={0.05}
          onChange={setDecisionTreeEdgeScale}
        />
        <DecisionTreeLayoutControl
          label="Node size"
          value={decisionTreeNodeScale}
          min={0.4}
          max={3}
          step={0.05}
          onChange={setDecisionTreeNodeScale}
        />
        <label className="field-label">
          Edge opacity
          <div className="playground-tree-layout-row">
            <input
              type="range"
              min="0.15"
              max="1"
              step="0.05"
              value={decisionTreeEdgeOpacity}
              onChange={(e) => setDecisionTreeEdgeOpacity(Number(e.target.value))}
            />
            <span className="playground-tree-layout-value">{Math.round(decisionTreeEdgeOpacity * 100)}%</span>
          </div>
        </label>
        <button
          type="button"
          className="secondary-cta small playground-tree-layout-save"
          onClick={onSaveDecisionTreeLayoutDefaults}
          title="Save current layout values as defaults for future sessions."
        >
          Save as default
        </button>
      </div>
    </div>
  );
}

function computeTemperatureRows(qValues = [], tau = 1) {
  const epsilon = 1e-6;
  const values = (qValues ?? []).map((value) => Number(value) || 0);
  if (!values.length) return [];
  if (!Number.isFinite(Number(tau)) || Number(tau) <= epsilon) {
    const maxQ = Math.max(...values);
    const winners = values.map((value, index) => ({ value, index })).filter((item) => item.value === maxQ);
    const winnerProbability = winners.length > 0 ? 1 / winners.length : 0;
    return values.map((value, index) => ({
      action: `A${index + 1}`,
      probability: winners.some((item) => item.index === index) ? winnerProbability : 0
    }));
  }
  const logits = values.map((value) => value / Number(tau));
  const maxLogit = Math.max(...logits);
  const expValues = logits.map((logit) => Math.exp(logit - maxLogit));
  const expSum = expValues.reduce((sum, value) => sum + value, 0);
  return values.map((_, index) => ({
    action: `A${index + 1}`,
    probability: expSum > 0 ? expValues[index] / expSum : 0
  }));
}

function computeUcbSummaryRows(qValues = [], visitCounts = [], globalT = 1, ucbC = 1.414) {
  const values = (qValues ?? []).map((value) => Number(value) || 0);
  const visits = (visitCounts ?? []).map((value) => Math.max(0, Math.trunc(Number(value) || 0)));
  const t = Math.max(Number(globalT) || 0, 1);
  const c = Number(ucbC) || 1.414;
  const logT = Math.log(t);

  const rows = values.map((qValue, index) => {
    const visitCount = visits[index] ?? 0;
    const unvisited = visitCount === 0;
    const bonus = unvisited ? null : c * Math.sqrt(logT / visitCount);
    const score = unvisited ? null : qValue + bonus;
    return {
      action: `A${index + 1}`,
      score,
      unvisited,
      selected: false
    };
  });

  const unvisitedRows = rows.filter((row) => row.unvisited);
  let selectedAction = null;
  if (unvisitedRows.length > 0) {
    selectedAction = unvisitedRows.reduce(
      (minAction, row) => (minAction == null || row.action < minAction ? row.action : minAction),
      null
    );
  } else if (rows.length > 0) {
    const bestRow = rows.reduce((best, row) =>
      best == null || (row.score ?? -Infinity) > (best.score ?? -Infinity) ? row : best
    );
    selectedAction = bestRow?.action ?? null;
  }

  return rows.map((row) => ({ ...row, selected: row.action === selectedAction }));
}

function HomeUcbSummaryPanel({ ucbTool, onFontScaleChange }) {
  const rows = useMemo(
    () =>
      computeUcbSummaryRows(
        ucbTool?.qValues ?? [],
        ucbTool?.visitCounts ?? [],
        ucbTool?.globalT ?? 1,
        ucbTool?.ucbC ?? 1.414
      ),
    [ucbTool?.qValues, ucbTool?.visitCounts, ucbTool?.globalT, ucbTool?.ucbC]
  );
  const selectedRow = rows.find((row) => row.selected) ?? null;
  const fontScale = Number(ucbTool?.fontScale) || 1;
  return (
    <div className="placeholder-card">
      <h4>UCB tool</h4>
      <dl>
        <dt>Global t</dt>
        <dd>{Math.round(Number(ucbTool?.globalT ?? 0))}</dd>
        <dt>UCB c</dt>
        <dd>{Number(ucbTool?.ucbC ?? 0).toFixed(3)}</dd>
        <dt>Action count</dt>
        <dd>{ucbTool?.actionCount ?? 0}</dd>
        <dt>Selected action</dt>
        <dd>
          {selectedRow
            ? `${selectedRow.action}${selectedRow.unvisited ? " (unvisited)" : ` (${Number(selectedRow.score).toFixed(3)})`}`
            : "-"}
        </dd>
      </dl>
      <label className="field-label temperature-font-control">
        Font size
        <input
          type="range"
          min="0.8"
          max="1.8"
          step="0.05"
          value={fontScale}
          onChange={(e) => onFontScaleChange(Number(e.target.value))}
        />
        <small className="muted">{fontScale.toFixed(2)}x</small>
      </label>
      <p className="muted">Adjust Q, N(s,a), global t, and c in the main panel to see UCB scores update in real time.</p>
    </div>
  );
}

function HomeTemperatureSummaryPanel({ temperatureTool, onFontScaleChange }) {
  const rows = useMemo(
    () => computeTemperatureRows(temperatureTool?.qValues ?? [], temperatureTool?.tau ?? 1),
    [temperatureTool?.qValues, temperatureTool?.tau]
  );
  const topRow = rows.reduce((best, row) => ((row.probability ?? 0) > (best?.probability ?? -1) ? row : best), null);
  const fontScale = Number(temperatureTool?.fontScale) || 1;
  return (
    <div className="placeholder-card">
      <h4>Temperature tool</h4>
      <dl>
        <dt>Current tau</dt>
        <dd>{Number(temperatureTool?.tau ?? 0).toFixed(3)}</dd>
        <dt>Action count</dt>
        <dd>{temperatureTool?.actionCount ?? 0}</dd>
        <dt>Top action</dt>
        <dd>{topRow ? `${topRow.action} (${(topRow.probability * 100).toFixed(2)}%)` : "-"}</dd>
      </dl>
      <label className="field-label temperature-font-control">
        Font size
        <input
          type="range"
          min="0.8"
          max="1.8"
          step="0.05"
          value={fontScale}
          onChange={(e) => onFontScaleChange(Number(e.target.value))}
        />
        <small className="muted">{fontScale.toFixed(2)}x</small>
      </label>
      <p className="muted">Adjust tau and q-value sliders in the main panel to see softmax probabilities update in real time.</p>
    </div>
  );
}

function DisplaySettingsPanel({ settings, setSettings, bestDelayOverlayOpacity, setBestDelayOverlayOpacity, onReset }) {
  function updateField(field, value) {
    setSettings((prev) => ({ ...prev, [field]: value }));
  }

  const opacityValue = Number.isFinite(Number(bestDelayOverlayOpacity)) ? Number(bestDelayOverlayOpacity) : 1;

  return (
    <div className="edit-panel">
      <div className="edit-panel-header">
        <h4>Display settings</h4>
        <button type="button" className="secondary-cta" onClick={onReset}>
          Reset
        </button>
      </div>
      <div className="display-settings-grid">
        <label className="field-label">
          Node size
          <input
            type="number"
            step="0.1"
            min="0.5"
            max="4"
            value={settings.node_size}
            onChange={(e) => updateField("node_size", Number(e.target.value))}
          />
        </label>
        <label className="field-label">
          Label size
          <input
            type="number"
            step="0.1"
            min="1"
            max="8"
            value={settings.label_size}
            onChange={(e) => updateField("label_size", Number(e.target.value))}
          />
        </label>
        <label className="field-label">
          Edge width
          <input
            type="number"
            step="0.05"
            min="0.1"
            max="3"
            value={settings.edge_width}
            onChange={(e) => updateField("edge_width", Number(e.target.value))}
          />
        </label>
        <label className="field-label">
          Best delay opacity
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={opacityValue}
            onChange={(e) => setBestDelayOverlayOpacity(Number(e.target.value))}
          />
          <small className="muted">{opacityValue.toFixed(2)}</small>
        </label>
      </div>
    </div>
  );
}

function TopologyGridPreviewSettingsPanel({
  previewMaxNodesPercent,
  setPreviewMaxNodesPercent,
  previewShowEdges,
  setPreviewShowEdges
}) {
  const safePercent = Math.max(10, Math.min(100, Number(previewMaxNodesPercent) || 80));
  return (
    <div className="edit-panel preview-settings-panel">
      <div className="edit-panel-header">
        <h4>Grid preview</h4>
      </div>
      <label className="field-label">
        Max nodes (%)
        <input
          type="range"
          min="10"
          max="100"
          step="5"
          value={safePercent}
          onChange={(e) => setPreviewMaxNodesPercent(Number(e.target.value))}
        />
        <small className="muted">{safePercent}%</small>
      </label>
      <label className="field-label inline-checkbox">
        <span>Show edges in preview</span>
        <input
          type="checkbox"
          checked={Boolean(previewShowEdges)}
          onChange={(e) => setPreviewShowEdges(e.target.checked)}
        />
      </label>
    </div>
  );
}

function EditTopologyPanel({
  selectedTopology,
  isLoadingNodes,
  topologyNodes,
  onNodeBlur,
  onNodeKeyDown,
  onSave,
  isSaving
}) {
  return (
    <div className="edit-panel">
      <div className="edit-panel-header">
        <h4>Edit topology</h4>
        <button type="button" className="primary-cta small" disabled={!selectedTopology || isSaving} onClick={onSave}>
          {isSaving ? "Saving..." : "Save"}
        </button>
      </div>
      {isLoadingNodes ? (
        <p className="muted">Loading...</p>
      ) : (
        <div className="table-scroll">
          <table className="node-edit-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>X</th>
                <th>Y</th>
              </tr>
            </thead>
            <tbody>
              {topologyNodes.map((node) => (
                <tr key={node.node_id}>
                  <td>{node.node_id}</td>
                  <td>
                    <input
                      type="number"
                      defaultValue={node.x}
                      onBlur={(e) => onNodeBlur(node.node_id, "x", e.target.value)}
                      onKeyDown={(e) => onNodeKeyDown(e, node.node_id, "x")}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      defaultValue={node.y}
                      onBlur={(e) => onNodeBlur(node.node_id, "y", e.target.value)}
                      onKeyDown={(e) => onNodeKeyDown(e, node.node_id, "y")}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TopologiesEmptyPanel() {
  return <div className="topo-panel-silent" aria-hidden="true" />;
}

function ContextPlaceholderPanel({ message }) {
  return (
    <div className="placeholder-card">
      <p className="muted">{message}</p>
    </div>
  );
}

function RunConfigPanel({ result, showDivider = true }) {
  const { merged } = mergeDisplayConfig(result);
  const hasConfig = merged && Object.keys(merged).length > 0;

  if (!hasConfig && !result?.algorithm_id && !result?.preset_name) {
    return null;
  }

  return (
    <>
      {showDivider ? <hr className="results-divider" /> : null}
      <h4>Run config</h4>
      <RunConfigVisibilityTable result={result} />
    </>
  );
}

function BatchRunConfigPanel({ result }) {
  return <RunConfigPanel result={result} />;
}

function BatchRunResultSummaryPanel({ result }) {
  if (!result) {
    return <ContextPlaceholderPanel message="No batch result selected." />;
  }
  const densityGroupCount = Array.isArray(result.density_groups) ? result.density_groups.length : 0;
  const topologyCount = Array.isArray(result.topologies) ? result.topologies.length : 0;
  return (
    <div className="results-panel detail-panel">
      <h4>Batch result</h4>
      <dl>
        <dt>Label</dt>
        <dd>{result.result_label ?? "-"}</dd>
        <dt>Batch run ID</dt>
        <dd className="batch-run-id-dd">{result.batch_run_id ?? "-"}</dd>
        <dt>Status</dt>
        <dd>{result.batch_status ?? "-"}</dd>
        <dt>Topologies with results</dt>
        <dd>{topologyCount}</dd>
        <dt>Density groups</dt>
        <dd>{densityGroupCount}</dd>
      </dl>
      <BatchPolicyTraceCard result={result} />
      <hr className="results-divider" />
      <BatchRunConfigPanel result={result} />
    </div>
  );
}

export default function RightControlPanel({
  activePanel2Tab,
  setActivePanel2Tab,
  activeMenu,
  focusedBatchId,
  focusedTopologyId,
  focusedBatch,
  selectedTopology,
  runTopoForm,
  setRunTopoForm,
  runMultiForm,
  setRunMultiForm,
  algorithmOptions,
  selectedAlgorithmMeta,
  runTopoConfigForm,
  setRunTopoConfigForm,
  runMultiConfigForm,
  setRunMultiConfigForm,
  algorithmDefaultConfigById,
  runPresets,
  loadRunPresets,
  setMessage,
  parseApiError,
  runTopoWizard,
  setRunTopoWizard,
  runMultiWizard,
  setRunMultiWizard,
  setSharedRunConfigForBackbone,
  runTopoBackbone,
  runMultiBackbone,
  runSingleTopology,
  runMultiTopologies,
  isRunningSingle,
  isRunningBatch,
  lastSingleRun,
  runHistoryItems,
  focusedBatchRunResult,
  runSummaryPayload,
  latestCompletedRun,
  transmissionLastPayload,
  transmissionBestPayload,
  resultsViewMode,
  resultsEpochMode,
  replaySlot,
  stateActionLastPayload,
  stateActionBestPayload,
  delayPerEpisodePayload,
  policyTracePayload,
  pathSignaturesPayload,
  resolvedRunConfigPayload,
  stateActionAllPayload,
  transmissionAllPayload,
  qTableAllEpochsPayload,
  selectedEpisode,
  latestRunCapabilities,
  graphDisplaySettings,
  setGraphDisplaySettings,
  resetGraphDisplaySettings,
  bestDelayOverlayOpacity,
  setBestDelayOverlayOpacity,
  previewMaxNodesPercent,
  setPreviewMaxNodesPercent,
  previewShowEdges,
  setPreviewShowEdges,
  runMultiSubMode,
  repeatTopologyId,
  repeatRunCount,
  setRepeatRunCount,
  isLoadingNodes,
  topologyNodes,
  handleNodeBlur,
  handleNodeKeyDown,
  saveTopology,
  isSavingTopology,
  topologyDetail,
  isLoadingDetail,
  playgroundState,
  playgroundNextStateCount,
  temperatureTool,
  updateTemperatureFontScale,
  homeToolTab,
  ucbTool,
  updateUcbFontScale,
  setPlaygroundMode,
  setPlaygroundSpreadMode,
  setPlaygroundViewSlot,
  onResetPlayground,
  decisionTreeRowSpread,
  setDecisionTreeRowSpread,
  decisionTreeFontScale,
  setDecisionTreeFontScale,
  decisionTreeEdgeScale,
  setDecisionTreeEdgeScale,
  decisionTreeNodeScale,
  setDecisionTreeNodeScale,
  decisionTreeEdgeOpacity,
  setDecisionTreeEdgeOpacity,
  onSaveDecisionTreeLayoutDefaults,
  rightExportContext,
  onOpenExportModal
}) {
  const isTopologiesMode = activeMenu === "topologies";
  const isRunTopoMode = activeMenu === "run_topo";
  const isRunMultiMode = activeMenu === "run_multi";
  const isResultsMode = activeMenu === "results";
  const selectedRunMultiAlgorithmMeta = useMemo(
    () => (algorithmOptions ?? []).find((item) => item.algorithm_id === runMultiForm?.algorithm_id) ?? null,
    [algorithmOptions, runMultiForm?.algorithm_id]
  );
  const topologiesTab = ["detail", "edit_topo", "playground"].includes(activePanel2Tab) ? activePanel2Tab : "detail";

  const hasBatchOnly = Boolean(focusedBatchId) && !Boolean(focusedTopologyId);
  const isBatchGridView = !focusedBatchId && !focusedTopologyId;
  const hasFocusedTopologyContext = Boolean(focusedTopologyId && selectedTopology);
  const isBatchResultsContext = isResultsMode && Boolean(focusedBatchRunResult) && !Boolean(focusedTopologyId);
  const needsRunTopoSelection = isRunTopoMode && !hasFocusedTopologyContext;
  const needsResultsSelection = isResultsMode && !hasFocusedTopologyContext && !Boolean(focusedBatchRunResult);

  return (
    <aside className="right-panel-shell">
      <header className="right-panel-header">
        <div className="tab-row">
          {isTopologiesMode ? (
            <>
          <button
            type="button"
                className={`tab-pill ${topologiesTab === "detail" ? "active" : ""}`}
                onClick={() => setActivePanel2Tab("detail")}
              >
                Detail
              </button>
              <button
                type="button"
                className={`tab-pill ${topologiesTab === "edit_topo" ? "active" : ""}`}
                onClick={() => setActivePanel2Tab("edit_topo")}
              >
                Edit topo
              </button>
              <button
                type="button"
                className={`tab-pill ${topologiesTab === "playground" ? "active" : ""}`}
                onClick={() => setActivePanel2Tab("playground")}
              >
                Playground
              </button>
            </>
          ) : isRunTopoMode ? (
            <>
              <button
                type="button"
                className={`tab-pill ${activePanel2Tab === "run" ? "active" : ""}`}
                onClick={() => setActivePanel2Tab("run")}
              >
                Run
          </button>
          <button
            type="button"
            className={`tab-pill ${activePanel2Tab === "results" ? "active" : ""}`}
            onClick={() => setActivePanel2Tab("results")}
          >
            Results
          </button>
          <button
            type="button"
            className={`tab-pill ${activePanel2Tab === "edit_topo" ? "active" : ""}`}
            onClick={() => setActivePanel2Tab("edit_topo")}
          >
            Edit topo
          </button>
          <button
            type="button"
            className={`tab-pill ${activePanel2Tab === "detail" ? "active" : ""}`}
            onClick={() => setActivePanel2Tab("detail")}
          >
            Detail
          </button>
            </>
          ) : isRunMultiMode ? (
            <>
              <button
                type="button"
                className={`tab-pill ${activePanel2Tab === "run" ? "active" : ""}`}
                onClick={() => setActivePanel2Tab("run")}
              >
                Run
              </button>
              <button
                type="button"
                className={`tab-pill ${activePanel2Tab === "detail" ? "active" : ""}`}
                onClick={() => setActivePanel2Tab("detail")}
              >
                Detail
              </button>
            </>
          ) : isResultsMode ? (
            <>
              <button
                type="button"
                className={`tab-pill ${activePanel2Tab === "results" ? "active" : ""}`}
                onClick={() => setActivePanel2Tab("results")}
              >
                Results
              </button>
              <button
                type="button"
                className={`tab-pill ${activePanel2Tab === "detail" ? "active" : ""}`}
                onClick={() => setActivePanel2Tab("detail")}
              >
                Detail
              </button>
            </>
          ) : (
            <>
              <button type="button" className="tab-pill active">
                Panel
              </button>
            </>
          )}
        </div>
        {rightExportContext ? (
          <button type="button" className="secondary-cta small right-panel-export-btn" onClick={onOpenExportModal}>
            Export CSV
          </button>
        ) : null}
      </header>

      <section className="right-panel-content ui-scroll">
        {activeMenu === "home" ? (
          homeToolTab === "ucb" ? (
            <HomeUcbSummaryPanel ucbTool={ucbTool} onFontScaleChange={updateUcbFontScale} />
          ) : (
            <HomeTemperatureSummaryPanel
              temperatureTool={temperatureTool}
              onFontScaleChange={updateTemperatureFontScale}
            />
          )
        ) : isTopologiesMode ? (
          isBatchGridView ? (
            <TopologiesEmptyPanel />
          ) : hasBatchOnly ? (
            topologiesTab === "edit_topo" ? (
              <>
                <div className="placeholder-card">
                  <p className="muted">Chọn một topology trong batch để chỉnh sửa tọa độ.</p>
                </div>
                <TopologyGridPreviewSettingsPanel
                  previewMaxNodesPercent={previewMaxNodesPercent}
                  setPreviewMaxNodesPercent={setPreviewMaxNodesPercent}
                  previewShowEdges={previewShowEdges}
                  setPreviewShowEdges={setPreviewShowEdges}
                />
              </>
            ) : (
              <>
                <BatchDetailPanel batch={focusedBatch} />
                <TopologyGridPreviewSettingsPanel
                  previewMaxNodesPercent={previewMaxNodesPercent}
                  setPreviewMaxNodesPercent={setPreviewMaxNodesPercent}
                  previewShowEdges={previewShowEdges}
                  setPreviewShowEdges={setPreviewShowEdges}
                />
              </>
            )
          ) : topologiesTab === "edit_topo" ? (
            <EditTopologyPanel
              selectedTopology={selectedTopology}
              isLoadingNodes={isLoadingNodes}
              topologyNodes={topologyNodes}
              onNodeBlur={handleNodeBlur}
              onNodeKeyDown={handleNodeKeyDown}
              onSave={saveTopology}
              isSaving={isSavingTopology}
            />
          ) : topologiesTab === "playground" ? (
            <PlaygroundPanel
              selectedTopology={selectedTopology}
              playgroundState={playgroundState}
              playgroundNextStateCount={playgroundNextStateCount}
              setPlaygroundMode={setPlaygroundMode}
              setPlaygroundSpreadMode={setPlaygroundSpreadMode}
              setPlaygroundViewSlot={setPlaygroundViewSlot}
              onReset={onResetPlayground}
              decisionTreeRowSpread={decisionTreeRowSpread}
              setDecisionTreeRowSpread={setDecisionTreeRowSpread}
              decisionTreeFontScale={decisionTreeFontScale}
              setDecisionTreeFontScale={setDecisionTreeFontScale}
              decisionTreeEdgeScale={decisionTreeEdgeScale}
              setDecisionTreeEdgeScale={setDecisionTreeEdgeScale}
              decisionTreeNodeScale={decisionTreeNodeScale}
              setDecisionTreeNodeScale={setDecisionTreeNodeScale}
              decisionTreeEdgeOpacity={decisionTreeEdgeOpacity}
              setDecisionTreeEdgeOpacity={setDecisionTreeEdgeOpacity}
              onSaveDecisionTreeLayoutDefaults={onSaveDecisionTreeLayoutDefaults}
            />
          ) : (
            <DetailPanel detail={topologyDetail} isLoading={isLoadingDetail} />
          )
        ) : isRunTopoMode || isRunMultiMode || isResultsMode ? (
          needsRunTopoSelection ? (
            <ContextPlaceholderPanel message="Chọn một topology để xem run, detail hoặc result tương ứng." />
          ) : isBatchResultsContext ? (
            <BatchRunResultSummaryPanel result={focusedBatchRunResult} />
          ) : needsResultsSelection ? (
            <ContextPlaceholderPanel message="Chưa có context nào để hiển thị ở panel phải." />
          ) : activePanel2Tab === "run" ? (
            isRunMultiMode ? (
              <RunMultiPanel
                form={runMultiForm}
                setForm={setRunMultiForm}
                onRun={runMultiTopologies}
                isRunningBatch={isRunningBatch}
                selectedAlgorithmMeta={selectedRunMultiAlgorithmMeta}
                runConfigForm={runMultiConfigForm}
                setRunConfigForm={setRunMultiConfigForm}
                runPresets={runPresets}
                loadRunPresets={loadRunPresets}
                setMessage={setMessage}
                parseApiError={parseApiError}
                presetWizard={runMultiWizard}
                setPresetWizard={setRunMultiWizard}
                algorithmDefaultConfigById={algorithmDefaultConfigById}
                setSharedRunConfigForBackbone={setSharedRunConfigForBackbone}
                runBackbone={runMultiBackbone}
                runMultiSubMode={runMultiSubMode}
                repeatTopologyId={repeatTopologyId}
                selectedTopology={selectedTopology}
                repeatRunCount={repeatRunCount}
                setRepeatRunCount={setRepeatRunCount}
              />
            ) : (
              <RunTopologyPanel
                form={runTopoForm}
                setForm={setRunTopoForm}
                selectedTopology={selectedTopology}
                onRun={runSingleTopology}
                isRunningSingle={isRunningSingle}
                selectedAlgorithmMeta={selectedAlgorithmMeta}
                runConfigForm={runTopoConfigForm}
                setRunConfigForm={setRunTopoConfigForm}
                runPresets={runPresets}
                loadRunPresets={loadRunPresets}
                setMessage={setMessage}
                parseApiError={parseApiError}
                presetWizard={runTopoWizard}
                setPresetWizard={setRunTopoWizard}
                algorithmDefaultConfigById={algorithmDefaultConfigById}
                setSharedRunConfigForBackbone={setSharedRunConfigForBackbone}
                runBackbone={runTopoBackbone}
              />
            )
        ) : activePanel2Tab === "results" ? (
              <ResultsPanel
                runHistoryItems={runHistoryItems}
                focusedBatchRunResult={focusedBatchRunResult}
                runSummaryPayload={runSummaryPayload}
              latestCompletedRun={latestCompletedRun}
              transmissionLastPayload={transmissionLastPayload}
              transmissionBestPayload={transmissionBestPayload}
              resultsViewMode={resultsViewMode}
              resultsEpochMode={resultsEpochMode}
              replaySlot={replaySlot}
              stateActionLastPayload={stateActionLastPayload}
              stateActionBestPayload={stateActionBestPayload}
              delayPerEpisodePayload={delayPerEpisodePayload}
              policyTracePayload={policyTracePayload}
              pathSignaturesPayload={pathSignaturesPayload}
              resolvedRunConfigPayload={resolvedRunConfigPayload}
              stateActionAllPayload={stateActionAllPayload}
              transmissionAllPayload={transmissionAllPayload}
              qTableAllEpochsPayload={qTableAllEpochsPayload}
              selectedEpisode={selectedEpisode}
              latestRunCapabilities={latestRunCapabilities}
            />
        ) : activePanel2Tab === "detail" ? (
            <>
              <DetailPanel detail={topologyDetail} isLoading={isLoadingDetail} />
              {isResultsMode ? (
                <DisplaySettingsPanel
                  settings={graphDisplaySettings}
                  setSettings={setGraphDisplaySettings}
                  bestDelayOverlayOpacity={bestDelayOverlayOpacity}
                  setBestDelayOverlayOpacity={setBestDelayOverlayOpacity}
                  onReset={resetGraphDisplaySettings}
                />
              ) : null}
            </>
          ) : (
          <EditTopologyPanel
            selectedTopology={selectedTopology}
            isLoadingNodes={isLoadingNodes}
            topologyNodes={topologyNodes}
            onNodeBlur={handleNodeBlur}
            onNodeKeyDown={handleNodeKeyDown}
            onSave={saveTopology}
            isSaving={isSavingTopology}
          />
          )
        ) : (
          <div className="placeholder-card">
            <p>Placeholder for this feature.</p>
          </div>
        )}
      </section>

      {isTopologiesMode || isRunTopoMode || isResultsMode ? null : (
      <footer className="right-panel-footer">
        <button type="button" className="secondary-run-btn" disabled>
          Run
        </button>
      </footer>
      )}
    </aside>
  );
}

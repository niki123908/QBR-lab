import { useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000/api";

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
  return fieldName;
}

function formatEnumOptionLabel(fieldName, option) {
  if (fieldName === "action_axis") {
    if (option === "broadcaster") return "Broadcaster";
    if (option === "receiver") return "Receiver";
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
  { id: "greedy", label: "GREEDY" }
];

function presetOptionLabel(p) {
  if (!p || typeof p !== "object") return "";
  const tag = p.backbone === "qbr" ? "QBR" : p.backbone === "greedy" ? "GREEDY" : String(p.backbone || "");
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
      "temperature_decay"
    ].includes(fieldName);
    if (policyType === "softmax" && isEpsilonField) return false;
    if (policyType === "epsilon_greedy" && isTemperatureField) return false;
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
  return (
    <div className="dynamic-config-grid">
      {visibleEntries.map(([fieldName, fieldSchema]) => {
        const rawType = fieldSchema?.type;
        const resolvedType = Array.isArray(rawType)
          ? rawType.find((t) => t !== "null") || "string"
          : rawType || "string";
        const currentValue = runConfigForm?.[fieldName];
        if (resolvedType === "boolean") {
          return (
            <label className="field-label inline-checkbox" key={fieldName}>
              <span>{formatConfigLabel(fieldName)}</span>
              <input
                type="checkbox"
                checked={Boolean(currentValue)}
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
          return (
            <label className="field-label" key={fieldName}>
              {formatConfigLabel(fieldName)}
              <select
                value={String(currentValue ?? enumOptions[0])}
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
      })}
      {selectedPolicyType === "softmax" ? (
        <>
          <label className="field-label">
            Temperature start mode
            <select
              value={temperatureStartMode}
              onChange={(e) =>
                setRunConfigForm((prev) => ({
                  ...prev,
                  temperature_start_mode: e.target.value
                }))
              }
            >
              <option value="manual">Manual</option>
              <option value="node_count_multiplier">By node count</option>
            </select>
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
      ) : null}
    </div>
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
    const algorithm_id = backboneId === "qbr" ? "qbr" : "greedy";
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
    const algorithm_id = backboneId === "qbr" ? "qbr" : "greedy";
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
                <select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) onWizardBackbonePick(v);
                  }}
                >
                  <option value="">Chọn backbone…</option>
                  {BACKBONE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
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
              <select value={currentBackbone} onChange={(e) => onIdleBackboneChange(e.target.value)}>
                {BACKBONE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
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
    const algorithm_id = backboneId === "qbr" ? "qbr" : "greedy";
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
    const algorithm_id = backboneId === "qbr" ? "qbr" : "greedy";
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
      <h4>Run multi-topos</h4>
      <label className="field-label">
        Selected batch
        <input type="text" value={form.batch_id || ""} disabled placeholder="Pick batch in Panel 1" />
      </label>
      <label className="field-label">
        Selected topologies
        <input type="text" value={(form.selected_topology_ids ?? []).length} disabled />
      </label>

      <div className="preset-zone">
        {phase !== "idle" ? (
          <>
            <p className="preset-banner">Đang tạo preset nháp</p>
            {phase === "add_backbone" ? (
      <label className="field-label">
                Backbone
                <select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) onWizardBackbonePick(v);
                  }}
                >
                  <option value="">Chọn backbone…</option>
                  {BACKBONE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
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
              <select value={currentBackbone} onChange={(e) => onIdleBackboneChange(e.target.value)}>
                {BACKBONE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
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
        Path signature: lưu path CSV, delay per episode, state/transmission best epoch. Delay per episode: chỉ lưu CSV delay theo episode.
      </p>

      <button
        className="primary-cta"
        disabled={isRunningBatch || !(form.selected_topology_ids ?? []).length || runBlocked}
        type="submit"
      >
        {isRunningBatch ? "Submitting..." : "Run multi"}
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

function PolicyTraceLineChart({ rows }) {
  if (!rows || rows.length === 0) {
    return <p className="muted">No policy trace data.</p>;
  }
  const width = 320;
  const height = 120;
  const sampleRow = rows[0] ?? {};
  const isSoftmaxTrace = "temperature_before" in sampleRow || "temperature_after" in sampleRow;
  const beforeKey = isSoftmaxTrace ? "temperature_before" : "epsilon_before";
  const afterKey = isSoftmaxTrace ? "temperature_after" : "epsilon_after";
  const metricLabel = isSoftmaxTrace ? "Temperature" : "Epsilon";
  const before = rows.map((row) => Number(row[beforeKey])).filter((n) => Number.isFinite(n));
  const after = rows.map((row) => Number(row[afterKey])).filter((n) => Number.isFinite(n));
  const values = [...before, ...after];
  if (values.length === 0) return <p className="muted">No policy trace data.</p>;
  const startValue = before.length > 0 ? before[0] : values[0];
  const endValue = after.length > 0 ? after[after.length - 1] : values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pointsFor = (series) =>
    series
      .map((val, idx) => {
        const x = (idx / Math.max(1, series.length - 1)) * (width - 16) + 8;
        const y = height - ((val - min) / span) * (height - 20) - 10;
        return `${x},${y}`;
      })
      .join(" ");
  return (
    <div className="delay-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="delay-chart">
        <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
        <polyline points={pointsFor(before)} fill="none" stroke="#4E79A7" strokeWidth="2" />
        <polyline points={pointsFor(after)} fill="none" stroke="#E15759" strokeWidth="2" />
      </svg>
      <div className="delay-chart-meta">
        <span>Episodes: {rows.length}</span>
        <span>
          {isSoftmaxTrace
            ? `Tem start: ${startValue.toFixed(3)} | Tem end: ${endValue.toFixed(3)}`
            : `Epsilon start: ${startValue.toFixed(3)} | Epsilon end: ${endValue.toFixed(3)}`}
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
  const hasPolicyTrace = latestRunCapabilities?.has_policy_trace ?? true;
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
  return (
    <div className="results-panel">
      {focusedBatchRunResult?.resolved_run_config ? (
        <>
          <h4>Resolved run config</h4>
          <pre className="run-config-readonly">{JSON.stringify(focusedBatchRunResult.resolved_run_config, null, 2)}</pre>
          <hr className="results-divider" />
        </>
      ) : null}
      {hasEpisodeSeries ? (
        <>
          <h4>Delay per episode</h4>
          <DelayLineChart rows={delayRows} />
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
          <hr className="results-divider" />
          <h4>Resolved run config</h4>
          {resolvedRunConfigPayload ? (
            <pre className="run-config-readonly">{JSON.stringify(resolvedRunConfigPayload, null, 2)}</pre>
          ) : (
            <p className="muted">No resolved run config snapshot.</p>
          )}
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

function PlaygroundPanel({
  selectedTopology,
  playgroundState,
  playgroundNextStateCount,
  setPlaygroundMode,
  setPlaygroundViewSlot,
  onReset
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
        <dl>
          <dt>Topology</dt>
          <dd>{selectedTopology?.topology_name ?? "-"}</dd>
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
      <p className="muted">Adjust tau and q-value sliders in Main Panel 1 to see softmax probabilities update in real time.</p>
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
        <dd>{result.batch_run_id ?? "-"}</dd>
        <dt>Status</dt>
        <dd>{result.batch_status ?? "-"}</dd>
        <dt>Topologies with results</dt>
        <dd>{topologyCount}</dd>
        <dt>Density groups</dt>
        <dd>{densityGroupCount}</dd>
      </dl>
      {result.resolved_run_config ? (
        <>
          <hr className="results-divider" />
          <h4>Resolved run config</h4>
          <pre className="run-config-readonly">{JSON.stringify(result.resolved_run_config, null, 2)}</pre>
        </>
      ) : null}
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
  setPlaygroundMode,
  setPlaygroundViewSlot,
  onResetPlayground
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
      </header>

      <section className="right-panel-content">
        {activeMenu === "home" ? (
          <HomeTemperatureSummaryPanel
            temperatureTool={temperatureTool}
            onFontScaleChange={updateTemperatureFontScale}
          />
        ) : isTopologiesMode ? (
          isBatchGridView ? (
            <TopologiesEmptyPanel />
          ) : hasBatchOnly ? (
            topologiesTab === "edit_topo" ? (
              <div className="placeholder-card">
                <p className="muted">Chọn một topology trong batch để chỉnh sửa tọa độ.</p>
              </div>
            ) : (
              <BatchDetailPanel batch={focusedBatch} />
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
              setPlaygroundViewSlot={setPlaygroundViewSlot}
              onReset={onResetPlayground}
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

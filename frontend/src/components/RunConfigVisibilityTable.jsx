import { Fragment, useEffect, useMemo, useState } from "react";
import {
  buildConfigRowGroups,
  formatConfigLabel,
  formatConfigValue,
  formatEnumOptionLabel,
  inferDefaultVisibleKeys,
  mergeDisplayConfig
} from "../utils/runConfigDisplay.js";

function presetShortLabel(result) {
  const name = result?.preset_name ?? result?.preset_id ?? "";
  if (!name) return "—";
  const match = String(name).match(/^(A\d+)/i);
  return match ? match[1].toUpperCase() : String(name);
}

export default function RunConfigVisibilityTable({ result }) {
  const { merged, policyType, blocks } = useMemo(() => buildConfigRowGroups(result), [result]);
  const presetLabel = result?.preset_name ?? result?.preset_id ?? "—";
  const policyLabel = formatEnumOptionLabel("policy_type", policyType);
  const actionAxisLabel = formatEnumOptionLabel("action_axis", merged?.action_axis ?? "broadcaster");
  const aggregationLabel = formatEnumOptionLabel(
    "action_aggregation_mode",
    merged?.action_aggregation_mode ?? "off"
  );

  const allFieldKeys = useMemo(() => blocks.flatMap((block) => block.fields), [blocks]);

  const [visibleKeys, setVisibleKeys] = useState(() => new Set(inferDefaultVisibleKeys(merged)));
  const [selectedHiddenKey, setSelectedHiddenKey] = useState("");

  useEffect(() => {
    setVisibleKeys(new Set(inferDefaultVisibleKeys(merged)));
    setSelectedHiddenKey("");
  }, [result?.batch_run_id, result?.run_id, policyType]);

  if (!allFieldKeys.length && !result?.algorithm_id) {
    return <p className="muted">No run config stored for this batch.</p>;
  }

  const setFieldVisible = (fieldName, visible) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (visible) next.add(fieldName);
      else next.delete(fieldName);
      return next;
    });
  };

  const setBlockVisible = (block, visible) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      block.fields.forEach((fieldName) => {
        if (visible) next.add(fieldName);
        else next.delete(fieldName);
      });
      return next;
    });
  };

  const applyDefaults = () => setVisibleKeys(new Set(inferDefaultVisibleKeys(merged)));
  const showAll = () => setVisibleKeys(new Set(allFieldKeys));
  const hideAll = () => setVisibleKeys(new Set());

  const visibleCount = allFieldKeys.filter((key) => visibleKeys.has(key)).length;
  const hiddenFieldKeys = allFieldKeys.filter((key) => !visibleKeys.has(key));
  const hiddenFieldOptions = hiddenFieldKeys.map((key) => ({ key, label: formatConfigLabel(key) }));
  const { runConfig, resolved } = mergeDisplayConfig(result);
  const hasResolved = resolved && typeof resolved === "object" && Object.keys(resolved).length > 0;

  return (
    <div className="run-config-visibility-panel">
      <div className="run-config-visibility-toolbar">
        <div className="run-config-summary-chips">
          <span className="run-config-chip run-config-chip--preset" title={presetLabel}>
            {presetShortLabel(result)}
          </span>
          <span className="run-config-chip run-config-chip--policy">{policyLabel}</span>
          <span className="run-config-chip run-config-chip--muted">{actionAxisLabel}</span>
          <span className="run-config-chip run-config-chip--muted" title="Action aggregation">
            {aggregationLabel}
          </span>
        </div>
        <div className="run-config-visibility-actions">
          <button type="button" className="secondary-cta small" onClick={applyDefaults}>
            Policy only
          </button>
          <button type="button" className="secondary-cta small" onClick={showAll}>
            Show all
          </button>
          <button type="button" className="secondary-cta small" onClick={hideAll}>
            Hide all
          </button>
        </div>
      </div>

      <p className="muted run-config-visibility-hint">
        {visibleCount} / {allFieldKeys.length} parameters visible
        {hasResolved ? " · values from resolved config" : ""}
      </p>
      {hiddenFieldOptions.length ? (
        <div className="run-config-restore-row">
          <select
            value={selectedHiddenKey}
            onChange={(e) => setSelectedHiddenKey(e.target.value)}
            className="run-config-restore-select"
          >
            <option value="">Add hidden parameter…</option>
            {hiddenFieldOptions.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary-cta small"
            disabled={!selectedHiddenKey}
            onClick={() => {
              if (!selectedHiddenKey) return;
              setFieldVisible(selectedHiddenKey, true);
              setSelectedHiddenKey("");
            }}
          >
            Add
          </button>
        </div>
      ) : null}

      <div className="run-config-visibility-table-wrap">
        <table className="run-config-visibility-table">
          <thead>
            <tr>
              <th className="run-config-col-show" scope="col">
                Show
              </th>
              <th className="run-config-col-field" scope="col">
                Parameter
              </th>
              <th className="run-config-col-value" scope="col">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((block) => {
              const visibleFields = block.fields.filter((f) => visibleKeys.has(f));
              const blockVisibleCount = visibleFields.length;
              const blockAllOn = blockVisibleCount === block.fields.length;
              const blockSomeOn = blockVisibleCount > 0 && !blockAllOn;
              if (!blockVisibleCount) return null;
              return (
                <Fragment key={block.id}>
                  <tr className="run-config-group-row">
                    <td className="run-config-col-show">
                      <input
                        type="checkbox"
                        className="run-config-group-check"
                        checked={blockAllOn}
                        ref={(el) => {
                          if (el) el.indeterminate = blockSomeOn;
                        }}
                        onChange={(e) => setBlockVisible(block, e.target.checked)}
                        aria-label={`Toggle ${block.title}`}
                      />
                    </td>
                    <td colSpan={2} className="run-config-group-title">
                      {block.title}
                    </td>
                  </tr>
                  {visibleFields.map((fieldName) => {
                    const value = merged[fieldName];
                    const submitted = runConfig?.[fieldName];
                    const resolvedVal = resolved?.[fieldName];
                    const differs =
                      hasResolved &&
                      submitted !== undefined &&
                      resolvedVal !== undefined &&
                      String(submitted) !== String(resolvedVal);
                    return (
                      <tr key={`${block.id}-${fieldName}`} className="run-config-field-row">
                        <td className="run-config-col-show">
                          <input
                            type="checkbox"
                            checked
                            onChange={(e) => setFieldVisible(fieldName, e.target.checked)}
                            aria-label={`Show ${formatConfigLabel(fieldName)}`}
                          />
                        </td>
                        <td className="run-config-col-field">{formatConfigLabel(fieldName)}</td>
                        <td className="run-config-col-value">
                          <span className="run-config-value-text">{formatConfigValue(fieldName, value)}</span>
                          {differs ? (
                            <span className="run-config-value-note muted" title={`Submitted: ${formatConfigValue(fieldName, submitted)}`}>
                              ≠ submitted
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {result.batch_name ? (
        <dl className="batch-run-config-meta batch-run-config-meta--compact">
          <dt>Batch</dt>
          <dd>{result.batch_name}</dd>
        </dl>
      ) : null}
    </div>
  );
}

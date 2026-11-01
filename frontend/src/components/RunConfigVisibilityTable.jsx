import { Fragment, useMemo } from "react";
import {
  buildConfigRowGroups,
  formatConfigLabel,
  formatConfigValue,
  formatEnumOptionLabel,
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
  const { runConfig, resolved } = mergeDisplayConfig(result);
  const hasResolved = resolved && typeof resolved === "object" && Object.keys(resolved).length > 0;

  if (!allFieldKeys.length && !result?.algorithm_id) {
    return <p className="muted">No run config stored for this batch.</p>;
  }

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
      </div>

      {hasResolved ? <p className="muted run-config-visibility-hint">Values from resolved config</p> : null}

      <div className="run-config-visibility-table-wrap">
        <table className="run-config-visibility-table">
          <thead>
            <tr>
              <th className="run-config-col-field" scope="col">
                Parameter
              </th>
              <th className="run-config-col-value" scope="col">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((block) => (
              <Fragment key={block.id}>
                <tr className="run-config-group-row">
                  <td colSpan={2} className="run-config-group-title">
                    {block.title}
                  </td>
                </tr>
                {block.fields.map((fieldName) => {
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
                      <td className="run-config-col-field">{formatConfigLabel(fieldName)}</td>
                      <td className="run-config-col-value">
                        <span className="run-config-value-text">{formatConfigValue(fieldName, value)}</span>
                        {differs ? (
                          <span
                            className="run-config-value-note muted"
                            title={`Submitted: ${formatConfigValue(fieldName, submitted)}`}
                          >
                            ≠ submitted
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
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

import { useEffect, useMemo, useState } from "react";
import { downloadCsv } from "../export/csvUtils.js";
import { getContextColumns, runExportDownload } from "../export/exportContexts.js";

export default function CsvExportModal({ open, snapshot, context, surface = "main", onClose }) {
  const [profileId, setProfileId] = useState(null);
  const [rowMode, setRowMode] = useState("summary");
  const [compareSide, setCompareSide] = useState(null);
  const [selectedKeys, setSelectedKeys] = useState([]);

  const activeProfileId = profileId ?? context?.activeProfileId ?? context?.profiles?.[0]?.id ?? null;

  const columnDefs = useMemo(() => {
    if (!context) return [];
    return getContextColumns(context, { profileId: activeProfileId, rowMode });
  }, [context, activeProfileId, rowMode]);

  useEffect(() => {
    if (!open || !context) return;
    setProfileId(context.activeProfileId ?? context.profiles?.[0]?.id ?? null);
    setRowMode(context.defaultRowMode ?? "summary");
    setCompareSide(context.defaultCompareSide ?? context.compareSides?.[0]?.id ?? null);
    const cols = getContextColumns(context, {
      profileId: context.activeProfileId ?? context.profiles?.[0]?.id,
      rowMode: context.defaultRowMode ?? "summary"
    });
    setSelectedKeys(cols.filter((c) => c.default !== false).map((c) => c.key));
  }, [open, context?.id, context?.title]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !context?.profiles?.length) return;
    const cols = getContextColumns(context, { profileId: activeProfileId, rowMode });
    setSelectedKeys(cols.filter((c) => c.default !== false).map((c) => c.key));
  }, [activeProfileId, rowMode, open, context?.id]);

  if (!open || !context) return null;

  const disabled = Boolean(context.disabledReason);
  const groupedColumns = columnDefs.reduce((acc, col) => {
    const group = col.group ?? "Columns";
    if (!acc[group]) acc[group] = [];
    acc[group].push(col);
    return acc;
  }, {});

  const previewOptions = {
    profileId: activeProfileId,
    rowMode,
    compareSide,
    selectedKeys
  };

  let previewRowCount = 0;
  if (!disabled && snapshot && context.buildRows) {
    try {
      previewRowCount = context.buildRows(snapshot, previewOptions).length;
    } catch {
      previewRowCount = 0;
    }
  }

  const toggleColumn = (key) => {
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const selectAllColumns = () => setSelectedKeys(columnDefs.map((c) => c.key));
  const clearColumns = () => setSelectedKeys([]);

  const handleDownload = () => {
    if (disabled || !selectedKeys.length) return;
    const { csv, filename, rowCount } = runExportDownload(snapshot, context, previewOptions);
    if (!rowCount) return;
    downloadCsv(csv, filename);
    onClose?.();
  };

  return (
    <div className="modal-overlay csv-export-overlay" onClick={onClose}>
      <div
        className="modal-card csv-export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="csv-export-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="csv-export-title">Export CSV</h3>
        <p className="modal-message csv-export-context-title">{context.title}</p>
        {surface === "right" ? <p className="muted csv-export-surface-hint">Right panel export</p> : null}
        {context.warning ? <p className="csv-export-warning">{context.warning}</p> : null}
        {disabled ? (
          <p className="csv-export-disabled">{context.disabledReason}</p>
        ) : (
          <>
            {context.profiles?.length > 1 ? (
              <div className="csv-export-option-row">
                <span className="field-label-span">Dataset</span>
                <select value={activeProfileId ?? ""} onChange={(e) => setProfileId(e.target.value)}>
                  {context.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {context.compareSides?.length ? (
              <div className="csv-export-option-row">
                <span className="field-label-span">Compare side</span>
                <div className="segmented-toggle segmented-toggle--dense">
                  {context.compareSides.map((side) => (
                    <button
                      key={side.id}
                      type="button"
                      className={`segment-btn ${compareSide === side.id ? "active" : ""}`}
                      onClick={() => setCompareSide(side.id)}
                    >
                      {side.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {context.rowModes?.length ? (
              <div className="csv-export-option-row">
                <span className="field-label-span">Row format</span>
                <div className="segmented-toggle segmented-toggle--dense">
                  {context.rowModes.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      className={`segment-btn ${rowMode === mode.id ? "active" : ""}`}
                      onClick={() => setRowMode(mode.id)}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="csv-export-columns-toolbar">
              <span className="field-label-span">Columns</span>
              <div className="csv-export-columns-actions">
                <button type="button" className="secondary-cta small" onClick={selectAllColumns}>
                  Select all
                </button>
                <button type="button" className="secondary-cta small" onClick={clearColumns}>
                  Clear
                </button>
              </div>
            </div>

            <div className="export-column-list ui-scroll">
              {Object.entries(groupedColumns).map(([group, cols]) => (
                <div key={group} className="export-column-group">
                  <div className="export-column-group-title">{group}</div>
                  {cols.map((col) => (
                    <label key={col.key} className="export-column-check">
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(col.key)}
                        onChange={() => toggleColumn(col.key)}
                      />
                      <span>{col.label}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>

            <p className="muted csv-export-preview">{previewRowCount.toLocaleString()} row(s) will be exported</p>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="secondary-cta" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-cta small"
            disabled={disabled || !selectedKeys.length || previewRowCount === 0}
            onClick={handleDownload}
          >
            Download CSV
          </button>
        </div>
      </div>
    </div>
  );
}

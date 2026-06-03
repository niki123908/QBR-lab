export default function RunBatchNameModal({
  open,
  value,
  setValue,
  defaultLabel,
  onCancel,
  onConfirm,
  isSubmitting = false
}) {
  if (!open) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <h3>Tên kết quả batch run</h3>
        <p className="muted">
          Để trống sẽ dùng mặc định: <strong>{defaultLabel}</strong>
        </p>
        <input
          autoFocus
          className="modal-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConfirm();
            }
          }}
          placeholder={defaultLabel}
          disabled={isSubmitting}
        />
        <div className="modal-actions">
          <button type="button" className="secondary-cta" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
          <button type="button" className="primary-cta small" onClick={onConfirm} disabled={isSubmitting}>
            {isSubmitting ? "Starting…" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}

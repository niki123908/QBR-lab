/** Policy trace chart (epsilon / softmax / UCB) from parsed CSV rows. */
export default function PolicyTraceLineChart({ rows }) {
  if (!rows || rows.length === 0) {
    return <p className="muted">No policy trace data.</p>;
  }
  const width = 320;
  const height = 120;
  const sampleRow = rows[0] ?? {};
  const isUcbTrace = "global_t_before" in sampleRow || "global_t_after" in sampleRow;
  const isSoftmaxTrace =
    !isUcbTrace && ("temperature_before" in sampleRow || "temperature_after" in sampleRow);
  const beforeKey = isUcbTrace ? "global_t_before" : isSoftmaxTrace ? "temperature_before" : "epsilon_before";
  const afterKey = isUcbTrace ? "global_t_after" : isSoftmaxTrace ? "temperature_after" : "epsilon_after";
  const before = rows.map((row) => Number(row[beforeKey])).filter((n) => Number.isFinite(n));
  const after = rows.map((row) => Number(row[afterKey])).filter((n) => Number.isFinite(n));
  const values = [...before, ...after];
  if (values.length === 0) return <p className="muted">No policy trace data.</p>;
  const startValue = before.length > 0 ? before[0] : values[0];
  const endValue = after.length > 0 ? after[after.length - 1] : values[values.length - 1];
  const formatTraceValue = (value) => (isUcbTrace ? String(Math.round(value)) : Number(value).toFixed(3));
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
          {isUcbTrace
            ? `Global t start: ${formatTraceValue(startValue)} | Global t end: ${formatTraceValue(endValue)}`
            : isSoftmaxTrace
              ? `Tem start: ${formatTraceValue(startValue)} | Tem end: ${formatTraceValue(endValue)}`
              : `Epsilon start: ${formatTraceValue(startValue)} | Epsilon end: ${formatTraceValue(endValue)}`}
        </span>
      </div>
    </div>
  );
}

const X_MAX = 1000;
const Y_MAX = 1000;

export default function CumulativeUniquePathChart({ rows }) {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) {
    return <p className="muted">No path signature data for cumulative chart.</p>;
  }

  const width = 320;
  const height = 140;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 30;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const xAtEpisode = (episode) => padL + (Math.max(0, Math.min(X_MAX, Number(episode))) / X_MAX) * chartW;
  const yAtCount = (count) => {
    const value = Math.max(0, Math.min(Y_MAX, Number(count) || 0));
    return padT + chartH - (value / Y_MAX) * chartH;
  };

  const points = data
    .map((row) => `${xAtEpisode(row.episode)},${yAtCount(row.unique_paths_so_far)}`)
    .join(" ");

  return (
    <div className="delay-chart-wrap cumulative-unique-path-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="delay-chart">
        <rect x="0" y="0" width={width} height={height} fill="#fbfbff" />
        {[0, Y_MAX].map((tick) => (
          <g key={`yt-${tick}`}>
            <line
              x1={padL}
              x2={padL + chartW}
              y1={yAtCount(tick)}
              y2={yAtCount(tick)}
              stroke="#e8eaf5"
              strokeWidth="1"
            />
            <text x={padL - 6} y={yAtCount(tick) + 4} textAnchor="end" fontSize="10" fill="#5a6080">
              {tick}
            </text>
          </g>
        ))}
        <line x1={padL} y1={padT + chartH} x2={padL + chartW} y2={padT + chartH} stroke="#c8cce0" strokeWidth="1" />
        <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="#c8cce0" strokeWidth="1" />
        <polyline points={points} fill="none" stroke="#059669" strokeWidth="2" />
        <text x={padL} y={height - 8} textAnchor="start" fontSize="10" fill="#5a6080">
          0
        </text>
        <text x={padL + chartW} y={height - 8} textAnchor="end" fontSize="10" fill="#5a6080">
          {X_MAX}
        </text>
      </svg>
      <div className="delay-chart-meta">
        <span>Episodes: {data.length}</span>
        <span>Final unique paths: {data[data.length - 1]?.unique_paths_so_far ?? 0}</span>
      </div>
    </div>
  );
}

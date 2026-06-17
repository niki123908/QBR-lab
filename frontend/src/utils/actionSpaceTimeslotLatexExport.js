const CANDIDATE_COLOR = "377eb8";
const GROUP_COLOR = "e41a1c";

function latexEscape(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/[&%$#_{}]/g, (ch) => {
      if (ch === "&") return "\\&";
      if (ch === "%") return "\\%";
      if (ch === "$") return "\\$";
      if (ch === "#") return "\\#";
      if (ch === "_") return "\\_";
      if (ch === "{") return "\\{";
      if (ch === "}") return "\\}";
      return ch;
    });
}

function sanitizeTexStem(name) {
  return (
    String(name || "action_space_timeslot")
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "action_space_timeslot"
  );
}

function formatCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1000 || Number.isInteger(n)) return String(Math.round(n));
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(3).replace(/\.?0+$/, "");
}

/**
 * @param {{ compareRows: object[], axisText: string, topologyName?: string }} opts
 */
export function buildActionSpaceTimeslotLatex({ compareRows, axisText, topologyName = "" }) {
  const rows = Array.isArray(compareRows) ? compareRows : [];
  if (!rows.length) return "";

  const xCoords = rows.map((r) => String(r.timeslot)).join(",");
  const candCoords = rows
    .map((r) => `(${r.timeslot},${formatCoord(r.mean_candidate_count)})`)
    .join(" ");
  const groupCoords = rows.map((r) => `(${r.timeslot},${formatCoord(r.mean_group_count)})`).join(" ");

  const axisLabel = axisText === "receive" ? "Receive" : "Broadcast";
  const caption = topologyName
    ? `Mean ${axisText} candidate and group count by timeslot (${topologyName})`
    : `Mean ${axisText} candidate and group count by timeslot`;

  return [
    `% Action-space timeslot chart (${axisLabel})`,
    "% Requires: \\usepackage{tikz}, \\usepackage{pgfplots}, \\pgfplotsset{compat=1.18}",
    "",
    "\\begin{figure}[h]",
    "\\centering",
    "\\begin{tikzpicture}",
    "\\begin{axis}[",
    "    width=0.86\\columnwidth,",
    "    height=0.52\\columnwidth,",
    "    ybar,",
    "    bar width=5pt,",
    "    enlarge x limits=0.08,",
    "    symbolic x coords={" + xCoords + "},",
    "    xtick=data,",
    "    xlabel={Timeslot},",
    `    ylabel={Mean ${latexEscape(axisText)} count},`,
    "    legend style={at={(0.5,-0.14)}, anchor=north, legend columns=2},",
    "    grid=major,",
    "    grid style={dashed, gray!35},",
    "]",
    `\\addplot[fill=none, draw=${CANDIDATE_COLOR}, line width=1.2pt, bar shift=-3pt] coordinates {${candCoords}};`,
    "\\addlegendentry{Candidate}",
    `\\addplot[fill=none, draw=${GROUP_COLOR}, line width=1.2pt, bar shift=3pt] coordinates {${groupCoords}};`,
    "\\addlegendentry{Group}",
    "\\end{axis}",
    "\\end{tikzpicture}",
    `\\caption{${latexEscape(caption)}}`,
    `\\label{fig:${sanitizeTexStem(`action_space_${axisText}`)}}`,
    "\\end{figure}",
    ""
  ].join("\n");
}

export function downloadActionSpaceTimeslotLatex(opts) {
  const tex = buildActionSpaceTimeslotLatex(opts);
  if (!tex.trim()) return false;
  const stem = sanitizeTexStem(`action_space_${opts?.axisText ?? "timeslot"}`);
  const blob = new Blob([tex], { type: "application/x-tex;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${stem}.tex`;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

export function buildActionSpaceTimeslotCsv(compareRows) {
  const rows = Array.isArray(compareRows) ? compareRows : [];
  const lines = [
    "timeslot,mean_candidate_count,mean_group_count,n_unique_paths",
    ...rows.map(
      (r) =>
        `${String(r.timeslot)},${String(r.mean_candidate_count ?? "")},${String(r.mean_group_count ?? "")},${String(r.n_unique_paths ?? "")}`
    )
  ];
  return lines.join("\n");
}

export function downloadActionSpaceTimeslotCsv(compareRows, axisText) {
  const csv = buildActionSpaceTimeslotCsv(compareRows);
  if (!csv.trim()) return false;
  const stem = sanitizeTexStem(`action_space_${axisText ?? "timeslot"}_candidate_vs_group`);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${stem}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

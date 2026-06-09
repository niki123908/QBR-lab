import { defaultPanelTitle, resolveYAxisDomain } from "./compareChartAppearance.js";
import { materializeLowerBoundRows, findQbrSideForLowerBound } from "./compareChartLowerBound.js";
import { buildDensityMeanRows, buildPerDensityChartRows } from "./compareChartTransforms.js";

const LATEX_AXIS_WIDTH = "0.86\\columnwidth";
const LATEX_AXIS_HEIGHT = "0.688\\columnwidth";
const LATEX_LINE_WIDTH_PT = 1.2;
const LATEX_MARK_SIZE_PT = 2.5;

/** ColorBrewer Set1 — fixed palette for IEEE-style LaTeX figures. */
const LATEX_EXPORT_SIDE_COLORS = {
  A: "e41a1c",
  B: "377eb8",
  C: "4daf4a",
  D: "984ea3",
  LB: "ff7f00"
};

const LATEX_EXPORT_SIDE_MARKS = {
  A: "o",
  B: "square",
  C: "triangle",
  D: "diamond",
  LB: "o"
};

const PATH_COUNT_METRICS = new Set(["unique_path_count", "best_delay_unique_path_count"]);

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
    })
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}

function sanitizeTexStem(name) {
  return (
    String(name || "chart")
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "chart"
  );
}

function colorDefName(dataKey) {
  return `qbr${String(dataKey).replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function hexToLatexRgb(hex) {
  const h = String(hex || "#333333").replace("#", "");
  if (h.length === 6) return h.toLowerCase();
  if (h.length === 3) {
    return h
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase();
  }
  return "333333";
}

function latexHexForDef(def) {
  const side = String(def?.side ?? "").trim();
  if (side && LATEX_EXPORT_SIDE_COLORS[side]) return LATEX_EXPORT_SIDE_COLORS[side];
  return hexToLatexRgb(def?.color);
}

function latexMarkForDef(def) {
  const side = String(def?.side ?? "").trim();
  if (side && LATEX_EXPORT_SIDE_MARKS[side]) return LATEX_EXPORT_SIDE_MARKS[side];
  return pgfMark(def?.marker || "circle");
}

function formatCoordNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1000 || Number.isInteger(n)) return String(Math.round(n));
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(3).replace(/\.?0+$/, "");
}

function filterPlotDefs(defs, chartMode) {
  const hasConvergenceMetric = defs.some((def) => def.metricKey === "convergence_count");
  const shouldPlotConvergenceSeries = chartMode === "densityMean" && hasConvergenceMetric;
  return shouldPlotConvergenceSeries ? defs : defs.filter((def) => def.metricKey !== "convergence_count");
}

function materializeRowsForDefs(rows, defs, compareChartInput) {
  return materializeLowerBoundRows(rows, defs, findQbrSideForLowerBound(compareChartInput));
}

function shouldUseLeadingZeroPad(rows, xKey, chartType, enabled) {
  if (!enabled) return false;
  if (!rows?.length) return false;
  if (chartType === "bar" && rows.length <= 8) return false;
  const firstX = Number(rows[0]?.[xKey]);
  return Number.isFinite(firstX) && firstX > 0;
}

function withLeadingZeroRow(rows, xKey, defs) {
  if (!rows.length) return rows;
  const firstX = Number(rows[0]?.[xKey]);
  if (!Number.isFinite(firstX) || firstX <= 0) return rows;
  const row = { ...rows[0], [xKey]: 0 };
  defs.forEach((def) => {
    row[def.dataKey] = null;
  });
  return [row, ...rows];
}

function axisDomainForLine(rows, defs, yPaddingPct = 8) {
  const values = [];
  defs.forEach((def) => {
    rows.forEach((row) => {
      const n = Number(row[def.dataKey]);
      if (Number.isFinite(n)) values.push(n);
    });
  });
  if (!values.length) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1e-9, max - min);
  const pad = span * (Math.max(0, Number(yPaddingPct) || 0) / 100);
  const lo = Math.min(0, min - pad);
  const hi = max + pad;
  return [lo, hi > lo ? hi : lo + 1];
}

function axisDomainForBar(rows, defs, yPaddingPct = 8) {
  const values = [];
  defs.forEach((def) => {
    rows.forEach((row) => {
      const n = Number(row[def.dataKey]);
      if (Number.isFinite(n)) values.push(n);
    });
  });
  if (!values.length) return [0, 1];
  const max = Math.max(...values);
  const span = Math.max(1e-9, max);
  const pad = span * (Math.max(0, Number(yPaddingPct) || 0) / 100);
  return [0, Math.ceil(max + pad)];
}

function computeAutoYDomain({ rows, plotDefs, chartType, chartMode, ui }) {
  const convergenceOnly = plotDefs.length > 0 && plotDefs.every((def) => def.metricKey === "convergence_count");
  if (convergenceOnly) return [0, 100];
  const pathOnly = plotDefs.length > 0 && plotDefs.every((def) => PATH_COUNT_METRICS.has(def.metricKey));
  if (pathOnly) return [0, 1000];
  return chartType === "bar"
    ? axisDomainForBar(rows, plotDefs, ui?.yPaddingPct ?? 8)
    : axisDomainForLine(rows, plotDefs, ui?.yPaddingPct ?? 8);
}

function prepareDrawRows(rows, defs, chartType, ui, xKey, compareChartInput) {
  const normalized = materializeRowsForDefs(rows, defs, compareChartInput);
  const useZeroPad =
    chartType === "bar" && shouldUseLeadingZeroPad(normalized, xKey, chartType, ui?.leadingZeroPad !== false);
  return useZeroPad ? withLeadingZeroRow(normalized, xKey, defs) : normalized;
}

function pgfMark(marker) {
  const map = {
    circle: "o",
    cross: "x",
    triangle: "triangle",
    diamond: "diamond",
    square: "square",
    none: "none"
  };
  return map[marker] || "o";
}

function buildCoordinates(rows, xKey, dataKey) {
  const parts = [];
  rows.forEach((row) => {
    const x = formatCoordNum(row[xKey]);
    const y = formatCoordNum(row[dataKey]);
    if (x == null || y == null) return;
    parts.push(`(${x},${y})`);
  });
  return parts.join(" ");
}

function buildXTickBlock(rows, xKey, chartMode) {
  const xs = rows.map((row) => formatCoordNum(row[xKey])).filter(Boolean);
  const labels = rows.map((row) => {
    if (chartMode === "densityMean" && row.densityLabel != null) {
      return latexEscape(row.densityLabel);
    }
    const x = row[xKey];
    if (Number(x) === 0) return "0*";
    return latexEscape(String(x));
  });
  if (!xs.length) return "";
  return `xtick={${xs.join(",")}},\n    xticklabels={${labels.join(",")}},`;
}

function legendAxisPosition(drawRows, xKey, yDomain) {
  const xs = drawRows.map((row) => Number(row[xKey])).filter(Number.isFinite);
  const [ymin, ymax] = yDomain;
  const spanY = Math.max(1e-9, ymax - ymin);
  if (!xs.length) {
    return { legendX: "0", legendY: formatCoordNum(ymin + 0.05 * spanY) ?? "0" };
  }
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const spanX = Math.max(1e-9, xMax - xMin);
  return {
    legendX: formatCoordNum(xMin + 0.025 * spanX),
    legendY: formatCoordNum(ymin + 0.05 * spanY)
  };
}

function legendColumnCount(seriesCount) {
  if (seriesCount <= 1) return 1;
  if (seriesCount <= 4) return 2;
  return Math.min(3, seriesCount);
}

function buildAxisOptions(ui, yDomain, xTickBlock, plotDefs, drawRows, xKey) {
  const [ymin, ymax] = yDomain;
  const lines = [
    `width=${LATEX_AXIS_WIDTH}`,
    `height=${LATEX_AXIS_HEIGHT}`,
    "enlarge limits=false",
    "tick label style={font=\\fontsize{7}{8}\\selectfont}",
    "label style={font=\\fontsize{8}{9}\\selectfont}",
    "ymajorgrids=true",
    "xmajorgrids=true",
    "grid style=dashed",
    `ymin=${formatCoordNum(ymin)}`,
    `ymax=${formatCoordNum(ymax)}`
  ];

  if (ui?.showLegend !== false && plotDefs.length) {
    const legendCols = legendColumnCount(plotDefs.length);
    const { legendX, legendY } = legendAxisPosition(drawRows, xKey, yDomain);
    lines.push(
      `legend style={
    font=\\fontsize{7}{8}\\selectfont,
    at={(axis cs:${legendX},${legendY})},
    anchor=south west,
    legend columns=${legendCols},
    /tikz/every even column/.append style={column sep=0.08in}
  }`
    );
  } else {
    lines.push("legend to name=leg-hidden");
  }

  if (ui?.showXAxisLabel && String(ui?.xAxisLabel ?? "").trim()) {
    lines.push(`xlabel={${latexEscape(ui.xAxisLabel)}}`);
  }
  if (ui?.showYAxisLabel && String(ui?.yAxisLabel ?? "").trim()) {
    lines.push(`ylabel={${latexEscape(ui.yAxisLabel)}}`);
  }

  if (ui?.showXAxisTicks === false) {
    lines.push("xtick=\\emptytick", "xticklabels={}");
  } else if (xTickBlock) {
    lines.push(xTickBlock);
  }

  if (ui?.showYAxisTicks === false) {
    lines.push("ytick=\\emptytick", "yticklabels={}");
  }

  return lines.join(",\n    ");
}

function buildLinePlotOpts(def) {
  const colorName = colorDefName(def.dataKey);
  const mark = latexMarkForDef(def);
  const opts = [`color=${colorName}`, `line width=${LATEX_LINE_WIDTH_PT}pt`];
  if (mark !== "none") {
    opts.push(`mark=${mark}`, `mark size=${LATEX_MARK_SIZE_PT}pt`);
  } else {
    opts.push("mark=none");
  }
  return opts;
}

function buildLinePlots(plotDefs, drawRows, xKey) {
  const lines = [];
  plotDefs.forEach((def) => {
    const coords = buildCoordinates(drawRows, xKey, def.dataKey);
    if (!coords) return;
    const plotOpts = buildLinePlotOpts(def);
    lines.push(
      `  \\addplot[${plotOpts.join(", ")}]`,
      `    coordinates {${coords}};`,
      `  \\addlegendentry{${latexEscape(def.name)}}`
    );
  });
  return lines.join("\n");
}

function buildBarPlots(plotDefs, drawRows, xKey) {
  const n = plotDefs.length;
  const barWidth = n > 1 ? Math.min(12, 28 / n) : 14;
  const lines = [];
  plotDefs.forEach((def, idx) => {
    const coords = buildCoordinates(drawRows, xKey, def.dataKey);
    if (!coords) return;
    const colorName = colorDefName(def.dataKey);
    const shift = n > 1 ? (idx - (n - 1) / 2) * barWidth : 0;
    const shiftStr = Math.abs(shift) > 0.01 ? `bar shift=${shift.toFixed(1)}pt` : "";
    lines.push(
      `  \\addplot[ybar, fill=${colorName}!${Math.round((def.opacity ?? 0.65) * 100)}, draw=${colorName}, ${shiftStr}]`,
      `    coordinates {${coords}};`,
      `  \\addlegendentry{${latexEscape(def.name)}}`
    );
  });
  return lines.join("\n");
}

function buildTikzpictureBody(figure) {
  const { title, chartType, rows, xKey, plotDefs, ui, chartMode, compareChartInput } = figure;
  const drawRows = prepareDrawRows(rows, plotDefs, chartType, ui, xKey, compareChartInput);
  if (!drawRows.length || !plotDefs.length) {
    return `% Chart "${latexEscape(title)}" skipped (no plottable data)\n`;
  }

  const autoY = computeAutoYDomain({ rows: drawRows, plotDefs, chartType, chartMode, ui });
  const yDomain = resolveYAxisDomain(autoY, ui);
  const xTickBlock = ui?.showXAxisTicks !== false ? buildXTickBlock(drawRows, xKey, chartMode) : "";
  const axisOpts = buildAxisOptions(ui, yDomain, xTickBlock, plotDefs, drawRows, xKey);

  const colorDefs = plotDefs.map(
    (def) => `\\definecolor{${colorDefName(def.dataKey)}}{HTML}{${latexHexForDef(def)}}`
  );

  const plotBody =
    chartType === "bar"
      ? buildBarPlots(plotDefs, drawRows, xKey)
      : buildLinePlots(plotDefs, drawRows, xKey);

  const sectionTitle = String(figure.sectionTitle ?? "").trim();
  const lines = [`% ${latexEscape(title)}`];
  if (sectionTitle) lines.push(`% --- ${latexEscape(sectionTitle)} ---`);
  lines.push(...colorDefs, "\\begin{tikzpicture}", "\\begin{axis}[", `    ${axisOpts}`, "]", plotBody, "\\end{axis}", "\\end{tikzpicture}");
  return lines.join("\n");
}

function formatLatexCaption(text, fallback = "") {
  const raw = String(text ?? "").trim() || String(fallback ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("\\caption")) return raw;
  return `\\caption{${latexEscape(raw)}}`;
}

function formatLatexLabel(text, fallback = "") {
  const raw = String(text ?? "").trim() || String(fallback ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("\\label")) return raw;
  const stem = raw.startsWith("fig:") ? raw.slice(4) : sanitizeTexStem(raw);
  const id = stem ? `fig:${stem}` : "fig:qbr_chart";
  return `\\label{${id}}`;
}

function buildLatexDocument(figures, exportMeta = {}) {
  const { chart, chartIdx = 0, panelTitle = "QBR chart", chartUi } = exportMeta;
  const headerLine = chart ? defaultPanelTitle(chart, chartIdx) : panelTitle;
  const chunks = figures.map((fig) => buildTikzpictureBody(fig)).filter((chunk) => chunk.trim());
  if (!chunks.length) return "";

  const caption = formatLatexCaption(chartUi?.latexCaption, chartUi?.cardTitle || panelTitle);
  const label = formatLatexLabel(chartUi?.latexLabel, sanitizeTexStem(panelTitle));
  const figureTail = [caption, label].filter(Boolean);

  return [
    `% ${headerLine}`,
    "% Generated by QBR Compare Chart workspace",
    "% Requires in preamble:",
    "%   \\usepackage{tikz}",
    "%   \\usepackage{pgfplots}",
    "%   \\pgfplotsset{compat=1.18}",
    "",
    "\\begin{figure}[h]",
    "\\centering",
    ...chunks.flatMap((chunk, idx) => (idx === 0 ? [chunk] : ["", chunk])),
    ...figureTail,
    "\\end{figure}",
    ""
  ].join("\n");
}

export function buildChartFiguresForPanel({
  chart,
  chartUi,
  defs,
  densityPairs,
  sideIds,
  compareChartInput,
  catalogMap,
  defaultCardTitle
}) {
  const plotDefs = filterPlotDefs(defs, chart.mode);
  const figures = [];

  if (chart.mode === "density") {
    const selectedPairMap = new Map(
      densityPairs
        .filter((pair) => chart.selectedDensityLabels.includes(pair.densityLabel))
        .map((pair) => [pair.densityLabel, pair])
    );
    chart.selectedDensityLabels.forEach((densityLabel) => {
      const pair = selectedPairMap.get(densityLabel);
      const rows = pair ? buildPerDensityChartRows(pair, chart.selectedMetricKeys, sideIds) : [];
      figures.push({
        title: `Density ${densityLabel}`,
        sectionTitle: chartUi.cardTitle?.trim() || "",
        chartType: chart.chartType,
        rows,
        xKey: "x",
        plotDefs,
        ui: chartUi,
        chartMode: chart.mode,
        compareChartInput
      });
    });
  } else {
    const topoKeys = chart.selectedMetricKeys.filter((key) => catalogMap?.get(key)?.scope === "topology");
    const densityKeys = chart.selectedMetricKeys.filter((key) => catalogMap?.get(key)?.scope === "density");
    const meanRows = buildDensityMeanRows(compareChartInput, topoKeys, densityKeys).filter((row) =>
      chart.selectedDensityLabels.includes(row.densityLabel)
    );
    figures.push({
      title: defaultCardTitle || "Density mean comparison",
      sectionTitle: chartUi.cardTitle?.trim() || defaultCardTitle || "Density mean comparison",
      chartType: chart.chartType,
      rows: meanRows,
      xKey: "x",
      plotDefs,
      ui: chartUi,
      chartMode: chart.mode,
      compareChartInput
    });
  }

  return figures;
}

export function downloadPanelChartsAsLatex(figures, exportMeta) {
  if (!figures?.length) return false;
  const panelTitle =
    typeof exportMeta === "string" ? exportMeta : String(exportMeta?.panelTitle ?? "QBR chart");
  const tex = buildLatexDocument(figures, typeof exportMeta === "string" ? { panelTitle } : exportMeta);
  if (!tex.trim()) return false;
  const stem = sanitizeTexStem(panelTitle);
  const blob = new Blob([tex], { type: "application/x-tex;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${stem}.tex`;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

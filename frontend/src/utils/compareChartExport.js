import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js";

/** IEEE-style single-column figure (matches matplotlib figsize=(3.5, 2.4)). */
export const IEEE_FIGURE_WIDTH_IN = 3.5;
export const IEEE_FIGURE_HEIGHT_IN = 2.4;
const IEEE_WIDTH_PT = IEEE_FIGURE_WIDTH_IN * 72;
const IEEE_HEIGHT_PT = IEEE_FIGURE_HEIGHT_IN * 72;

const IEEE_TICK_PT = 7;
const IEEE_AXIS_LABEL_PT = 8;
const IEEE_LEGEND_PT = 7;

function sanitizeFilename(baseFilename) {
  return (
    String(baseFilename || "chart")
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "chart"
  );
}

function prepareSvgClone(svgElement) {
  const cloned = svgElement.cloneNode(true);
  const rect = svgElement.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || Number(cloned.getAttribute("width")) || 800));
  const height = Math.max(1, Math.round(rect.height || Number(cloned.getAttribute("height")) || 400));
  cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  cloned.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  cloned.setAttribute("width", String(width));
  cloned.setAttribute("height", String(height));
  if (!cloned.getAttribute("viewBox")) {
    cloned.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  return { cloned, width, height };
}

function patchStyleFontSize(style, sizePx) {
  if (!style) return `font-size: ${sizePx}px`;
  const parts = style
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  let found = false;
  const next = parts.map((part) => {
    if (/^font-size\s*:/i.test(part)) {
      found = true;
      return `font-size: ${sizePx}px`;
    }
    return part;
  });
  if (!found) next.push(`font-size: ${sizePx}px`);
  return `${next.join("; ")};`;
}

/** Uniform scale used when the SVG is fitted into the IEEE page. */
function ieeePdfUniformScale(sourceWidth, sourceHeight) {
  return Math.min(IEEE_WIDTH_PT / sourceWidth, IEEE_HEIGHT_PT / sourceHeight);
}

/** SVG font size (px) so text renders at ~targetPt after pdf fit. */
function svgFontSizeForPt(targetPt, sourceWidth, sourceHeight) {
  const uniformScale = ieeePdfUniformScale(sourceWidth, sourceHeight);
  return targetPt / uniformScale;
}

function setTextRoleFontSize(el, targetPt, sourceWidth, sourceHeight) {
  const size = svgFontSizeForPt(targetPt, sourceWidth, sourceHeight);
  el.setAttribute("font-size", String(size));
  const style = el.getAttribute("style");
  if (style) {
    el.setAttribute("style", patchStyleFontSize(style, size));
  }
  el.querySelectorAll("tspan").forEach((tspan) => {
    tspan.setAttribute("font-size", String(size));
    const tspanStyle = tspan.getAttribute("style");
    if (tspanStyle) {
      tspan.setAttribute("style", patchStyleFontSize(tspanStyle, size));
    }
  });
}

function adjustSvgTypographyForIeeeExport(svgRoot, sourceWidth, sourceHeight) {
  svgRoot.querySelectorAll(".recharts-cartesian-axis-tick-value").forEach((el) => {
    setTextRoleFontSize(el, IEEE_TICK_PT, sourceWidth, sourceHeight);
  });

  svgRoot.querySelectorAll(".recharts-label, text.recharts-label").forEach((el) => {
    setTextRoleFontSize(el, IEEE_AXIS_LABEL_PT, sourceWidth, sourceHeight);
  });

  svgRoot.querySelectorAll(".recharts-legend-item-text").forEach((el) => {
    setTextRoleFontSize(el, IEEE_LEGEND_PT, sourceWidth, sourceHeight);
  });

  svgRoot.querySelectorAll("text").forEach((el) => {
    if (el.closest(".recharts-cartesian-axis-tick-value")) return;
    if (el.closest(".recharts-label")) return;
    if (el.closest(".recharts-legend-item-text")) return;
    setTextRoleFontSize(el, IEEE_TICK_PT, sourceWidth, sourceHeight);
  });
}

function ensureWhiteBackground(svgRoot, width, height) {
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("fill", "#ffffff");
  svgRoot.insertBefore(bg, svgRoot.firstChild);
}

/** Export Recharts SVG(s) as IEEE-sized .pdf pages (3.5" × 2.4" each). */
export async function downloadPanelChartsAsPdf(containerElement, baseFilename) {
  if (!containerElement) return false;
  const svgs = containerElement.querySelectorAll(".compare-chart-canvas svg.recharts-surface");
  if (!svgs.length) return false;

  const stem = sanitizeFilename(baseFilename);
  let pdf = null;

  for (let index = 0; index < svgs.length; index += 1) {
    const { cloned, width: srcW, height: srcH } = prepareSvgClone(svgs[index]);
    ensureWhiteBackground(cloned, srcW, srcH);
    adjustSvgTypographyForIeeeExport(cloned, srcW, srcH);

    if (!pdf) {
      pdf = new jsPDF({
        orientation: "landscape",
        unit: "pt",
        format: [IEEE_WIDTH_PT, IEEE_HEIGHT_PT]
      });
    } else {
      pdf.addPage([IEEE_WIDTH_PT, IEEE_HEIGHT_PT], "landscape");
    }

    await svg2pdf(cloned, pdf, {
      x: 0,
      y: 0,
      width: IEEE_WIDTH_PT,
      height: IEEE_HEIGHT_PT
    });
  }

  pdf.save(`${stem}.pdf`);
  return true;
}

export function ieeeFigureSizePixels(dpi = 96) {
  return {
    width: Math.round(IEEE_FIGURE_WIDTH_IN * dpi),
    height: Math.round(IEEE_FIGURE_HEIGHT_IN * dpi)
  };
}

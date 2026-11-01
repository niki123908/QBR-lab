function sanitizeFilename(name) {
  return String(name || "topology")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function buildEdges(nodes, txRange) {
  if (!nodes || nodes.length === 0) return [];
  const thresholdSq = Number(txRange) * Number(txRange);
  if (!Number.isFinite(thresholdSq) || thresholdSq <= 0) return [];
  const edges = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      if (dx * dx + dy * dy <= thresholdSq) {
        edges.push([nodes[i], nodes[j]]);
      }
    }
  }
  return edges;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build topology SVG matching on-screen TopologyGraph styling.
 * Supports node fills, base + transmission edges, optional labels, style settings.
 */
export function buildTopologyGraphSvg(
  graph,
  {
    nodeRadius = 1.35,
    edgeWidth = 0.45,
    edgeOpacity = 1,
    pad = 5,
    sourceNodeColor = "#ec5bb8",
    sourceNodeRadius = null,
    nodeFillById = null,
    customEdges = null,
    renderBaseEdges = true,
    baseEdgeColor = "#d0d5ea",
    showLabels = false,
    labelSize = 2.4,
    labelOffsetX = 0,
    labelOffsetY = 0
  } = {}
) {
  const contentW = Math.max(1, Number(graph?.space_width) || 100);
  const contentH = Math.max(1, Number(graph?.space_height) || 100);
  const margin = Math.max(0, Number(pad) || 0);
  const width = contentW + margin * 2;
  const height = contentH + margin * 2;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const nodeById = new Map(nodes.map((n) => [n.node_id, n]));
  const resolvedSourceRadius = Number.isFinite(Number(sourceNodeRadius))
    ? Number(sourceNodeRadius)
    : nodeRadius + 0.25;
  const sourceFill = String(sourceNodeColor || "#ec5bb8");
  const opacity = Math.min(1, Math.max(0, Number(edgeOpacity)));
  const fills = nodeFillById && typeof nodeFillById === "object" ? nodeFillById : {};

  const lineParts = [];

  if (renderBaseEdges) {
    buildEdges(nodes, graph?.tx_range).forEach(([from, to]) => {
      const x1 = from.x + margin;
      const y1 = contentH - from.y + margin;
      const x2 = to.x + margin;
      const y2 = contentH - to.y + margin;
      const opacityAttr = opacity < 1 ? ` stroke-opacity="${opacity}"` : "";
      lineParts.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${escapeXml(baseEdgeColor)}" stroke-width="${edgeWidth}"${opacityAttr} />`
      );
    });
  }

  const overlay = Array.isArray(customEdges) ? customEdges : [];
  const hasDirected = overlay.some((e) => e?.directed);
  overlay.forEach((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) return;
    const x1 = from.x + margin;
    const y1 = contentH - from.y + margin;
    const x2 = to.x + margin;
    const y2 = contentH - to.y + margin;
    const stroke = edge.color || "#2b2f3a";
    const widthStroke = Number.isFinite(Number(edge.width)) ? Number(edge.width) : edgeWidth;
    const edgeOpacityAttr =
      edge.lbPath || opacity >= 1 ? "" : ` stroke-opacity="${opacity}"`;
    const marker = edge.directed ? ` marker-end="url(#topo-export-arrow)"` : "";
    lineParts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${escapeXml(stroke)}" stroke-width="${widthStroke}"${edgeOpacityAttr}${marker} />`
    );
  });

  const others = [];
  let source = null;
  for (const node of nodes) {
    if (node.node_id === 0) source = node;
    else others.push(node);
  }
  const paintNodes = source ? [...others, source] : others;

  const nodeParts = paintNodes.map((node) => {
    const isSource = node.node_id === 0;
    const r = isSource ? resolvedSourceRadius : nodeRadius;
    const fill = isSource ? sourceFill : fills[node.node_id] ?? fills[String(node.node_id)] ?? "#9da5bf";
    const cx = node.x + margin;
    const cy = contentH - node.y + margin;
    let out = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${escapeXml(fill)}" />`;
    if (showLabels) {
      const lx = cx + Number(labelOffsetX || 0);
      const ly = cy + Number(labelOffsetY || 0);
      out += `<text x="${lx}" y="${ly}" fill="#5b5f78" font-size="${labelSize}" text-anchor="middle" dominant-baseline="central">${escapeXml(node.node_id)}</text>`;
    }
    return out;
  });

  const defs = hasDirected
    ? `<defs><marker id="topo-export-arrow" markerWidth="4" markerHeight="4" refX="3.2" refY="2" orient="auto"><path d="M0,0 L0,4 L4,2 z" fill="#2b2f3a" /></marker></defs>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs}
  <rect x="0" y="0" width="${width}" height="${height}" fill="#f7f8fd" />
  ${lineParts.join("")}
  ${nodeParts.join("")}
</svg>`;
}

function triggerDownload(blob, outName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = outName;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Download topology graph as SVG (supports styled export options).
 */
export function downloadTopologyGraphSvg(graph, options = {}) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return false;
  }
  const { filename, ...styleOpts } = options;
  const svg = buildTopologyGraphSvg(graph, styleOpts);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const base = sanitizeFilename(filename || graph.topology_name || graph.topology_id || "topology");
  const outName = base.toLowerCase().endsWith(".svg") ? base : `${base}.svg`;
  triggerDownload(blob, outName);
  return true;
}

/**
 * Download topology graph as PNG (supports styled export options).
 */
export function downloadTopologyGraphPng(graph, options = {}) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return Promise.resolve(false);
  }

  const { filename, maxExportPx = 2000, pad = 5, ...styleOpts } = options;
  const contentW = Math.max(1, Number(graph.space_width) || 100);
  const contentH = Math.max(1, Number(graph.space_height) || 100);
  const margin = Math.max(0, Number(pad) || 0);
  const width = contentW + margin * 2;
  const height = contentH + margin * 2;
  const scale = Math.min(4, Math.max(1, maxExportPx / Math.max(width, height)));
  const svg = buildTopologyGraphSvg(graph, { ...styleOpts, pad: margin });
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const base = sanitizeFilename(filename || graph.topology_name || graph.topology_id || "topology");
  const outName = base.toLowerCase().endsWith(".png") ? base : `${base}.png`;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          resolve(false);
          return;
        }
        ctx.fillStyle = "#f7f8fd";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(url);
          if (!pngBlob) {
            resolve(false);
            return;
          }
          triggerDownload(pngBlob, outName);
          resolve(true);
        }, "image/png");
      } catch {
        URL.revokeObjectURL(url);
        resolve(false);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(false);
    };
    img.src = url;
  });
}

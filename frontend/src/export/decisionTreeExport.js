function buildEmbeddedSvgStyles(metrics) {
  const fontSize = Number(metrics?.fontSize) || 11;
  const labelStroke = Math.max(1.5, fontSize * 0.2);
  return `
    text.dt-depth-label { fill: #8b90a8; font-weight: 600; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    text.dt-node-label { fill: #ffffff; font-weight: 700; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    text.dt-edge-label { fill: #2c5282; font-weight: 600; font-family: system-ui, -apple-system, Segoe UI, sans-serif; stroke: #fbfbff; stroke-width: ${labelStroke}px; paint-order: stroke; }
    text.dt-edge-label--on { fill: #c6761a; font-weight: 700; }
    text.dt-edge-label--merged { fill: #c0392b; font-weight: 800; stroke: #fff5f5; stroke-width: ${labelStroke + 1}px; }
  `;
}

function sanitizeFilename(name) {
  return String(name || "decision-tree")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

/**
 * Rasterize the on-screen decision tree SVG (stretched width × layout height) to JPG.
 */
export function downloadDecisionTreeJpg({ svgElement, widthPx, heightPx, metrics, filename = "decision-tree.jpg" }) {
  if (!svgElement || widthPx <= 0 || heightPx <= 0) {
    return Promise.resolve(false);
  }

  const clone = svgElement.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(widthPx));
  clone.setAttribute("height", String(heightPx));
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${widthPx} ${heightPx}`);
  }
  clone.setAttribute("preserveAspectRatio", "none");

  const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
  styleEl.textContent = buildEmbeddedSvgStyles(metrics);
  clone.insertBefore(styleEl, clone.firstChild);

  const serializer = new XMLSerializer();
  let source = serializer.serializeToString(clone);
  if (!source.includes('xmlns="http://www.w3.org/2000/svg"')) {
    source = source.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = 2;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(widthPx * scale));
        canvas.height = Math.max(1, Math.floor(heightPx * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(false);
          return;
        }
        ctx.fillStyle = "#fbfbff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(false);
              return;
            }
            const jpgUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = jpgUrl;
            link.download = sanitizeFilename(filename.endsWith(".jpg") ? filename : `${filename}.jpg`);
            link.click();
            URL.revokeObjectURL(jpgUrl);
            resolve(true);
          },
          "image/jpeg",
          0.95
        );
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(false);
    };
    img.src = url;
  });
}

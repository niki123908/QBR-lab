export function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv(columns, rows) {
  const keys = columns.map((col) => col.key);
  const header = columns.map((col) => col.label ?? col.key).map(escapeCsvCell).join(",");
  const body = rows.map((row) => keys.map((key) => escapeCsvCell(row[key])).join(","));
  return [header, ...body].join("\n");
}

export function safeFilename(label, fallback = "export") {
  return String(label ?? fallback)
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 80) || fallback;
}

export function downloadCsv(csvText, filename) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function parseCsvRows(payload) {
  const text = payload?.text;
  if (!text || typeof text !== "string") return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx]?.trim() ?? "";
    });
    return row;
  });
}

export function csvHeadersFromPayload(payload) {
  const text = payload?.text;
  if (!text || typeof text !== "string") return [];
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return [];
  return firstLine.split(",").map((h) => h.trim()).filter(Boolean);
}

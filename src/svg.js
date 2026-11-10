/** Zero-dependency SVG / DXF drawing generation from FreeCAD edge projections. */
import { truncate } from "./util.js";

const VIEWS = ["front", "top", "right", "iso"];
export const VIEW_NAMES = Object.freeze([...VIEWS, "all"]);

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  }[char]));
}

function fmt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return (Math.round(number * 1000) / 1000).toString();
}

export function viewsBounds(views) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  for (const name of VIEWS) {
    for (const polyline of views?.[name] ?? []) {
      for (const point of polyline ?? []) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
  }
  if (count === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);
  return { minX, minY, maxX, maxY, width, height };
}

function polylinePath(polyline, project) {
  if (!Array.isArray(polyline) || polyline.length < 2) return "";
  return polyline.map((point, index) => {
    const [x, y] = project(Number(point[0]), Number(point[1]));
    return `${index === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`;
  }).join(" ");
}

function grid(width, height, stroke) {
  const lines = [];
  for (let index = 1; index < 10; index += 1) {
    const x = (width / 10) * index;
    const y = (height / 10) * index;
    lines.push(`<line x1="${fmt(x)}" y1="0" x2="${fmt(x)}" y2="${fmt(height)}" stroke="${stroke}" stroke-width="0.5" stroke-dasharray="4 6"/>`);
    lines.push(`<line x1="0" y1="${fmt(y)}" x2="${fmt(width)}" y2="${fmt(y)}" stroke="${stroke}" stroke-width="0.5" stroke-dasharray="4 6"/>`);
  }
  return lines.join("");
}

function palette(dark) {
  return dark
    ? { bg: "#111827", grid: "#243044", stroke: "#7dd3fc", text: "#e5e7eb", sub: "#9ca3af", border: "#334155" }
    : { bg: "#ffffff", grid: "#e5e7eb", stroke: "#0f766e", text: "#0f172a", sub: "#64748b", border: "#cbd5e1" };
}

/** One view, scaled to a single canvas. */
export function buildSvg({ views = {}, report = {}, name = "model", view = "iso", width = 720, height = 520, dark = false } = {}) {
  const selected = VIEWS.includes(view) ? view : "iso";
  const colors = palette(dark);
  const bounds = viewsBounds({ [selected]: views[selected] });
  const padding = 40;
  const scale = Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height);
  const offsetX = (width - bounds.width * scale) / 2 - bounds.minX * scale;
  const offsetY = (height - bounds.height * scale) / 2 - bounds.maxY * scale;
  // SVG y grows downward: flip the model's y axis.
  const projectSafe = (x, y) => [x * scale + offsetX, height - (y * scale + offsetY)];

  const paths = (views[selected] ?? []).map((polyline) => {
    const d = polylinePath(polyline, projectSafe);
    return d ? `<path d="${d}" fill="none" stroke="${colors.stroke}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>` : "";
  }).join("");

  const size = report?.bbox?.size ?? [];
  const dims = size.length === 3 ? `${fmt(size[0])} x ${fmt(size[1])} x ${fmt(size[2])} mm` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(name)} ${selected} view">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${colors.bg}"/>`,
    grid(width, height, colors.grid),
    `<g>${paths}</g>`,
    `<text x="16" y="26" font-family="ui-monospace,monospace" font-size="15" fill="${colors.text}">${escapeXml(truncate(name, 48))} — ${selected.toUpperCase()}</text>`,
    dims ? `<text x="16" y="${height - 16}" font-family="ui-monospace,monospace" font-size="12" fill="${colors.sub}">${escapeXml(dims)}</text>` : "",
    report?.volume !== undefined ? `<text x="${width - 16}" y="26" text-anchor="end" font-family="ui-monospace,monospace" font-size="12" fill="${colors.sub}">V ${fmt(report.volume)} mm3</text>` : "",
    `</svg>`,
  ].filter(Boolean).join("");
}

/** Four views arranged in a 2x2 sheet with a shared scale. */
export function buildSheetSvg({ views = {}, report = {}, name = "model", dark = false, width = 960, height = 720 } = {}) {
  const colors = palette(dark);
  const bounds = viewsBounds(views);
  const cellW = width / 2;
  const cellH = height / 2;
  const padding = 46;
  const scale = Math.min((cellW - padding * 2) / bounds.width, (cellH - padding * 2) / bounds.height);
  const cells = VIEWS.map((view, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const ox = col * cellW;
    const oy = row * cellH;
    const offsetX = ox + (cellW - bounds.width * scale) / 2 - bounds.minX * scale;
    const offsetY = oy + (cellH - bounds.height * scale) / 2 - bounds.maxY * scale;
    const project = (x, y) => [x * scale + offsetX, oy + cellH - (y * scale + offsetY)];
    const paths = (views[view] ?? []).map((polyline) => {
      const d = polylinePath(polyline, project);
      return d ? `<path d="${d}" fill="none" stroke="${colors.stroke}" stroke-width="1.3" stroke-linejoin="round"/>` : "";
    }).join("");
    return `<g><rect x="${fmt(ox + 1)}" y="${fmt(oy + 1)}" width="${fmt(cellW - 2)}" height="${fmt(cellH - 2)}" fill="none" stroke="${colors.border}"/>` +
      `<text x="${fmt(ox + 14)}" y="${fmt(oy + 24)}" font-family="ui-monospace,monospace" font-size="13" fill="${colors.sub}">${view.toUpperCase()}</text>` +
      `<g>${paths}</g></g>`;
  }).join("");

  const size = report?.bbox?.size ?? [];
  const dims = size.length === 3 ? `${fmt(size[0])} x ${fmt(size[1])} x ${fmt(size[2])} mm` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(name)} four views">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${colors.bg}"/>`,
    cells,
    `<text x="16" y="${height - 16}" font-family="ui-monospace,monospace" font-size="13" fill="${colors.text}">${escapeXml(truncate(name, 60))}</text>`,
    dims ? `<text x="${width - 16}" y="${height - 16}" text-anchor="end" font-family="ui-monospace,monospace" font-size="12" fill="${colors.sub}">${escapeXml(dims)} · V ${fmt(report.volume)} mm3</text>` : "",
    `</svg>`,
  ].filter(Boolean).join("");
}

/** Minimal AutoCAD R12 DXF (LINE entities only) from the front view. */
export function buildDxf({ views = {}, name = "model", view = "front" } = {}) {
  const selected = VIEWS.includes(view) ? view : "front";
  const lines = views[selected] ?? [];
  const out = [];
  const pair = (code, value) => { out.push(String(code), String(value)); };
  pair(0, "SECTION"); pair(2, "HEADER");
  pair(9, "$ACADVER"); pair(1, "AC1009");
  pair(9, "$INSUNITS"); pair(70, "4");
  pair(9, "$MEASUREMENT"); pair(70, "1");
  pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "ENTITIES");
  for (const polyline of lines) {
    if (!Array.isArray(polyline)) continue;
    for (let index = 0; index < polyline.length - 1; index += 1) {
      const a = polyline[index];
      const b = polyline[index + 1];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      pair(0, "LINE"); pair(8, "GEOMETRY");
      pair(10, fmt(a[0])); pair(20, fmt(a[1])); pair(30, "0");
      pair(11, fmt(b[0])); pair(21, fmt(b[1])); pair(31, "0");
    }
  }
  pair(0, "ENDSEC"); pair(0, "EOF");
  pair(999, `dsh-cad-freecad: ${String(name).replace(/[\r\n]/g, " ").slice(0, 80)}`);
  return `${out.join("\n")}\n`;
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDxf, buildSheetSvg, buildSvg, viewsBounds } from "../src/svg.js";
import { sampleReport, sampleViews } from "./fixtures.mjs";

const views = sampleViews();
const report = sampleReport(1000);

describe("SVG / DXF generation", () => {
  it("computes bounds for empty and populated views", () => {
    assert.deepEqual(viewsBounds({}), { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 });
    const bounds = viewsBounds(views);
    assert.equal(bounds.width, 10);
    assert.equal(bounds.height, 10);
  });

  it("renders a single view with paths and facts", () => {
    const svg = buildSvg({ views, report, name: "bracket", view: "front" });
    assert.match(svg, /^<svg xmlns=/);
    assert.match(svg, /FRONT/);
    assert.match(svg, /<path d="M/);
    assert.match(svg, /V 1000 mm3/);
    assert.match(svg, /10 x 10 x 10 mm/);
    assert.ok(svg.endsWith("</svg>"));
  });

  it("renders all four views in a sheet", () => {
    const svg = buildSheetSvg({ views, report, name: "sheet" });
    for (const label of ["FRONT", "TOP", "RIGHT", "ISO"]) assert.match(svg, new RegExp(label));
    assert.equal((svg.match(/<path d="M/g) || []).length, 4);
  });

  it("escapes document names (no markup injection)", () => {
    const svg = buildSvg({ views, report, name: "<script>alert(1)</script>", view: "iso" });
    assert.doesNotMatch(svg, /<script>/);
    assert.match(svg, /&lt;script&gt;/);
  });

  it("supports a dark palette", () => {
    const light = buildSvg({ views, report, name: "x" });
    const dark = buildSvg({ views, report, name: "x", dark: true });
    assert.match(light, /#ffffff/);
    assert.match(dark, /#111827/);
  });

  it("generates a valid R12 DXF skeleton with LINE entities", () => {
    const dxf = buildDxf({ views, name: "part" });
    assert.match(dxf, /^0\nSECTION\n2\nHEADER/);
    assert.match(dxf, /AC1009/);
    assert.match(dxf, /2\nENTITIES/);
    assert.match(dxf, /0\nLINE/);
    assert.match(dxf, /8\nGEOMETRY/);
    assert.match(dxf, /0\nEOF/);
    assert.equal((dxf.match(/\n0\nLINE\n/g) || []).length, 4);
  });

  it("is deterministic and self-contained", () => {
    const a = buildSheetSvg({ views, report, name: "part" });
    const b = buildSheetSvg({ views, report, name: "part" });
    assert.equal(a, b);
    assert.doesNotMatch(a, /<script|href=|src="http/);
  });
});

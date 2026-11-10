import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOOLEAN_MODES, EXPORT_FORMATS, IMPORT_FORMATS, OPS, OP_NAMES,
  SCHEMA_ID, describeSchema, resolveValue, validateDocument,
} from "../src/schema.js";
import { minimalDocument } from "./fixtures.mjs";

const valid = () => minimalDocument();
const errorsOf = (doc) => validateDocument(doc).errors.map((item) => `${item.path}:${item.message}`).join(" | ");

describe("DSL schema", () => {
  it("accepts a minimal document and normalizes defaults", () => {
    const result = validateDocument({ name: "x", features: [{ op: "box", id: "b", length: 1, width: 1, height: 1 }] });
    assert.equal(result.ok, true);
    assert.equal(result.document.schema, SCHEMA_ID);
    assert.equal(result.document.units, "mm");
    assert.equal(result.document.result, "b");
  });

  it("rejects non-object roots", () => {
    for (const value of [null, [], "text", 42]) {
      assert.equal(validateDocument(value).ok, false);
    }
  });

  it("rejects wrong schema id, units and empty features", () => {
    const doc = valid();
    doc.schema = "other";
    doc.units = "inch";
    doc.features = [];
    const text = errorsOf(doc);
    assert.match(text, /\$\.schema/);
    assert.match(text, /\$\.units/);
    assert.match(text, /\$\.features/);
  });

  it("validates parameter names and values", () => {
    const doc = valid();
    doc.parameters = { "bad name": "x", ok: 1 };
    assert.match(errorsOf(doc), /invalid parameter name/);
    doc.parameters = { h: "ten" };
    assert.match(errorsOf(doc), /must be a finite number/);
  });

  it("rejects unknown and non-numeric parameter references", () => {
    const doc = valid();
    doc.features[0].height = "$missing";
    assert.match(errorsOf(doc), /unknown parameter/);
    doc.parameters = { h: "text" };
    doc.features[0].height = "$h";
    assert.match(errorsOf(doc), /not a finite number/);
  });

  it("rejects NaN/Infinity and absurd magnitudes", () => {
    const doc = valid();
    doc.features[0].length = NaN;
    assert.match(errorsOf(doc), /finite number/);
    doc.features[0].length = 1e12;
    assert.match(errorsOf(doc), /allowed magnitude/);
  });

  it("requires positive dimensions", () => {
    const doc = valid();
    doc.features[0].length = 0;
    assert.match(errorsOf(doc), /greater than zero/);
  });

  it("rejects duplicate, unsafe and missing ids", () => {
    const doc = valid();
    doc.features.push({ op: "box", id: "b", length: 1, width: 1, height: 1 });
    assert.match(errorsOf(doc), /duplicate id/);
    const bad = valid();
    bad.features[0].id = "../escape";
    assert.match(errorsOf(bad), /safe id/);
  });

  it("rejects unknown ops and unknown fields", () => {
    const doc = valid();
    doc.features[0].op = "launch_rocket";
    assert.match(errorsOf(doc), /unknown op/);
    const extra = valid();
    extra.features[0].surprise = 1;
    assert.match(errorsOf(extra), /unknown field/);
  });

  it("enforces required fields per op", () => {
    const doc = valid();
    doc.features[0] = { op: "cylinder", id: "c", radius: 2 };
    assert.match(errorsOf(doc), /height.*is required/);
  });

  it("validates axis, vectors and boolean modes", () => {
    const doc = valid();
    doc.features.push({ op: "cylinder", id: "c", radius: 2, height: 5, axis: "q" });
    assert.match(errorsOf(doc), /axis.*must be x, y or z/);
    const vec = valid();
    vec.features[0].at = [1, 2];
    assert.match(errorsOf(vec), /array of 3 numbers/);
    const mode = valid();
    mode.features.push({ op: "boolean", id: "u", mode: "xor", parts: ["b", "b"] });
    assert.match(errorsOf(mode), /union, cut, common/);
  });

  it("boolean needs at least two parts and must reference earlier ids", () => {
    const doc = valid();
    doc.features.push({ op: "boolean", id: "u", mode: "union", parts: ["b"] });
    assert.match(errorsOf(doc), /at least two shape ids/);
    const forward = valid();
    forward.features.push({ op: "boolean", id: "u", mode: "union", parts: ["b", "later"] });
    assert.match(errorsOf(forward), /earlier feature id/);
  });

  it("rejects self references", () => {
    const doc = valid();
    doc.features.push({ op: "hole", id: "h", on: "h", diameter: 2, at: [0, 0, 0] });
    assert.match(errorsOf(doc), /earlier feature id/);
  });

  it("validates point profiles", () => {
    const doc = valid();
    doc.features[0] = { op: "polygon_extrude", id: "p", points: [[0, 0], [1, 0]], height: 2 };
    assert.match(errorsOf(doc), /3\.\.512/);
  });

  it("validates hole_pattern grids", () => {
    const doc = valid();
    doc.features.push({ op: "hole_pattern", id: "hp", on: "b", diameter: 2, grid: { origin: [0, 0, 0] } });
    assert.match(errorsOf(doc), /is required in grid/);
    const empty = valid();
    empty.features.push({ op: "hole_pattern", id: "hp", on: "b", diameter: 2 });
    assert.match(errorsOf(empty), /needs positions or grid/);
  });

  it("transform needs at least one operation", () => {
    const doc = valid();
    doc.features.push({ op: "transform", id: "t", on: "b" });
    assert.match(errorsOf(doc), /translate\/rotate\/mirror\/scale/);
  });

  it("rejects invalid result references", () => {
    const doc = valid();
    doc.result = "missing";
    assert.match(errorsOf(doc), /must reference a feature id/);
  });

  it("respects the feature cap", () => {
    assert.equal(validateDocument(valid(), { maxFeatures: 0 }).ok, false);
  });

  it("resolves parameter references recursively", () => {
    assert.deepEqual(resolveValue({ a: ["$h", 2], b: "$h" }, { h: 7 }), { a: [7, 2], b: 7 });
    assert.equal(resolveValue(3, { h: 7 }), 3);
  });

  it("exposes a stable schema description", () => {
    const info = describeSchema();
    assert.equal(info.schema, SCHEMA_ID);
    assert.equal(info.ops.length, 14);
    assert.equal(Object.keys(OPS).length, OP_NAMES.length);
    assert.deepEqual([...BOOLEAN_MODES], ["union", "cut", "common"]);
    assert.deepEqual([...IMPORT_FORMATS], ["step", "iges", "brep"]);
    assert.ok(EXPORT_FORMATS.includes("step") && EXPORT_FORMATS.includes("dxf"));
    assert.match(info.note, /no user code is executed/i);
  });
});

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CadEngine } from "../src/registry.js";
import { CadError } from "../src/util.js";
import { cleanup, fakeEngine, minimalDocument, tempDir } from "./fixtures.mjs";

let root;
let engine;

before(async () => {
  root = await tempDir();
  engine = await fakeEngine(CadEngine, root);
});
after(async () => { await cleanup(root); });

describe("engine API (simulated FreeCAD runner)", () => {
  it("doctor reports an available backend and the DSL", async () => {
    const result = await engine.doctor();
    assert.equal(result.ok, true);
    assert.equal(result.available, true);
    assert.equal(result.backend.id, "freecad");
    assert.equal(result.backend.version, "1.1.4");
    assert.ok(result.schema.ops.length >= 14);
    assert.ok(result.config.workDir);
  });

  it("validate accepts good documents and reports bad ones as domain results", async () => {
    const good = await engine.validate(minimalDocument());
    assert.equal(good.valid, true);
    assert.equal(good.features, 1);
    const bad = await engine.validate("{oops");
    assert.equal(bad.ok, true);
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.length > 0);
  });

  it("build stores revision 1 with a geometry report", async () => {
    const result = await engine.build(minimalDocument(), { id: "engine-a" });
    assert.equal(result.ok, true);
    assert.equal(result.document.id, "engine-a");
    assert.equal(result.document.revision, 1);
    assert.equal(result.report.volume, 1000);
    assert.equal(result.report.valid, true);
  });

  it("measure rebuilds without storing a new revision", async () => {
    const result = await engine.measure("engine-a");
    assert.equal(result.ok, true);
    assert.equal(result.document.revision, 1);
    assert.equal(result.report.volume, 1000);
  });

  it("preview returns SVG inline or saves an artifact", async () => {
    const inline = await engine.preview("engine-a", { view: "iso", inline: true });
    assert.equal(inline.ok, true);
    assert.match(inline.svg, /^<svg/);
    const saved = await engine.preview("engine-a", { save: true });
    assert.equal(saved.ok, true);
    assert.equal(saved.svg, undefined);
    assert.equal(saved.artifact.format, "svg");
    assert.ok(saved.artifact.bytes > 100);
    assert.equal((await readFile(saved.artifact.path, "utf8")).startsWith("<svg"), true);
  });

  it("exports vector and report formats", async () => {
    for (const format of ["svg", "dxf", "json"]) {
      const result = await engine.exportDocument("engine-a", { format, filename: `out.${format}` });
      assert.equal(result.ok, true, `${format}: ${JSON.stringify(result.error)}`);
      assert.equal(result.artifact.format, format);
      assert.ok(result.artifact.bytes > 20);
      const content = await readFile(result.artifact.path, "utf8");
      if (format === "svg") assert.match(content, /<svg/);
      if (format === "dxf") assert.match(content, /ENTITIES/);
      if (format === "json") assert.equal(JSON.parse(content).report.volume, 1000);
    }
  });

  it("exports native formats through the runner", async () => {
    const result = await engine.exportDocument("engine-a", { format: "stp", filename: "out.step" });
    assert.equal(result.ok, true);
    assert.equal(result.artifact.format, "step");
    assert.match(await readFile(result.artifact.path, "utf8"), /FAKE-step/);
  });

  it("rejects unsupported formats and disabled export", async () => {
    const bad = await engine.exportDocument("engine-a", { format: "obj" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "unsupported_format");
    const restricted = await fakeEngine(CadEngine, await tempDir(), { config: { allowExport: false } });
    const denied = await restricted.build(minimalDocument(), { id: "x" });
    assert.equal(denied.ok, true);
    assert.equal((await restricted.exportDocument("x", { format: "step" })).error.code, "export_disabled");
  });

  it("imports an external file read-only and converts it", async () => {
    const source = join(root, "external.step");
    await writeFile(source, "ISO-10303-21;\nFAKE SOURCE\n");
    const imported = await engine.importDocument(source, { format: "step" });
    assert.equal(imported.ok, true);
    assert.equal(imported.report.volume, 1000);
    assert.equal(imported.source.path, source);
    const converted = await engine.convert(source, { format: "step", filename: "converted.step" });
    assert.equal(converted.ok, true);
    assert.equal(converted.artifact.format, "step");
    assert.equal((await engine.importDocument(join(root, "missing.step"))).error.code, "internal_error");
  });

  it("lists, reads revisions and applies parameter edits immutably", async () => {
    const docs = await engine.listDocuments();
    assert.ok(docs.documents.length >= 1);
    const got = await engine.getDocument("engine-a");
    assert.equal(got.document.parameters.h, 10);
    assert.equal(got.revisions.length, 1);
    const changed = await engine.setParameters("engine-a", { h: 25 });
    assert.equal(changed.ok, true);
    assert.equal(changed.document.revision, 2);
    const history = await engine.revisions("engine-a");
    assert.equal(history.revisions.length, 2);
    assert.equal((await engine.getDocument("engine-a", { revision: 1 })).document.parameters.h, 10);
    assert.equal((await engine.getDocument("engine-a", 1)).document.parameters.h, 10);
    assert.equal((await engine.getDocument("engine-a")).document.parameters.h, 25);
  });

  it("requires confirmation before deleting", async () => {
    assert.equal((await engine.removeDocument("engine-a")).error.code, "confirmation_required");
    const removed = await engine.removeDocument("engine-a", { confirm: true });
    assert.equal(removed.ok, true);
    assert.equal((await engine.getDocument("engine-a")).error.code, "not_found");
  });

  it("wraps runner failures into canonical error envelopes", async () => {
    const broken = await fakeEngine(CadEngine, await tempDir(), {
      seams: {
        runner: async () => { throw new CadError("feature_failed", "fillet failed", { op: "fillet" }); },
      },
    });
    const result = await broken.build(minimalDocument());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "feature_failed");
    assert.equal(result.error.details.op, "fillet");
  });

  it("never persists a document when the geometry build fails", async () => {
    const broken = await fakeEngine(CadEngine, await tempDir(), {
      seams: { runner: async () => { throw new Error("kernel crashed"); } },
    });
    const result = await broken.build(minimalDocument());
    assert.equal(result.ok, false);
    assert.equal((await broken.listDocuments()).documents.length, 0);
  });
});

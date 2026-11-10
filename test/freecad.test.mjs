import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CadEngine } from "../src/registry.js";
import { cleanup, tempDir } from "./fixtures.mjs";

const FC = process.env.DSH_CAD_FREECAD_CMD;
const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));
const describeReal = FC ? describe : describe.skip;

describeReal("real FreeCAD kernel (DSH_CAD_FREECAD_CMD)", () => {
  let root;
  let engine;

  before(async () => {
    root = await tempDir();
    engine = await new CadEngine({ workDir: root, freecadCmd: FC }).init();
  });
  after(async () => { await cleanup(root); });

  it("reports an available backend with a real version", async () => {
    const result = await engine.doctor();
    assert.equal(result.ok, true);
    assert.equal(result.available, true);
    assert.match(result.backend.version, /^\d+\.\d+/);
    assert.equal(result.backend.modules?.Part, true);
  });

  it("builds every bundled example into a valid solid", async () => {
    for (const name of (await readdir(EXAMPLES)).filter((file) => file.endsWith(".json"))) {
      const text = await readFile(join(EXAMPLES, name), "utf8");
      const result = await engine.build(text);
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.error)}`);
      assert.equal(result.report.valid, true, `${name} geometry is invalid`);
      assert.ok(result.report.volume > 0, `${name} has zero volume`);
      assert.ok(result.report.topology.solids >= 1);
    }
  });

  it("exports STEP, STL, IGES, BREP, SVG, DXF and JSON", async () => {
    const washer = await readFile(join(EXAMPLES, "washer.json"), "utf8");
    const built = await engine.build(washer, { id: "real-washer" });
    assert.equal(built.ok, true);
    for (const format of ["step", "stl", "iges", "brep", "svg", "dxf", "json"]) {
      const result = await engine.exportDocument("real-washer", { format, filename: `real.${format}` });
      assert.equal(result.ok, true, `${format}: ${JSON.stringify(result.error)}`);
      const info = await stat(result.artifact.path);
      assert.equal(info.size, result.artifact.bytes);
      assert.ok(info.size > 20, `${format} artifact is empty`);
      if (format === "step") assert.match(await readFile(result.artifact.path, "utf8"), /ISO-10303-21/);
      if (format === "svg") assert.match(await readFile(result.artifact.path, "utf8"), /<svg/);
      if (format === "dxf") assert.match(await readFile(result.artifact.path, "utf8"), /ENTITIES/);
    }
  });

  it("re-imports an exported STEP with matching volume", async () => {
    const result = await engine.exportDocument("real-washer", { format: "step", filename: "roundtrip.step" });
    const imported = await engine.importDocument(result.artifact.path, { format: "step" });
    assert.equal(imported.ok, true);
    assert.ok(Math.abs(imported.report.volume - 8846.724913) < 1e-3);
    assert.equal(imported.report.valid, true);
  });

  it("parameter edits produce a new revision with different geometry", async () => {
    const first = await engine.getDocument("real-washer");
    const measured = await engine.measure("real-washer");
    const changed = await engine.setParameters("real-washer", { outer: 40 });
    assert.equal(changed.ok, true);
    assert.equal(changed.document.revision, first.ref.revision + 1);
    assert.ok(changed.report.volume > measured.report.volume);
    assert.equal((await engine.getDocument("real-washer", 1)).document.parameters.outer, 30);
    assert.equal((await engine.getDocument("real-washer")).document.parameters.outer, 40);
  });

  it("rejects invalid geometry input with a domain error", async () => {
    const bad = await engine.build({
      schema: "dsh.cad.freecad/document@1",
      name: "bad",
      features: [{ op: "box", id: "b", length: 0, width: 1, height: 1 }],
      result: "b",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "invalid_document");
  });
});

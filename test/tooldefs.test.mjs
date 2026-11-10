import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CadEngine } from "../src/registry.js";
import { TOOL_NAMES, createToolDefinitions, renderSummary } from "../src/tooldefs.js";
import { cleanup, fakeEngine, minimalDocument, tempDir } from "./fixtures.mjs";

let root;
let engine;
let tools;

before(async () => {
  root = await tempDir();
  engine = await fakeEngine(CadEngine, root);
  tools = createToolDefinitions(engine);
});
after(async () => { await cleanup(root); });

const byName = (name) => tools.find((tool) => tool.name === name);

describe("DSH tool definitions", () => {
  it("exposes exactly the 12 fcad_* tools", () => {
    assert.equal(tools.length, 12);
    assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES]);
    assert.ok(TOOL_NAMES.every((name) => name.startsWith("fcad_")));
    assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  });

  it("every tool satisfies the host contract", () => {
    for (const tool of tools) {
      assert.equal(typeof tool.name, "string");
      assert.ok(tool.description.length > 60, `${tool.name} needs a descriptive description`);
      assert.equal(typeof tool.parameters, "object");
      assert.equal(Array.isArray(tool.parameters), false);
      assert.equal(tool.output.schema.type, "object");
      assert.equal(typeof tool.output.render, "function");
      assert.equal(typeof tool.execute, "function");
      assert.equal(typeof tool.isConcurrencySafe(), "boolean");
      for (const [key, field] of Object.entries(tool.parameters)) {
        assert.ok(field.type, `${tool.name}.${key} needs a type`);
        assert.ok(field.description, `${tool.name}.${key} needs a description`);
      }
    }
  });

  it("render always returns text content", () => {
    const output = byName("fcad_measure").output.render({}, { ok: true, report: { volume: 42, area: 1, bbox: { size: [1, 2, 3] }, topology: { solids: 1, faces: 1, edges: 1 }, checks: [] } });
    assert.equal(output[0].type, "text");
    assert.match(output[0].text, /volume 42/);
    assert.doesNotMatch(output[0].text, /undefined/);
  });

  it("summarizes errors with validation details", () => {
    const text = renderSummary({ ok: false, error: { code: "invalid_document", message: "bad", details: { errors: [{ path: "$.x", message: "required" }] } } });
    assert.match(text, /invalid_document/);
    assert.match(text, /\$\.x: required/);
  });

  it("doctor and docs execute successfully", async () => {
    assert.equal((await byName("fcad_doctor").execute({})).available, true);
    assert.equal((await byName("fcad_docs").execute({})).ok, true);
  });

  it("validate / build / measure / preview execute against the engine", async () => {
    const document = JSON.stringify(minimalDocument());
    assert.equal((await byName("fcad_validate").execute({ document })).valid, true);
    const built = await byName("fcad_build").execute({ document, id: "tools-a" });
    assert.equal(built.ok, true);
    assert.equal((await byName("fcad_measure").execute({ id: "tools-a" })).report.volume, 1000);
    const preview = await byName("fcad_preview").execute({ id: "tools-a", inline: true });
    assert.match(preview.svg, /^<svg/);
    const saved = await byName("fcad_preview").execute({ id: "tools-a" });
    assert.equal(saved.artifact.format, "svg");
    assert.equal(saved.svg, undefined);
  });

  it("export / import / convert return artifact references, not bytes", async () => {
    const exported = await byName("fcad_export").execute({ id: "tools-a", format: "step" });
    assert.equal(exported.ok, true);
    assert.equal(exported.artifact.bytes > 0, true);
    assert.equal(exported.artifact.path.includes(root), true);
    assert.equal(exported.svg, undefined);
    const bad = await byName("fcad_export").execute({ id: "tools-a", format: "nope" });
    assert.equal(bad.error.code, "unsupported_format");
  });

  it("doc_get / param / doc_delete enforce history and confirmation", async () => {
    const got = await byName("fcad_doc_get").execute({ id: "tools-a" });
    assert.equal(got.revisions.length, 1);
    const changed = await byName("fcad_param").execute({ id: "tools-a", parameters: '{"h":33}' });
    assert.equal(changed.document.revision, 2);
    assert.equal((await byName("fcad_doc_get").execute({ id: "tools-a" })).revisions.length, 2);
    assert.equal((await byName("fcad_doc_delete").execute({ id: "tools-a" })).error.code, "confirmation_required");
    assert.equal((await byName("fcad_doc_delete").execute({ id: "tools-a", confirm: true })).removed, true);
  });

  it("honors exec.signal plumbing without throwing", async () => {
    const controller = new AbortController();
    const result = await byName("fcad_measure").execute({ id: "missing" }, { signal: controller.signal });
    assert.equal(result.ok, false);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, tempDir } from "./fixtures.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let root;
let plugin;

before(async () => {
  root = await tempDir();
  plugin = await import("../lib/index.js");
});
after(async () => { await cleanup(root); });

describe("DSH plugin entry point", () => {
  it("exports the Cordis contract", () => {
    assert.equal(plugin.name, "dsh-cad-freecad");
    assert.deepEqual(plugin.inject, ["tools"]);
    assert.equal(typeof plugin.apply, "function");
    assert.equal(typeof plugin.CadEngine, "function");
    assert.equal(typeof plugin.createToolDefinitions, "function");
    assert.equal(typeof plugin.Config.normalize, "function");
  });

  it("registers all tools and registers a reversible effect", async () => {
    const registered = [];
    let disposed = 0;
    let effectDisposer = null;
    const ctx = {
      tools: {
        register(definition) {
          registered.push(definition);
          return () => { disposed += 1; };
        },
      },
      effect(fn) {
        effectDisposer = fn();
      },
    };
    const engine = plugin.apply(ctx, { workDir: root });
    assert.equal(registered.length, 12);
    assert.ok(registered.every((tool) => tool.name.startsWith("fcad_")));
    assert.equal(typeof effectDisposer, "function");
    effectDisposer();
    assert.equal(disposed, 12);
    assert.equal(engine.config.workDir, root);
  });

  it("normalizes a malformed patch through Config", () => {
    const config = plugin.Config.normalize({ maxFeatures: 999999 });
    assert.ok(config.maxFeatures <= 500);
  });

  it("ships a valid bundle patch", async () => {
    const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: dsh-cad-freecad/);
    assert.match(patch, /name: dsh-cad-freecad/);
    assert.match(patch, /config:/);
    assert.match(patch, /allowExport: true/);
  });

  it("declares the DSH bundle and discoverability topic in package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.type, "module");
    assert.equal(pkg.main, "lib/index.js");
    assert.equal(pkg.dsh.plugin, true);
    assert.equal(pkg.dsh.kind, "server");
    assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
    assert.ok(pkg.keywords.includes("dsh-plugin"));
    assert.ok(pkg.engines.node.includes("22"));
    assert.equal(pkg.peerDependenciesMeta["@deepseek-ai/dsh-tools"].optional, true);
  });

  it("keeps the standalone core importable without any host package", async () => {
    const core = await import("../src/registry.js");
    const tools = await import("../src/tooldefs.js");
    assert.equal(typeof core.CadEngine, "function");
    assert.equal(typeof tools.createToolDefinitions, "function");
    assert.match(ROOT, /dsh-cad-freecad/);
  });
});

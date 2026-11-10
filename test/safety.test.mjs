import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../src/tooldefs.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["src", "lib", "server", "web", "bin", "python"];

async function sources() {
  const files = [];
  for (const dir of DIRS) {
    for (const name of await readdir(join(ROOT, dir))) {
      if ([".js", ".mjs", ".py"].includes(extname(name))) {
        files.push({ path: join(ROOT, dir, name), text: await readFile(join(ROOT, dir, name), "utf8") });
      }
    }
  }
  return files;
}

describe("static safety guarantees", () => {
  it("never evaluates user-supplied text as code", async () => {
    const jsForbidden = [/\beval\s*\(/, /new\s+Function\s*\(/, /execSync\s*\(/, /spawnSync\s*\(/, /\bshell:\s*true/, /\.innerHTML\s*=/];
    const pyForbidden = [/\beval\s*\(/, /\bexec\s*\(/, /os\.system\s*\(/, /\bsubprocess\b/, /pickle\.loads/];
    for (const file of await sources()) {
      const patterns = file.path.endsWith(".py") ? pyForbidden : jsForbidden;
      for (const pattern of patterns) {
        assert.doesNotMatch(file.text, pattern, `${file.path} must not contain ${pattern}`);
      }
    }
  });

  it("binds the web server to loopback with a strict CSP", async () => {
    const server = await readFile(join(ROOT, "server", "serve.mjs"), "utf8");
    assert.match(server, /server\.listen\(port, "127\.0\.0\.1"/);
    assert.match(server, /Content-Security-Policy/);
    assert.match(server, /HttpOnly/);
    assert.match(server, /SameSite=Strict/);
    assert.match(server, /host_not_allowed/);
    assert.match(server, /origin_not_allowed/);
    assert.doesNotMatch(server, /0\.0\.0\.0/);
  });

  it("renders the UI with textContent only", async () => {
    const app = await readFile(join(ROOT, "web", "app.js"), "utf8");
    assert.match(app, /textContent/);
    assert.doesNotMatch(app, /innerHTML/);
    assert.doesNotMatch(app, /document\.write/);
    assert.doesNotMatch(app, /https?:\/\//, "no external resources");
  });

  it("keeps the FreeCAD runner read-only with respect to source files", async () => {
    const runner = await readFile(join(ROOT, "python", "freecad_runner.py"), "utf8");
    assert.match(runner, /DSH_CAD_JOB/);
    assert.match(runner, /Documents are pure data|No field is ever/);
    assert.doesNotMatch(runner, /open\([^)]*["']w["']/, "runner writes only exported artifacts");
    assert.match(runner, /export_shape/);
    assert.match(runner, /Part\.read/);
  });

  it("uses the fcad_ prefix to avoid collisions with existing cad_* plugins", async () => {
    assert.ok(TOOL_NAMES.every((name) => /^fcad_[a-z_]+$/.test(name)));
    const definitions = await readFile(join(ROOT, "src", "tooldefs.js"), "utf8");
    assert.doesNotMatch(definitions, /name: "cad_/);
  });

  it("keeps the shipped patch config in sync with the defaults", async () => {
    const patch = await readFile(join(ROOT, "cordis.patch.yml"), "utf8");
    const config = await readFile(join(ROOT, "src", "config.js"), "utf8");
    assert.match(config, /export const HARD_LIMITS/);
    assert.match(patch, /timeoutSeconds: 120/);
    assert.match(patch, /maxBoundingBoxMm: 2000/);
  });
});

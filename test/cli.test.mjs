import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, tempDir } from "./fixtures.mjs";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const WASHER = fileURLToPath(new URL("../examples/washer.json", import.meta.url));

let root;

async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      timeout: 60000,
      env: { ...process.env, DSH_CAD_FREECAD_CMD: "" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      message: error.message,
    };
  }
}

before(async () => { root = await tempDir(); });
after(async () => { await cleanup(root); });

describe("standalone CLI", () => {
  it("prints version, help and DSL schema", async () => {
    assert.match((await run(["--version"])).stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.match((await run(["help"])).stdout, /Usage: dsh-cad-freecad/);
    const schema = await run(["schema"]);
    assert.equal(schema.code, 0);
    assert.match(schema.stdout, /dsh\.cad\.freecad\/document@1/);
    assert.match(schema.stdout, /ops \(14\)/);
  });

  it("validates bundled examples", async () => {
    const result = await run(["validate", WASHER]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /VALID/);
  });

  it("emits machine-readable JSON", async () => {
    const result = await run(["validate", WASHER, "--json"]);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.valid, true);
  });

  it("fails on malformed documents", async () => {
    const bad = join(root, "bad.json");
    await writeFile(bad, "{not json", "utf8");
    const result = await run(["validate", bad]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /error|INVALID|invalid/i);
  });

  it("lists documents in an isolated work dir", async () => {
    const result = await run(["docs", "--work-dir", root]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /documents: 0/);
  });

  it("guards destructive and incomplete commands", async () => {
    const deleted = await run(["delete", "x", "--work-dir", root]);
    assert.notEqual(deleted.code, 0);
    assert.match(deleted.stdout + deleted.stderr, /confirmation_required/);
    const missing = await run(["get", "missing", "--work-dir", root]);
    assert.notEqual(missing.code, 0);
    const param = await run(["param", "x", "--work-dir", root]);
    assert.match(param.stdout + param.stderr, /--set/);
  });

  it("rejects unknown commands and options", async () => {
    assert.equal((await run(["frobnicate"])).code, 2);
    assert.equal((await run(["validate", "--not-an-option"])).code, 2);
  });
});

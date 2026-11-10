import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { DEFAULTS, HARD_LIMITS, defaultWorkDir, normalizeConfig } from "../src/config.js";
import {
  CadError, RESULT_PREFIX, errorResult, ensureWithin, isSafeId,
  parseResult, sha256Hex, successResult, truncate,
} from "../src/util.js";

describe("config normalization", () => {
  it("provides defaults and resolves an empty workDir", () => {
    const config = normalizeConfig();
    assert.equal(config.workDir, defaultWorkDir());
    assert.equal(config.timeoutSeconds, DEFAULTS.timeoutSeconds);
    assert.equal(config.allowExport, true);
    assert.equal(config.allowModelWrite, true);
  });

  it("clamps values to hard limits regardless of the patch", () => {
    const config = normalizeConfig({
      timeoutSeconds: 99999,
      maxFeatures: 99999,
      maxDocumentBytes: 999999999,
      maxBoundingBoxMm: 999999999,
      maxArtifactBytes: 999999999,
      maxPreviewPoints: 999999999,
    });
    assert.equal(config.timeoutSeconds, HARD_LIMITS.timeoutSeconds);
    assert.equal(config.maxFeatures, HARD_LIMITS.maxFeatures);
    assert.equal(config.maxDocumentBytes, HARD_LIMITS.maxDocumentBytes);
    assert.equal(config.maxBoundingBoxMm, HARD_LIMITS.maxBoundingBoxMm);
    assert.equal(config.maxArtifactBytes, HARD_LIMITS.maxArtifactBytes);
    assert.equal(config.maxPreviewPoints, HARD_LIMITS.maxPreviewPoints);
  });

  it("falls back on garbage numbers and honors booleans", () => {
    const config = normalizeConfig({ timeoutSeconds: "abc", allowExport: false, enableSkill: false });
    assert.equal(config.timeoutSeconds, DEFAULTS.timeoutSeconds);
    assert.equal(config.allowExport, false);
    assert.equal(config.enableSkill, false);
  });

  it("ignores non-object input", () => {
    assert.equal(normalizeConfig(42).workDir, defaultWorkDir());
  });
});

describe("util helpers", () => {
  it("rejects path traversal", () => {
    assert.throws(() => ensureWithin("/tmp/base", "../escape"), (error) => error instanceof CadError && error.code === "path_escape");
    assert.throws(() => ensureWithin("/tmp/base", "sub/../../escape"), /path_escape/);
    // Compare resolved paths: on Windows "/tmp/base" resolves to "<drive>:\tmp\base".
    const base = resolve("/tmp/base");
    assert.equal(ensureWithin(base, "sub", "file.txt"), join(base, "sub", "file.txt"));
  });

  it("validates safe ids", () => {
    assert.equal(isSafeId("part-01_A"), true);
    assert.equal(isSafeId("../evil"), false);
    assert.equal(isSafeId(""), false);
    assert.equal(isSafeId("with space"), false);
  });

  it("extracts the last machine-readable result line", () => {
    const stdout = ["FreeCAD banner", "noise", `${RESULT_PREFIX}{"success":true,"n":1}`, "trailing"].join("\n");
    assert.deepEqual(parseResult(stdout), { success: true, n: 1 });
    assert.throws(() => parseResult("no result here"), /bad_runner_output/);
    assert.throws(() => parseResult(`${RESULT_PREFIX}{broken`), /bad_runner_output/);
  });

  it("builds canonical result envelopes", () => {
    assert.deepEqual(successResult({ a: 1 }), { ok: true, a: 1 });
    assert.deepEqual(errorResult("x", "bad", { k: 1 }), { ok: false, error: { code: "x", message: "bad", details: { k: 1 } } });
    assert.equal(errorResult("x", "bad").error.details, undefined);
  });

  it("hashes and truncates deterministically", () => {
    assert.equal(sha256Hex("abc").length, 64);
    assert.equal(sha256Hex("abc"), sha256Hex("abc"));
    assert.match(truncate("abcdef", 3), /abc…/);
  });
});

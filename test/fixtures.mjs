/** Shared test helpers. No third-party dependencies. */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_ID } from "../src/schema.js";

export function minimalDocument(overrides = {}) {
  return {
    schema: SCHEMA_ID,
    name: "test-part",
    units: "mm",
    parameters: { h: 10 },
    features: [{ op: "box", id: "b", length: 10, width: 10, height: "$h" }],
    result: "b",
    ...overrides,
  };
}

export function sampleReport(volume = 1000) {
  return {
    units: "mm",
    valid: true,
    volume,
    area: 600,
    bbox: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] },
    center_of_mass: [5, 5, 5],
    topology: { solids: 1, faces: 6, edges: 12, vertices: 8 },
    checks: [
      { id: "valid", ok: true, detail: "BRep is valid" },
      { id: "has_solid", ok: true, detail: "1 solid(s)" },
    ],
    steps: [{ id: "b", op: "box", solids: 1, volume }],
  };
}

export function sampleViews() {
  const square = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
  return { front: square, top: square, right: square, iso: square };
}

/** Drop-in replacement for runFreeCADJob, so engine tests need no FreeCAD install. */
export function fakeRunner({ volume = 1000 } = {}) {
  return async (_command, job, _options) => {
    const result = { success: true, report: sampleReport(volume) };
    if (job.preview) result.views = sampleViews();
    if (job.export) {
      const content = Buffer.from(`FAKE-${job.export.format}-ARTIFACT\n`);
      await writeFile(job.export.path, content);
      result.artifact = {
        path: job.export.path,
        format: job.export.format,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }
    return result;
  };
}

export function fakeProbe() {
  return {
    success: true,
    version: ["1", "1", "4", "test"],
    python: "3.11.0",
    platform: process.platform,
    modules: { Part: true, Mesh: true },
    capabilities: { modeling: "declarative DSL", import: ["step"], export: ["step"] },
  };
}

export async function tempDir() {
  return mkdtemp(join(tmpdir(), "dsh-cad-freecad-test-"));
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Build an engine whose FreeCAD calls are fully simulated. */
export async function fakeEngine(CadEngine, workDir, options = {}) {
  const engine = await new CadEngine({
    workDir,
    ...options.config,
  }, {
    command: "fake-freecadcmd",
    runner: fakeRunner(options),
    probe: fakeProbe,
    ...options.seams,
  }).init();
  return engine;
}

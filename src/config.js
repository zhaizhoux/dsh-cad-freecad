/** Configuration normalization. Hard limits cannot be raised by a malformed patch. */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { clampNumber, isPlainObject } from "./util.js";

export const DEFAULTS = Object.freeze({
  workDir: "",
  freecadCmd: "",
  timeoutSeconds: 120,
  maxFeatures: 200,
  maxDocumentBytes: 1024 * 1024,
  maxBoundingBoxMm: 2000,
  maxArtifactBytes: 128 * 1024 * 1024,
  maxPreviewPoints: 20000,
  allowExport: true,
  allowModelWrite: true,
  enableSkill: true,
});

/** Ceilings enforced even when a user patch asks for more. */
export const HARD_LIMITS = Object.freeze({
  timeoutSeconds: 600,
  maxFeatures: 500,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxBoundingBoxMm: 100000,
  maxArtifactBytes: 256 * 1024 * 1024,
  maxPreviewPoints: 100000,
});

export function defaultWorkDir() {
  return resolve(homedir(), ".dsh-cad-freecad");
}

export function normalizeConfig(input = {}) {
  const raw = isPlainObject(input) ? input : {};
  const workDirValue = typeof raw.workDir === "string" ? raw.workDir.trim() : "";
  const workDir = workDirValue
    ? (isAbsolute(workDirValue) ? resolve(workDirValue) : resolve(homedir(), workDirValue))
    : defaultWorkDir();

  const bool = (key) => raw[key] === undefined ? DEFAULTS[key] : raw[key] !== false;

  return {
    workDir,
    freecadCmd: typeof raw.freecadCmd === "string" ? raw.freecadCmd.trim() : "",
    timeoutSeconds: clampNumber(raw.timeoutSeconds ?? DEFAULTS.timeoutSeconds, 1, HARD_LIMITS.timeoutSeconds, DEFAULTS.timeoutSeconds),
    maxFeatures: Math.round(clampNumber(raw.maxFeatures ?? DEFAULTS.maxFeatures, 1, HARD_LIMITS.maxFeatures, DEFAULTS.maxFeatures)),
    maxDocumentBytes: Math.round(clampNumber(raw.maxDocumentBytes ?? DEFAULTS.maxDocumentBytes, 1024, HARD_LIMITS.maxDocumentBytes, DEFAULTS.maxDocumentBytes)),
    maxBoundingBoxMm: clampNumber(raw.maxBoundingBoxMm ?? DEFAULTS.maxBoundingBoxMm, 1, HARD_LIMITS.maxBoundingBoxMm, DEFAULTS.maxBoundingBoxMm),
    maxArtifactBytes: Math.round(clampNumber(raw.maxArtifactBytes ?? DEFAULTS.maxArtifactBytes, 1024, HARD_LIMITS.maxArtifactBytes, DEFAULTS.maxArtifactBytes)),
    maxPreviewPoints: Math.round(clampNumber(raw.maxPreviewPoints ?? DEFAULTS.maxPreviewPoints, 100, HARD_LIMITS.maxPreviewPoints, DEFAULTS.maxPreviewPoints)),
    allowExport: bool("allowExport"),
    allowModelWrite: bool("allowModelWrite"),
    enableSkill: bool("enableSkill"),
  };
}

/** The config block shipped in cordis.patch.yml (kept in sync with DEFAULTS). */
export const PATCH_CONFIG = Object.freeze({
  workDir: "",
  freecadCmd: "",
  timeoutSeconds: DEFAULTS.timeoutSeconds,
  maxFeatures: DEFAULTS.maxFeatures,
  maxBoundingBoxMm: DEFAULTS.maxBoundingBoxMm,
  maxArtifactBytes: DEFAULTS.maxArtifactBytes,
  allowExport: true,
  allowModelWrite: true,
  enableSkill: true,
});

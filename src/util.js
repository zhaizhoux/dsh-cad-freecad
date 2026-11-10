/** Shared helpers. No third-party imports: the core engine must run without DSH installed. */
import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";

export const RESULT_PREFIX = "DSH_CAD_RESULT:";

export class CadError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CadError";
    this.code = code;
    this.details = details;
  }

  /** Surface the stable error code whenever the error is stringified (logs, test output). */
  toString() {
    return `CadError[${this.code}]: ${this.message}`;
  }
}

export function errorResult(code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function successResult(fields = {}) {
  return { ok: true, ...fields };
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeId(value) {
  return typeof value === "string" && SAFE_ID_RE.test(value);
}

export function assertSafeId(value, label = "id") {
  if (!isSafeId(value)) {
    throw new CadError("invalid_id", `${label} must match ${SAFE_ID_RE.source}`, { label, value: String(value) });
  }
  return value;
}

/** Resolve a path under root and reject traversal / absolute escapes. */
export function ensureWithin(root, ...parts) {
  const base = resolve(root);
  const target = resolve(base, ...parts.map((part) => String(part)));
  if (target === base) return target;
  if (!target.startsWith(base + sep)) {
    throw new CadError("path_escape", "path escapes the configured work directory", {
      root: base,
      target,
    });
  }
  return target;
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Extract the single machine-readable JSON line from FreeCADCmd's chatter. */
export function parseResult(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith(RESULT_PREFIX)) continue;
    const payload = line.slice(RESULT_PREFIX.length);
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw new CadError("bad_runner_output", "FreeCAD runner returned malformed JSON", {
        message: error.message,
      });
    }
  }
  throw new CadError("bad_runner_output", "FreeCAD runner did not return a result line", {
    tail: lines.slice(-6).join("\n").slice(0, 800),
  });
}

export function truncate(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function nowIso() {
  return new Date().toISOString();
}

export function absoluteOrNull(value) {
  return typeof value === "string" && value.trim() && isAbsolute(value) ? value : null;
}

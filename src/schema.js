/**
 * Declarative modeling DSL: dsh.cad.freecad/document@1
 *
 * A document is pure data. No user-authored Python/JS is ever executed.
 * Numeric fields accept a finite number or a `$parameter` reference; there is
 * deliberately no expression evaluator.
 */
import { isPlainObject, isSafeId } from "./util.js";

export const SCHEMA_ID = "dsh.cad.freecad/document@1";
export const MAX_FEATURES = 500;
export const MAX_POINTS = 512;
export const MAX_POSITIONS = 256;
export const MAX_ABS_VALUE = 1e9;

const AXES = new Set(["x", "y", "z"]);

/** op -> {required, optional, refs} where refs name fields holding shape ids. */
export const OPS = Object.freeze({
  box: { required: ["length", "width", "height"], optional: ["at"] },
  cylinder: { required: ["radius", "height"], optional: ["at", "axis"] },
  sphere: { required: ["radius"], optional: ["at"] },
  cone: { required: ["radius1", "radius2", "height"], optional: ["at", "axis"] },
  torus: { required: ["radius1", "radius2"], optional: ["at", "axis"] },
  polygon_extrude: { required: ["points", "height"], optional: ["at", "axis"] },
  revolve: { required: ["points", "angle"], optional: ["at", "axis"] },
  boolean: { required: ["mode", "parts"], optional: [], refs: ["parts"] },
  hole: { required: ["on", "diameter", "at"], optional: ["axis", "depth"], refs: ["on"] },
  hole_pattern: { required: ["on", "diameter"], optional: ["axis", "depth", "positions", "grid"], refs: ["on"] },
  fillet: { required: ["on", "radius"], optional: ["edge_ids"], refs: ["on"] },
  chamfer: { required: ["on", "size"], optional: ["edge_ids"], refs: ["on"] },
  shell: { required: ["on", "thickness"], optional: ["faces"], refs: ["on"] },
  transform: { required: ["on"], optional: ["translate", "rotate", "mirror", "scale"], refs: ["on"] },
});

export const OP_NAMES = Object.freeze(Object.keys(OPS));
export const BOOLEAN_MODES = Object.freeze(["union", "cut", "common"]);
export const IMPORT_FORMATS = Object.freeze(["step", "iges", "brep"]);
export const EXPORT_FORMATS = Object.freeze(["step", "iges", "stl", "brep", "svg", "dxf", "json"]);

const NUMERIC_KEYS = new Set([
  "length", "width", "height", "radius", "radius1", "radius2", "diameter",
  "depth", "thickness", "size", "angle", "scale",
]);
const VECTOR_KEYS = new Set(["at", "translate", "mirror"]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isRef(value) {
  return typeof value === "string" && /^\$[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
}

function refName(value) {
  return value.slice(1);
}

function validateNumber(errors, path, value, parameters, { positive = false, allowZero = false } = {}) {
  if (isFiniteNumber(value)) {
    if (Math.abs(value) > MAX_ABS_VALUE) {
      errors.push({ path, message: `value ${value} exceeds the allowed magnitude` });
    } else if (positive && value <= 0 && !(allowZero && value === 0)) {
      errors.push({ path, message: "must be greater than zero" });
    }
    return;
  }
  if (isRef(value)) {
    const name = refName(value);
    if (!Object.hasOwn(parameters, name)) {
      errors.push({ path, message: `unknown parameter $${name}` });
    } else if (!isFiniteNumber(parameters[name])) {
      errors.push({ path, message: `parameter $${name} is not a finite number` });
    }
    return;
  }
  errors.push({ path, message: "must be a finite number or a $parameter reference" });
}

function validateVector(errors, path, value, parameters, size = 3) {
  if (!Array.isArray(value) || value.length !== size) {
    errors.push({ path, message: `must be an array of ${size} numbers` });
    return;
  }
  value.forEach((item, index) => validateNumber(errors, `${path}[${index}]`, item, parameters));
}

function validatePoints(errors, path, value, parameters) {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_POINTS) {
    errors.push({ path, message: `must be an array of 3..${MAX_POINTS} [x, y] points` });
    return;
  }
  value.forEach((point, index) => validateVector(errors, `${path}[${index}]`, point, parameters, 2));
}

function validatePositions(errors, path, value, parameters) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_POSITIONS) {
    errors.push({ path, message: `must be an array of 1..${MAX_POSITIONS} [x, y, z] positions` });
    return;
  }
  value.forEach((point, index) => validateVector(errors, `${path}[${index}]`, point, parameters));
}

function validateGrid(errors, path, value, parameters) {
  if (!isPlainObject(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const key of ["origin", "step_x", "step_y", "count_x", "count_y"]) {
    if (!(key in value)) errors.push({ path: `${path}.${key}`, message: "is required in grid" });
  }
  if ("origin" in value) validateVector(errors, `${path}.origin`, value.origin, parameters);
  for (const key of ["step_x", "step_y", "count_x", "count_y"]) {
    if (!(key in value)) continue;
    validateNumber(errors, `${path}.${key}`, value[key], parameters, { positive: key.startsWith("count") });
  }
}

/**
 * Validate a document without resolving parameter references.
 * Returns { ok, errors, document } — `document` is a normalized, safe copy.
 */
export function validateDocument(input, options = {}) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: "$", message: "document must be a JSON object" }] };
  }

  const maxFeatures = options.maxFeatures ?? MAX_FEATURES;
  if (input.schema !== undefined && input.schema !== SCHEMA_ID) {
    errors.push({ path: "$.schema", message: `must be ${SCHEMA_ID}` });
  }

  const name = typeof input.name === "string" && input.name.trim()
    ? input.name.trim().slice(0, 120)
    : "untitled";
  const units = input.units === undefined ? "mm" : input.units;
  if (units !== "mm") errors.push({ path: "$.units", message: 'only "mm" is supported' });

  const parameters = isPlainObject(input.parameters) ? { ...input.parameters } : {};
  if (!isPlainObject(input.parameters) && input.parameters !== undefined) {
    errors.push({ path: "$.parameters", message: "must be an object of finite numbers" });
  }
  for (const [key, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      errors.push({ path: `$.parameters.${key}`, message: "invalid parameter name" });
    } else if (!isFiniteNumber(value)) {
      errors.push({ path: `$.parameters.${key}`, message: "must be a finite number" });
    }
  }

  if (!Array.isArray(input.features) || input.features.length === 0) {
    errors.push({ path: "$.features", message: "must be a non-empty array" });
  }
  const features = Array.isArray(input.features) ? input.features : [];
  if (features.length > maxFeatures) {
    errors.push({ path: "$.features", message: `too many features (limit ${maxFeatures})` });
  }

  const ids = new Set();
  features.forEach((feature, index) => {
    const path = `$.features[${index}]`;
    if (!isPlainObject(feature)) {
      errors.push({ path, message: "must be an object" });
      return;
    }
    const id = feature.id;
    if (!isSafeId(id)) {
      errors.push({ path: `${path}.id`, message: "must be a safe id (letters, digits, _ and -, 1..64 chars)" });
    } else if (ids.has(id)) {
      errors.push({ path: `${path}.id`, message: `duplicate id "${id}"` });
    } else {
      ids.add(id);
    }

    const op = feature.op;
    if (typeof op !== "string" || !Object.hasOwn(OPS, op)) {
      errors.push({ path: `${path}.op`, message: `unknown op (expected one of ${OP_NAMES.join(", ")})` });
      return;
    }
    const spec = OPS[op];
    for (const key of spec.required) {
      if (!(key in feature)) errors.push({ path: `${path}.${key}`, message: "is required" });
    }
    const allowed = new Set(["id", "op", ...spec.required, ...spec.optional]);
    for (const key of Object.keys(feature)) {
      if (!allowed.has(key)) errors.push({ path: `${path}.${key}`, message: "unknown field for this op" });
    }

    for (const key of Object.keys(feature)) {
      if (key === "id" || key === "op") continue;
      const value = feature[key];
      const fieldPath = `${path}.${key}`;
      if (NUMERIC_KEYS.has(key)) {
        validateNumber(errors, fieldPath, value, parameters, { positive: ["length", "width", "height", "radius", "radius1", "diameter", "depth", "thickness", "size", "scale"].includes(key), allowZero: key === "radius2" });
      } else if (VECTOR_KEYS.has(key)) {
        validateVector(errors, fieldPath, value, parameters);
      } else if (key === "axis") {
        if (!AXES.has(value)) errors.push({ path: fieldPath, message: "must be x, y or z" });
      } else if (key === "mode") {
        if (!BOOLEAN_MODES.includes(value)) errors.push({ path: fieldPath, message: `must be one of ${BOOLEAN_MODES.join(", ")}` });
      } else if (key === "points") {
        validatePoints(errors, fieldPath, value, parameters);
      } else if (key === "positions") {
        validatePositions(errors, fieldPath, value, parameters);
      } else if (key === "grid") {
        validateGrid(errors, fieldPath, value, parameters);
      } else if (key === "rotate") {
        if (!Array.isArray(value) || value.length !== 4) {
          errors.push({ path: fieldPath, message: "must be [axis_x, axis_y, axis_z, angle_degrees]" });
        } else {
          value.forEach((item, i) => validateNumber(errors, `${fieldPath}[${i}]`, item, parameters));
        }
      } else if (key === "edge_ids" || key === "faces") {
        if (!Array.isArray(value) || value.length > 256) {
          errors.push({ path: fieldPath, message: "must be an array of at most 256 indices" });
        } else {
          value.forEach((item, i) => {
            if (!Number.isInteger(item) || item < 0) errors.push({ path: `${fieldPath}[${i}]`, message: "must be a non-negative integer" });
          });
        }
      }
    }

    // Shape references must point at an earlier feature (a strict DAG).
    for (const key of spec.refs ?? []) {
      const value = feature[key];
      const list = Array.isArray(value) ? value : [value];
      if (key === "parts" && (!Array.isArray(value) || value.length < 2)) {
        errors.push({ path: `${path}.parts`, message: "boolean needs at least two shape ids" });
      }
      list.forEach((ref, refIndex) => {
        if (typeof ref !== "string" || !ids.has(ref) || ref === id) {
          errors.push({ path: `${path}.${key}[${refIndex}]`, message: "must reference an earlier feature id" });
        }
      });
    }

    if (op === "hole_pattern" && !("positions" in feature) && !("grid" in feature)) {
      errors.push({ path, message: "hole_pattern needs positions or grid" });
    }
    if (op === "transform" && !["translate", "rotate", "mirror", "scale"].some((key) => key in feature)) {
      errors.push({ path, message: "transform needs at least one of translate/rotate/mirror/scale" });
    }
  });

  const result = input.result === undefined
    ? (features.at(-1)?.id ?? "")
    : input.result;
  if (!isSafeId(result) || !ids.has(result)) {
    errors.push({ path: "$.result", message: "must reference a feature id" });
  }

  if (errors.length > 0) return { ok: false, errors };

  const document = {
    schema: SCHEMA_ID,
    name,
    units,
    parameters,
    features: features.map((feature) => ({ ...feature })),
    result,
  };
  return { ok: true, errors: [], document };
}

/** Resolve `$ref` values against parameters (used by docs and the UI preview). */
export function resolveValue(value, parameters) {
  if (isRef(value)) return parameters[refName(value)];
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, parameters));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, parameters)]));
  }
  return value;
}

/** Human-readable schema summary for docs, doctor output and the Web UI. */
export function describeSchema() {
  return {
    schema: SCHEMA_ID,
    ops: OP_NAMES,
    booleanModes: [...BOOLEAN_MODES],
    importFormats: [...IMPORT_FORMATS],
    exportFormats: [...EXPORT_FORMATS],
    parameterReference: "$name",
    note: "Documents are pure data; no user code is executed.",
  };
}

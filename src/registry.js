/** High-level engine API shared by the DSH tools, the standalone CLI and the Web UI. */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { normalizeConfig } from "./config.js";
import { DocumentStore } from "./document.js";
import {
  EXPORT_FORMATS, IMPORT_FORMATS, describeSchema, validateDocument,
} from "./schema.js";
import { findFreeCAD, probeBackend, runFreeCADJob } from "./runner.js";
import { buildDxf, buildSheetSvg, buildSvg, VIEW_NAMES } from "./svg.js";
import {
  CadError, errorResult, isPlainObject, sha256Hex, successResult, truncate,
} from "./util.js";

const NATIVE_FORMATS = new Set(["step", "iges", "stl", "brep"]);
const FORMAT_ALIASES = { stp: "step", igs: "iges", brp: "brep", dxf: "dxf", svg: "svg", json: "json" };
const EXT_TO_FORMAT = {
  ".step": "step", ".stp": "step", ".iges": "iges", ".igs": "iges",
  ".brep": "brep", ".brp": "brep", ".stl": "stl",
};

function normalizeFormat(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/^\./, "");
  return FORMAT_ALIASES[raw] ?? raw;
}

function brief(record) {
  return {
    id: record.id,
    name: record.name,
    revision: record.revision,
    sha256: record.sha256,
    bytes: record.bytes,
    createdAt: record.createdAt,
  };
}

function fileInfo(path, content, format) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  return { path, format, bytes: buffer.length, sha256: sha256Hex(buffer) };
}

export class CadEngine {
  /**
   * @param {object} config normalized plugin config
   * @param {object} options test seams: {runner, probe, command}
   *   runner(command, job, options) replaces the FreeCAD process adapter;
   *   probe(command) replaces the backend probe; command skips auto-detection.
   */
  constructor(config = {}, options = {}) {
    this.config = normalizeConfig(config);
    this.store = new DocumentStore(this.config.workDir, {
      maxFeatures: this.config.maxFeatures,
      maxDocumentBytes: this.config.maxDocumentBytes,
    });
    this._command = null;
    this._commandVersion = "";
    this._runner = options.runner ?? null;
    this._probe = options.probe ?? null;
    this._commandOverride = options.command ?? null;
  }

  async init() {
    await this.store.init();
    return this;
  }

  _limits() {
    return {
      maxBoundingBoxMm: this.config.maxBoundingBoxMm,
      maxArtifactBytes: this.config.maxArtifactBytes,
      maxPreviewPoints: this.config.maxPreviewPoints,
    };
  }

  async _resolveCommand() {
    if (this._commandOverride) return this._commandOverride;
    if (this._command) return this._command;
    const found = await findFreeCAD(this.config.freecadCmd);
    if (!found.command) {
      throw new CadError("no_backend", "FreeCADCmd was not found on this machine", {
        installHint: "Install FreeCAD 1.0+ or set DSH_CAD_FREECAD_CMD / config.freecadCmd to freecadcmd.exe",
        tried: found.traces.slice(0, 8),
      });
    }
    this._command = found.command;
    this._commandVersion = found.version;
    return found.command;
  }

  async _run(job, signal) {
    const command = await this._resolveCommand();
    const runner = this._runner ?? runFreeCADJob;
    return runner(command, { ...job, limits: this._limits() }, {
      timeoutMs: this.config.timeoutSeconds * 1000,
      signal,
    });
  }

  _wrap(error) {
    if (error instanceof CadError) return errorResult(error.code, error.message, error.details);
    return errorResult("internal_error", truncate(error?.message ?? String(error), 400));
  }

  _checkDocument(document) {
    let parsed = document;
    if (typeof document === "string") {
      try {
        parsed = JSON.parse(document);
      } catch (error) {
        throw new CadError("invalid_json", "document is not valid JSON", { message: error.message });
      }
    }
    const checked = validateDocument(parsed, { maxFeatures: this.config.maxFeatures });
    if (!checked.ok) {
      throw new CadError("invalid_document", "document failed schema validation", {
        errors: checked.errors.slice(0, 20),
      });
    }
    return checked.document;
  }

  _targetPath(outputPath, filename) {
    if (outputPath) {
      const target = resolve(String(outputPath));
      if (!isAbsolute(target)) throw new CadError("invalid_path", "output path must be absolute");
      return target;
    }
    return this.store.artifactPath(filename);
  }

  async _write(path, content, format) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.isBuffer(content) ? content : String(content));
    return fileInfo(path, content, format);
  }

  /** Capability matrix + environment report. */
  async doctor(options = {}) {
    try {
      const found = this._commandOverride
        ? { command: this._commandOverride, version: "injected", traces: [] }
        : await findFreeCAD(this.config.freecadCmd);
      const payload = {
        available: false,
        backend: {
          id: "freecad",
          displayName: "FreeCAD (local OCCT kernel)",
          executablePath: found.command ?? null,
          version: found.version || null,
          modelingLanguage: "declarative JSON DSL",
          importFormats: [...IMPORT_FORMATS],
          exportFormats: [...EXPORT_FORMATS],
        },
        config: { ...this.config },
        schema: describeSchema(),
        installHint: "Install FreeCAD 1.0+ or set DSH_CAD_FREECAD_CMD",
      };
      if (!found.command) return successResult(payload);
      try {
        const probe = this._probe
          ? await this._probe(found.command)
          : await probeBackend(found.command);
        payload.available = true;
        payload.backend.version = probe.version?.slice(0, 3).join(".") ?? found.version;
        payload.backend.python = probe.python;
        payload.backend.modules = probe.modules;
        payload.backend.capabilities = probe.capabilities;
        delete payload.installHint;
      } catch (error) {
        payload.backend.missingReason = error.message;
      }
      if (options.includeTraces) payload.backend.tried = found.traces.slice(0, 8);
      return successResult(payload);
    } catch (error) {
      return this._wrap(error);
    }
  }

  /** Validate a document without building geometry. */
  async validate(document, options = {}) {
    try {
      const checked = this._checkDocument(document);
      return successResult({
        valid: true,
        schema: checked.schema,
        name: checked.name,
        features: checked.features.length,
        parameters: Object.keys(checked.parameters).length,
        result: checked.result,
        ops: [...new Set(checked.features.map((feature) => feature.op))],
        ...(options.includeDocument ? { document: checked } : {}),
      });
    } catch (error) {
      if (error instanceof CadError && (error.code === "invalid_document" || error.code === "invalid_json")) {
        return successResult({ valid: false, errors: error.details?.errors ?? [{ message: error.message }] });
      }
      return this._wrap(error);
    }
  }

  /** Build geometry, then persist an immutable document revision. */
  async build(document, options = {}) {
    try {
      const checked = this._checkDocument(document);
      const result = await this._run({
        op: "build",
        document: checked,
        preview: Boolean(options.preview),
      }, options.signal);
      const saved = await this.store.put(checked, { id: options.id, source: options.source ?? "build" });
      return successResult({
        document: saved,
        report: result.report,
        ...(options.preview ? { views: result.views } : {}),
      });
    } catch (error) {
      return this._wrap(error);
    }
  }

  async measure(id, options = {}) {
    try {
      const record = await this.store.get(id, options.revision);
      const result = await this._run({ op: "build", document: record.document, preview: false }, options.signal);
      return successResult({ document: brief(record), report: result.report });
    } catch (error) {
      return this._wrap(error);
    }
  }

  async preview(id, options = {}) {
    try {
      const record = await this.store.get(id, options.revision);
      const result = await this._run({ op: "build", document: record.document, preview: true }, options.signal);
      const view = VIEW_NAMES.includes(options.view) ? options.view : "all";
      const common = { views: result.views, report: result.report, name: record.name, dark: Boolean(options.dark) };
      const svg = view === "all" ? buildSheetSvg(common) : buildSvg({ ...common, view });
      const payload = { document: brief(record), report: result.report, view, svg };
      if (options.save) {
        const path = this._targetPath(options.outputPath, `${id}-r${record.revision}-${view}.svg`);
        payload.artifact = await this._write(path, svg, "svg");
        payload.svg = undefined;
      }
      return successResult(payload);
    } catch (error) {
      return this._wrap(error);
    }
  }

  async exportDocument(id, options = {}) {
    try {
      const format = normalizeFormat(options.format);
      if (!EXPORT_FORMATS.includes(format)) {
        return errorResult("unsupported_format", `unsupported export format: ${format}`, { supported: [...EXPORT_FORMATS] });
      }
      if (!this.config.allowExport) return errorResult("export_disabled", "export is disabled by configuration");
      const record = await this.store.get(id, options.revision);
      const filename = options.filename ?? `${id}-r${record.revision}.${format}`;
      const target = this._targetPath(options.outputPath, filename);
      await mkdir(dirname(target), { recursive: true });

      let artifact;
      let report;
      if (NATIVE_FORMATS.has(format)) {
        const result = await this._run({
          op: "build",
          document: record.document,
          export: { format, path: target },
        }, options.signal);
        artifact = result.artifact;
        report = result.report;
      } else {
        const result = await this._run({
          op: "build", document: record.document, preview: format !== "json",
        }, options.signal);
        report = result.report;
        if (format === "svg") {
          artifact = await this._write(target, buildSheetSvg({
            views: result.views, report, name: record.name, dark: Boolean(options.dark),
          }), format);
        } else if (format === "dxf") {
          artifact = await this._write(target, buildDxf({ views: result.views, name: record.name }), format);
        } else {
          artifact = await this._write(target, JSON.stringify({
            document: record.document, documentRef: brief(record), report,
          }, null, 2), format);
        }
      }
      return successResult({ document: brief(record), artifact, report });
    } catch (error) {
      return this._wrap(error);
    }
  }

  /** Inspect an external STEP / IGES / BREP file (never modifies the source). */
  async importDocument(path, options = {}) {
    try {
      const source = resolve(String(path ?? ""));
      const info = await stat(source);
      if (!info.isFile()) return errorResult("not_a_file", "import path is not a file");
      const format = normalizeFormat(options.format ?? EXT_TO_FORMAT[extname(source).toLowerCase()] ?? "");
      if (!IMPORT_FORMATS.includes(format)) {
        return errorResult("unsupported_format", `unsupported import format: ${format}`, { supported: [...IMPORT_FORMATS] });
      }
      const result = await this._run({
        op: "import", path: source, format, preview: Boolean(options.preview),
      }, options.signal);
      return successResult({
        source: { path: source, name: basename(source), format, bytes: info.size },
        report: result.report,
        ...(options.preview ? {
          svg: buildSheetSvg({ views: result.views, report: result.report, name: basename(source) }),
        } : {}),
      });
    } catch (error) {
      return this._wrap(error);
    }
  }

  async convert(path, options = {}) {
    try {
      const source = resolve(String(path ?? ""));
      const info = await stat(source);
      if (!info.isFile()) return errorResult("not_a_file", "source is not a file");
      const inFormat = normalizeFormat(options.sourceFormat ?? EXT_TO_FORMAT[extname(source).toLowerCase()] ?? "");
      const outFormat = normalizeFormat(options.format);
      if (!IMPORT_FORMATS.includes(inFormat) || !EXPORT_FORMATS.includes(outFormat)) {
        return errorResult("unsupported_format", "unsupported conversion", {
          import: [...IMPORT_FORMATS], export: [...EXPORT_FORMATS],
        });
      }
      if (!this.config.allowExport) return errorResult("export_disabled", "export is disabled by configuration");
      const filename = options.filename ?? `${basename(source, extname(source))}.${outFormat}`;
      const target = this._targetPath(options.outputPath, filename);
      await mkdir(dirname(target), { recursive: true });

      if (NATIVE_FORMATS.has(outFormat)) {
        const result = await this._run({
          op: "import", path: source, format: inFormat,
          export: { format: outFormat, path: target },
        }, options.signal);
        return successResult({ artifact: result.artifact, report: result.report, source: basename(source) });
      }
      const result = await this._run({
        op: "import", path: source, format: inFormat, preview: true,
      }, options.signal);
      const content = outFormat === "svg"
        ? buildSheetSvg({ views: result.views, report: result.report, name: basename(source) })
        : outFormat === "dxf"
          ? buildDxf({ views: result.views, name: basename(source) })
          : JSON.stringify({ source: basename(source), report: result.report }, null, 2);
      return successResult({
        artifact: await this._write(target, content, outFormat),
        report: result.report,
        source: basename(source),
      });
    } catch (error) {
      return this._wrap(error);
    }
  }

  async listDocuments() {
    try {
      return successResult({ documents: await this.store.list() });
    } catch (error) {
      return this._wrap(error);
    }
  }

  async getDocument(id, options = {}) {
    try {
      // Accept both getDocument(id, { revision }) and the shorthand getDocument(id, 3).
      const opts = typeof options === "number" ? { revision: options } : options;
      const record = await this.store.get(id, opts.revision);
      return successResult({
        document: record.document,
        ref: brief(record),
        revisions: record.meta.revisions ?? [],
      });
    } catch (error) {
      return this._wrap(error);
    }
  }

  async revisions(id) {
    try {
      return successResult({ id, revisions: await this.store.revisions(id) });
    } catch (error) {
      return this._wrap(error);
    }
  }

  async setParameters(id, parameters, options = {}) {
    try {
      let parsed = parameters;
      if (typeof parameters === "string") parsed = JSON.parse(parameters);
      if (!isPlainObject(parsed)) throw new CadError("invalid_parameters", "parameters must be an object");
      const saved = await this.store.setParameters(id, parsed);
      const payload = { document: saved };
      if (options.measure !== false) {
        const measured = await this.measure(id, { signal: options.signal });
        if (measured.ok) payload.report = measured.report;
      }
      return successResult(payload);
    } catch (error) {
      return this._wrap(error);
    }
  }

  async removeDocument(id, options = {}) {
    try {
      if (options.confirm !== true) {
        return errorResult("confirmation_required", "pass confirm:true to delete a document");
      }
      return successResult(await this.store.remove(id));
    } catch (error) {
      return this._wrap(error);
    }
  }
}

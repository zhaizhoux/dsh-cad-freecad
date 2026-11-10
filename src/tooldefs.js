/**
 * Tool definitions, kept free of any DSH import so they can be unit-tested,
 * reused by the CLI, and inspected without a Harness installation.
 *
 * `parameters` follows the schemastery field-map shape used by installed DSH
 * plugins (each field carries type / required / description). `output.schema`
 * is the canonical object-rooted JSON Schema required by the host, and
 * `output.render` turns results into compact text for the model.
 */
import { EXPORT_FORMATS, IMPORT_FORMATS, OP_NAMES } from "./schema.js";
import { VIEW_NAMES } from "./svg.js";

function outSchema(extra = {}) {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      ok: { type: "boolean", required: true },
      error: { type: "object", additionalProperties: true },
      ...extra,
    },
  };
}

function num(value, digits = 3) {
  return typeof value === "number" ? Number(value.toFixed(digits)).toString() : String(value ?? "?");
}

function summarize(value) {
  if (!value || value.ok === false) {
    const error = value?.error ?? {};
    const lines = [`✗ [${error.code ?? "error"}] ${error.message ?? "unknown failure"}`];
    if (error.details?.errors) {
      for (const item of error.details.errors.slice(0, 8)) {
        lines.push(`  - ${item.path ?? ""}: ${item.message}`);
      }
    }
    return lines.join("\n");
  }
  const lines = [];
  if (value.available !== undefined) {
    lines.push(`FreeCAD backend: ${value.available ? "available" : "MISSING"}`);
    if (value.backend?.version) lines.push(`  version: ${value.backend.version}`);
    if (value.backend?.executablePath) lines.push(`  executable: ${value.backend.executablePath}`);
    if (value.backend?.exportFormats) lines.push(`  export: ${value.backend.exportFormats.join(", ")}`);
    if (value.installHint) lines.push(`  install: ${value.installHint}`);
  }
  if (value.valid !== undefined) {
    lines.push(`document: ${value.valid ? "VALID" : "INVALID"}`);
    if (value.features !== undefined) lines.push(`  features: ${value.features}, result: ${value.result}`);
    if (value.errors) for (const item of value.errors.slice(0, 8)) lines.push(`  - ${item.path ?? ""}: ${item.message}`);
  }
  if (value.document) {
    lines.push(`document: ${value.document.id ?? value.document.name} (revision ${value.document.revision ?? "?"})`);
    if (value.document.sha256) lines.push(`  sha256: ${value.document.sha256.slice(0, 16)}…`);
  }
  if (value.report) {
    const report = value.report;
    lines.push(`geometry: ${report.valid ? "VALID" : "INVALID"} | volume ${num(report.volume)} mm³ | area ${num(report.area)} mm²`);
    if (report.bbox?.size) lines.push(`  bbox: ${report.bbox.size.map((item) => num(item)).join(" x ")} mm`);
    if (report.topology) lines.push(`  topology: ${report.topology.solids} solids / ${report.topology.faces} faces / ${report.topology.edges} edges`);
    for (const check of report.checks ?? []) {
      if (!check.ok) lines.push(`  ✗ ${check.id}: ${check.detail}`);
    }
  }
  if (value.artifact) {
    lines.push(`artifact: ${value.artifact.path}`);
    lines.push(`  ${value.artifact.format} | ${value.artifact.bytes} bytes | sha256 ${String(value.artifact.sha256).slice(0, 16)}…`);
  }
  if (value.svg !== undefined) lines.push(`svg: generated (${String(value.svg).length} chars)`);
  if (value.documents) {
    lines.push(`documents: ${value.documents.length}`);
    for (const item of value.documents.slice(0, 12)) {
      lines.push(`  - ${item.id} r${item.active} "${item.name}" (${item.revisions} revisions)`);
    }
  }
  if (value.revisions) lines.push(`revisions: ${value.revisions.length}`);
  if (value.removed) lines.push(`deleted: ${value.removed}`);
  if (value.source?.path) lines.push(`source: ${value.source.path}`);
  if (lines.length === 0) lines.push("ok");
  return lines.join("\n");
}

function render(_args, value) {
  return [{ type: "text", text: summarize(value) }];
}

function field(type, description, required = false) {
  return { type, description, ...(required ? { required: true } : {}) };
}

function signalOf(exec) {
  return exec?.signal;
}

/**
 * Build the complete `fcad_*` tool family for one engine instance.
 * Names use the `fcad_` prefix to avoid collisions with the already-installed
 * `cad_*` tools from dsh-cad-design / dsh-cad.
 */
export function createToolDefinitions(engine) {
  const tools = [
    {
      name: "fcad_doctor",
      description: "Check whether the local FreeCAD kernel is installed and usable, report its version, Python runtime, available modules, import/export formats, active config and the declarative modeling DSL. Call this FIRST when any fcad_* tool reports no_backend, and whenever you need the list of supported operations before writing a CAD document.",
      parameters: {
        verbose: field("boolean", "Include the list of executable paths that were probed."),
      },
      output: { schema: outSchema({ available: { type: "boolean" } }), render },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return engine.doctor({ includeTraces: args.verbose === true, signal: signalOf(exec) });
      },
    },
    {
      name: "fcad_validate",
      description: "Validate a declarative CAD document (JSON text) without building geometry. Checks the DSL schema, parameter references, feature ids, shape references and limits. Use this to catch mistakes before fcad_build; it never writes files.",
      parameters: {
        document: field("string", "The full declarative CAD document as JSON text (schema dsh.cad.freecad/document@1).", true),
        include_document: field("boolean", "Return the normalized document alongside the verdict."),
      },
      output: { schema: outSchema({ valid: { type: "boolean" } }), render },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return engine.validate(args.document, { includeDocument: args.include_document === true, signal: signalOf(exec) });
      },
    },
    {
      name: "fcad_build",
      description: "Build a 3D solid from a declarative CAD document using the local FreeCAD OCCT kernel, verify the resulting BRep, and store the document as an immutable revision. Returns exact volume, area, bounding box, center of mass, topology and per-feature steps. Documents are pure data: no user code is executed.",
      parameters: {
        document: field("string", "The full declarative CAD document as JSON text.", true),
        name: field("string", "Override the document name (used for the generated id)."),
        id: field("string", "Append a revision to an existing document id instead of creating a new one."),
        preview: field("boolean", "Also return four-view edge projections for preview rendering."),
      },
      output: { schema: outSchema({ document: { type: "object" }, report: { type: "object" } }), render },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        let document = args.document;
        if (args.name && typeof document === "string") {
          try {
            const parsed = JSON.parse(document);
            parsed.name = args.name;
            document = JSON.stringify(parsed);
          } catch { /* validation will report the parse error */ }
        }
        return engine.build(document, {
          id: args.id,
          preview: args.preview === true,
          signal: signalOf(exec),
        });
      },
    },
    {
      name: "fcad_measure",
      description: "Rebuild a stored document and report exact geometry facts: volume, surface area, bounding box, center of mass, solid/face/edge counts and validity checks. Use after a parameter change or to verify a model before export.",
      parameters: {
        id: field("string", "Stored document id.", true),
        revision: field("number", "Specific revision number (defaults to the active one)."),
      },
      output: { schema: outSchema({ report: { type: "object" } }), render },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return engine.measure(args.id, { revision: args.revision, signal: signalOf(exec) });
      },
    },
    {
      name: "fcad_preview",
      description: "Render a stored model as an SVG drawing (four orthographic/isometric views, or a single view). By default the SVG is written to the artifacts directory and the tool returns a file reference instead of bytes. Set inline:true to receive the SVG text directly.",
      parameters: {
        id: field("string", "Stored document id.", true),
        view: field("string", `One of ${VIEW_NAMES.join(", ")} (default all).`),
        revision: field("number", "Specific revision number."),
        inline: field("boolean", "Return the SVG text in the result instead of writing a file."),
        dark: field("boolean", "Use a dark color scheme."),
      },
      output: { schema: outSchema({ artifact: { type: "object" }, svg: { type: "string" } }), render },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return engine.preview(args.id, {
          view: args.view,
          revision: args.revision,
          inline: args.inline === true,
          save: args.inline !== true,
          dark: args.dark === true,
          signal: signalOf(exec),
        });
      },
    },
    {
      name: "fcad_export",
      description: "Export a stored model to STEP, IGES, STL, BREP, SVG, DXF or a JSON geometry report. Files are written under the configured work directory (or an explicit absolute path) and the result carries path, byte size and SHA-256 — never raw bytes.",
      parameters: {
        id: field("string", "Stored document id.", true),
        format: field("string", `One of ${EXPORT_FORMATS.join(", ")}.`, true),
        filename: field("string", "Override the generated artifact filename."),
        revision: field("number", "Specific revision number."),
      },
      output: { schema: outSchema({ artifact: { type: "object" } }), render },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return engine.exportDocument(args.id, {
          format: args.format,
          filename: args.filename,
          revision: args.revision,
          signal: signalOf(exec),
        });
      },
    },
    {
      name: "fcad_import",
      description: "Read-only inspection of an external STEP / IGES / BREP file: returns exact volume, area, extents, topology and validity without modifying the source. Use fcad_convert to turn it into another format.",
      parameters: {
        path: field("string", "Absolute path to the source CAD file.", true),
        format: field("string", `Format override: ${IMPORT_FORMATS.join(", ")} (otherwise inferred from the extension).`),
      },
      output: { schema: outSchema({ report: { type: "object" } }), render },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return engine.importDocument(args.path, { format: args.format, signal: signalOf(exec) });
      },
    },
    {
      name: "fcad_convert",
      description: "Convert an external STEP / IGES / BREP file into STEP, IGES, STL, BREP, SVG, DXF or JSON using FreeCAD. The source file is never modified.",
      parameters: {
        path: field("string", "Absolute path to the source CAD file.", true),
        format: field("string", `Target format: ${EXPORT_FORMATS.join(", ")}.`, true),
        source_format: field("string", `Source format override: ${IMPORT_FORMATS.join(", ")}.`),
        filename: field("string", "Override the generated artifact filename."),
      },
      output: { schema: outSchema({ artifact: { type: "object" } }), render },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return engine.convert(args.path, {
          format: args.format,
          sourceFormat: args.source_format,
          filename: args.filename,
          signal: signalOf(exec),
        });
      },
    },
    {
      name: "fcad_docs",
      description: "List all stored parametric documents with their active revision, revision count and timestamps. Immutable revisions mean every parameter edit creates a new revision instead of overwriting history.",
      parameters: {},
      output: { schema: outSchema({ documents: { type: "array", items: { type: "object" } } }), render },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        return engine.listDocuments({ signal: signalOf(exec) });
      },
    },
    {
      name: "fcad_doc_get",
      description: "Read a stored document (its declarative JSON, parameters, features) and its full revision history. Use before fcad_param to see which parameters can be changed.",
      parameters: {
        id: field("string", "Stored document id.", true),
        revision: field("number", "Specific revision number (defaults to active)."),
      },
      output: { schema: outSchema({ document: { type: "object" }, revisions: { type: "array" } }), render },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return engine.getDocument(args.id, { revision: args.revision, signal: signalOf(exec) });
      },
    },
    {
      name: "fcad_param",
      description: "Change numeric parameters of a stored document and rebuild it. The edit does NOT overwrite history — it appends revision N+1 and returns the new geometry report. Pass parameters as a JSON object string, e.g. {\"width\": 120}.",
      parameters: {
        id: field("string", "Stored document id.", true),
        parameters: field("string", "JSON object text with the parameter values to change.", true),
        measure: field("boolean", "Rebuild and return geometry facts (default true)."),
      },
      output: { schema: outSchema({ document: { type: "object" }, report: { type: "object" } }), render },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return engine.setParameters(args.id, args.parameters, {
          measure: args.measure !== false,
          signal: signalOf(exec),
        });
      },
    },
    {
      name: "fcad_doc_delete",
      description: "Permanently delete a stored document and all of its revisions. Requires confirm:true. Exported artifacts are not deleted.",
      parameters: {
        id: field("string", "Stored document id.", true),
        confirm: field("boolean", "Must be true; prevents accidental deletion.", true),
      },
      output: { schema: outSchema({ removed: { type: "boolean" } }), render },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return engine.removeDocument(args.id, { confirm: args.confirm === true, signal: signalOf(exec) });
      },
    },
  ];

  return tools;
}

export const TOOL_NAMES = Object.freeze([
  "fcad_doctor", "fcad_validate", "fcad_build", "fcad_measure", "fcad_preview",
  "fcad_export", "fcad_import", "fcad_convert", "fcad_docs", "fcad_doc_get",
  "fcad_param", "fcad_doc_delete",
]);

export const DSL_OPS = Object.freeze([...OP_NAMES]);
export { summarize as renderSummary };

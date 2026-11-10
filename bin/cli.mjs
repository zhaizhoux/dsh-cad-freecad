#!/usr/bin/env node
/** Standalone CLI — works without DeepSeek Harness installed. */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CadEngine } from "../src/registry.js";
import { describeSchema } from "../src/schema.js";
import { renderSummary } from "../src/tooldefs.js";

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  "work-dir": { type: "string" },
  cmd: { type: "string" },
  name: { type: "string" },
  id: { type: "string" },
  revision: { type: "string" },
  preview: { type: "boolean" },
  view: { type: "string" },
  out: { type: "string" },
  format: { type: "string" },
  filename: { type: "string" },
  set: { type: "string" },
  confirm: { type: "boolean" },
  port: { type: "string" },
  token: { type: "string" },
  "no-browser": { type: "boolean" },
  dark: { type: "boolean" },
};

const HELP = `dsh-cad-freecad — declarative CAD modeling with a local FreeCAD kernel

Usage: dsh-cad-freecad <command> [options]

Commands:
  doctor                     Probe FreeCAD, show capabilities and config
  schema                     Print the declarative DSL reference
  validate <file.json>       Validate a document without building geometry
  build <file.json>          Build, verify and store a document revision
  measure <id>               Report exact geometry facts for a stored document
  preview <id>               Render a four-view SVG drawing
  export <id> --format F     Export STEP/IGES/STL/BREP/SVG/DXF/JSON
  import <file>              Inspect an external STEP/IGES/BREP file (read-only)
  convert <file> --format F  Convert an external file to another format
  docs                       List stored documents
  get <id>                   Read a stored document and its revision history
  param <id> --set JSON      Change parameters (creates revision N+1)
  delete <id> --confirm      Delete a document and all its revisions
  serve                      Start the local browser UI on 127.0.0.1

Options:
  --work-dir DIR             State directory (default ~/.dsh-cad-freecad)
  --cmd PATH                 Explicit freecadcmd executable
  --json                     Emit raw JSON instead of a human summary
  --out PATH                 Output file for preview/export/convert
  --format F                 Export/convert target format
  --view V                   front | top | right | iso | all
  --set JSON                 Parameter object, e.g. '{"width":120}'
  --port N --token T         Web UI port and one-time token
  --no-browser               Do not attempt to open a browser (default)
  -h, --help                 Show this help
  -v, --version              Show version

Environment: DSH_CAD_FREECAD_CMD overrides auto-detection of FreeCADCmd.
`;

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

function emit(result, flags, extra = "") {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderSummary(result));
    if (extra) console.log(extra);
  }
  // A failed validation is a domain result (ok:true, valid:false) but the CLI must
  // still exit non-zero so it can be used as a CI / pre-commit gate.
  if (result && (result.ok === false || result.valid === false)) process.exitCode = 1;
  return result;
}

async function readDocument(path) {
  const raw = await readFile(resolve(String(path)), "utf8");
  return raw;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    console.error(`error: ${error.message}\n`);
    console.error(HELP);
    process.exit(2);
    return;
  }
  const flags = parsed.values;
  const [command, ...positionals] = parsed.positionals;

  if (flags.version) {
    console.log(await readVersion());
    return;
  }
  if (flags.help || !command) {
    console.log(HELP);
    return;
  }
  if (command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "schema") {
    const info = describeSchema();
    console.log(flags.json ? JSON.stringify(info, null, 2) : [
      `schema: ${info.schema}`,
      `ops (${info.ops.length}): ${info.ops.join(", ")}`,
      `boolean modes: ${info.booleanModes.join(", ")}`,
      `import: ${info.importFormats.join(", ")}`,
      `export: ${info.exportFormats.join(", ")}`,
      `parameter reference: ${info.parameterReference}`,
      info.note,
    ].join("\n"));
    return;
  }

  if (command === "serve") {
    const { startServer } = await import("../server/serve.mjs");
    const engine = await new CadEngine({
      workDir: flags["work-dir"],
      freecadCmd: flags.cmd,
    }).init();
    const instance = await startServer({
      engine,
      port: Number(flags.port ?? 8770),
      token: flags.token,
      dark: flags.dark,
    });
    console.log(`dsh-cad-freecad UI: ${instance.url}`);
    console.log(`bound to 127.0.0.1, workDir: ${engine.config.workDir}`);
    console.log("Press Ctrl+C to stop.");
    return;
  }

  const engine = await new CadEngine({
    workDir: flags["work-dir"],
    freecadCmd: flags.cmd,
  }).init();
  const revision = flags.revision === undefined ? undefined : Number(flags.revision);
  const first = positionals[0];

  switch (command) {
    case "doctor":
      emit(await engine.doctor({ includeTraces: flags.verbose === true }), flags);
      break;

    case "validate": {
      if (!first) throw new Error("validate needs a document path");
      const result = await engine.validate(await readDocument(first), { includeDocument: flags.json });
      emit(result, flags);
      break;
    }

    case "build": {
      if (!first) throw new Error("build needs a document path");
      let document = await readDocument(first);
      if (flags.name) {
        const object = JSON.parse(document);
        object.name = flags.name;
        document = JSON.stringify(object);
      }
      const built = await engine.build(document, { id: flags.id });
      emit(built, flags);
      if (built.ok && (flags.preview || flags.out)) {
        const preview = await engine.preview(built.document.id, {
          view: flags.view,
          save: true,
          outputPath: flags.out,
          dark: flags.dark === true,
        });
        emit(preview, flags, flags.json ? "" : `\nsaved drawing: ${preview.artifact?.path ?? "(failed)"}`);
      }
      break;
    }

    case "measure":
      if (!first) throw new Error("measure needs a document id");
      emit(await engine.measure(first, { revision }), flags);
      break;

    case "preview": {
      if (!first) throw new Error("preview needs a document id");
      const inline = !flags.out && !flags.json;
      const result = await engine.preview(first, {
        view: flags.view,
        revision,
        save: !inline,
        outputPath: flags.out,
        dark: flags.dark === true,
      });
      if (inline && result.ok) {
        console.log(result.svg ?? "");
      } else {
        emit(result, flags);
      }
      break;
    }

    case "export": {
      if (!first) throw new Error("export needs a document id");
      if (!flags.format) throw new Error("export needs --format");
      emit(await engine.exportDocument(first, {
        format: flags.format,
        filename: flags.filename,
        revision,
        outputPath: flags.out,
        dark: flags.dark === true,
      }), flags);
      break;
    }

    case "import": {
      if (!first) throw new Error("import needs a file path");
      const result = await engine.importDocument(resolve(first), {
        format: flags.format,
        preview: Boolean(flags.out),
      });
      if (result.ok && flags.out && result.svg) {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(resolve(flags.out)), { recursive: true });
        await writeFile(resolve(flags.out), result.svg);
        delete result.svg;
      }
      emit(result, flags, flags.out ? `\nsaved drawing: ${flags.out}` : "");
      break;
    }

    case "convert": {
      if (!first) throw new Error("convert needs a file path");
      if (!flags.format) throw new Error("convert needs --format");
      emit(await engine.convert(resolve(first), {
        format: flags.format,
        filename: flags.filename,
        outputPath: flags.out,
      }), flags);
      break;
    }

    case "docs":
      emit(await engine.listDocuments(), flags);
      break;

    case "get":
      if (!first) throw new Error("get needs a document id");
      emit(await engine.getDocument(first, { revision }), flags);
      break;

    case "param": {
      if (!first) throw new Error("param needs a document id");
      if (!flags.set) throw new Error("param needs --set '{\"key\":value}'");
      emit(await engine.setParameters(first, flags.set), flags);
      break;
    }

    case "delete":
      if (!first) throw new Error("delete needs a document id");
      emit(await engine.removeDocument(first, { confirm: flags.confirm === true }), flags);
      break;

    default:
      console.error(`unknown command: ${command}\n`);
      console.error(HELP);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});

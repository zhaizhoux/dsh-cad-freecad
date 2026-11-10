/** FreeCADCmd process adapter. Never uses a shell; never executes document text as code. */
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CadError, parseResult, RESULT_PREFIX } from "./util.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNNER_SCRIPT = resolve(HERE, "..", "python", "freecad_runner.py");
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

function windowsCandidates() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return [
    join(local, "Programs", "FreeCAD 1.1", "bin", "freecadcmd.exe"),
    join("C:\\", "Program Files", "FreeCAD 1.1", "bin", "freecadcmd.exe"),
    join("C:\\", "Program Files", "FreeCAD 1.0", "bin", "freecadcmd.exe"),
    join("C:\\", "Program Files (x86)", "FreeCAD 1.1", "bin", "freecadcmd.exe"),
  ];
}

function unixCandidates() {
  if (platform() === "darwin") {
    return [
      "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd",
      "/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd",
      "/usr/local/bin/freecadcmd",
    ];
  }
  return [
    "/usr/bin/freecadcmd",
    "/usr/bin/FreeCADCmd",
    "/usr/local/bin/freecadcmd",
    "/opt/freecad/bin/freecadcmd",
    "/snap/bin/freecadcmd",
  ];
}

/** Build an ordered, de-duplicated list of executable candidates. */
export async function candidateCommands(explicit = "") {
  const list = [];
  const push = (value) => {
    if (value && !list.includes(value)) list.push(value);
  };
  push(String(explicit || "").trim());
  push(String(process.env.DSH_CAD_FREECAD_CMD || "").trim());

  if (platform() === "win32") {
    for (const base of [join(process.env.LOCALAPPDATA ?? "", "Programs"), join("C:\\", "Program Files")]) {
      try {
        for (const entry of await readdir(base, { withFileTypes: true })) {
          if (entry.isDirectory() && /^FreeCAD/i.test(entry.name)) {
            push(join(base, entry.name, "bin", "freecadcmd.exe"));
          }
        }
      } catch {
        // Absent directory; fall through to static candidates.
      }
    }
    windowsCandidates().forEach(push);
    push("freecadcmd.exe");
  } else {
    unixCandidates().forEach(push);
    push("freecadcmd");
    push("FreeCADCmd");
  }
  return list;
}

function spawnOnce(command, args, { timeoutMs = 8000, env = process.env } = {}) {
  return new Promise((done) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let proc;
    try {
      proc = spawn(command, args, { windowsHide: true, shell: false, env });
    } catch (error) {
      done({ ok: false, error: error.message });
      return;
    }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    const killTree = () => {
      try { proc.kill(); } catch { /* already gone */ }
      if (platform() === "win32" && proc.pid) {
        try {
          spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
        } catch { /* best effort */ }
      }
    };
    const timer = setTimeout(() => {
      killTree();
      finish({ ok: false, error: "timeout" });
    }, timeoutMs);
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk; });
    proc.stderr?.on("data", (chunk) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk; });
    proc.on("error", (error) => finish({ ok: false, error: error.message }));
    proc.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

/** Locate a working FreeCADCmd executable. */
export async function findFreeCAD(explicit = "") {
  const candidates = await candidateCommands(explicit);
  const traces = [];
  for (const command of candidates) {
    if (command.includes("/") || command.includes("\\")) {
      try {
        await access(command);
      } catch {
        traces.push({ command, reason: "absent" });
        continue;
      }
    }
    const probe = await spawnOnce(command, ["--version"], { timeoutMs: 8000 });
    if (probe.ok || /FreeCAD/i.test(`${probe.stdout}${probe.stderr}`)) {
      return { command, version: `${probe.stdout}${probe.stderr}`.trim().split(/\r?\n/)[0] ?? "", traces };
    }
    traces.push({ command, reason: probe.error ?? `exit ${probe.code}` });
  }
  return { command: null, version: "", traces };
}

/**
 * Run one job through freecadcmd. The job is passed as a JSON file via the
 * DSH_CAD_JOB environment variable; the runner emits one RESULT_PREFIX line.
 */
export async function runFreeCADJob(command, job, options = {}) {
  if (!command) throw new CadError("no_backend", "FreeCADCmd is not available");
  const timeoutMs = options.timeoutMs ?? 120000;
  const tempDir = await mkdtemp(join(tmpdir(), "dsh-cad-freecad-"));
  const jobPath = join(tempDir, "job.json");
  try {
    await writeFile(jobPath, JSON.stringify(job), "utf8");
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new CadError("job_write_failed", "cannot write the FreeCAD job file", { message: error.message });
  }

  const env = { ...process.env, DSH_CAD_JOB: jobPath, DSH_CAD_RESULT_PREFIX: RESULT_PREFIX };
  const result = await new Promise((resolvePromise) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let proc;
    try {
      proc = spawn(command, [RUNNER_SCRIPT], {
        cwd: tempDir,
        env,
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolvePromise({ ok: false, error: error.message });
      return;
    }
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise(payload);
    };
    const killTree = () => {
      try { proc.kill(); } catch { /* already gone */ }
      if (platform() === "win32" && proc.pid) {
        try {
          spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
        } catch { /* best effort */ }
      }
    };
    const timer = setTimeout(() => {
      killTree();
      finish({ ok: false, timedOut: true, stdout, stderr });
    }, timeoutMs);
    const onAbort = () => {
      killTree();
      finish({ ok: false, aborted: true, stdout, stderr });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk; });
    proc.stderr?.on("data", (chunk) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk; });
    proc.on("error", (error) => finish({ ok: false, error: error.message, stdout, stderr }));
    proc.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });

  await rm(tempDir, { recursive: true, force: true }).catch(() => {});

  if (result.aborted) throw new CadError("aborted", "operation was cancelled");
  if (result.timedOut) throw new CadError("timeout", `FreeCAD job exceeded ${timeoutMs} ms`);
  if (result.error) throw new CadError("runner_spawn_failed", "cannot start FreeCADCmd", { message: result.error });

  try {
    const parsed = parseResult(result.stdout);
    if (parsed && parsed.success === false) {
      throw new CadError(
        parsed.error?.code ?? "geometry_error",
        parsed.error?.message ?? "FreeCAD reported a failure",
        parsed.error?.details,
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof CadError) throw error;
    throw new CadError("runner_failed", "FreeCAD runner produced no readable result", {
      exitCode: result.code,
      stderr: result.stderr.slice(-800),
      stdout: result.stdout.slice(-800),
    });
  }
}

export async function probeBackend(command) {
  return runFreeCADJob(command, { op: "probe" }, { timeoutMs: 30000 });
}

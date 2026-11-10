/** Local browser UI. Bound to 127.0.0.1 only, one-time token, CSP, no external assets. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeSchema } from "../src/schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = resolve(ROOT, "web");
const EXAMPLES = resolve(ROOT, "examples");
const MAX_BODY_BYTES = 1024 * 1024;

const STATIC = Object.freeze({
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
});

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function parseCookies(header = "") {
  const result = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function secureCompare(candidate, expected) {
  const left = Buffer.from(String(candidate));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function reject(res, status, code, message) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: { code, message } }));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body exceeds 1 MiB");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("request body is not valid JSON");
    error.status = 400;
    throw error;
  }
}

/**
 * @returns {Promise<{url: string, token: string, port: number, server: object, close: () => Promise<void>}>}
 */
export async function startServer({ engine, port = 8770, token, dark = false } = {}) {
  if (!engine) throw new TypeError("startServer requires a CadEngine instance");
  const actualToken = token || randomBytes(18).toString("hex");
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const authorized = (req) => {
    const header = Array.isArray(req.headers["x-fcad-token"])
      ? req.headers["x-fcad-token"][0]
      : req.headers["x-fcad-token"];
    const cookie = parseCookies(req.headers.cookie).fcad_token;
    return secureCompare(header ?? cookie ?? "", actualToken);
  };

  const sendStatic = async (res, filename, type, method = "GET") => {
    const path = resolve(WEB, filename);
    if (!path.startsWith(WEB)) return reject(res, 403, "path_escape", "refusing to serve outside web/");
    try {
      const content = await readFile(path);
      res.writeHead(200, { "Content-Type": type, "Content-Length": content.length });
      res.end(method === "HEAD" ? undefined : content);
    } catch {
      reject(res, 404, "not_found", "asset not found");
    }
  };

  async function listExamples() {
    const examples = [];
    try {
      for (const entry of (await readdir(EXAMPLES)).sort()) {
        if (extname(entry).toLowerCase() !== ".json") continue;
        try {
          const document = JSON.parse(await readFile(resolve(EXAMPLES, entry), "utf8"));
          examples.push({ name: entry, title: document.name ?? entry, document });
        } catch { /* skip malformed examples */ }
      }
    } catch { /* examples directory is optional */ }
    return { ok: true, examples };
  }

  const GET_ROUTES = {
    "/api/health": () => ({
      ok: true, readonly: true, version: "1.0.0", platform: process.platform,
      workDir: basename(engine.config.workDir), dark,
    }),
    "/api/doctor": () => engine.doctor(),
    "/api/schema": () => ({ ok: true, ...describeSchema() }),
    "/api/examples": listExamples,
    "/api/docs": () => engine.listDocuments(),
    "/api/doc": (query) => engine.getDocument(query.get("id") ?? ""),
    "/api/measure": (query) => engine.measure(query.get("id") ?? ""),
  };

  const POST_ROUTES = {
    "/api/validate": (body) => engine.validate(body.document),
    "/api/build": (body) => engine.build(body.document, { name: body.name, id: body.id }),
    "/api/preview": (body) => engine.preview(body.id, {
      view: body.view, revision: body.revision, inline: true, save: false, dark: Boolean(body.dark),
    }),
    "/api/export": (body) => engine.exportDocument(body.id, {
      format: body.format, filename: body.filename, revision: body.revision, dark: Boolean(body.dark),
    }),
    "/api/param": (body) => engine.setParameters(body.id, body.parameters),
    "/api/delete": (body) => engine.removeDocument(body.id, { confirm: body.confirm }),
    "/api/import": (body) => engine.importDocument(body.path, { format: body.format }),
    "/api/convert": (body) => engine.convert(body.path, { format: body.format, filename: body.filename }),
  };

  const server = createServer(async (req, res) => {
    const reqMethod = req.method ?? "GET";
    setSecurityHeaders(res);
    try {
      const host = req.headers.host ?? "";
      if (!allowedHosts.has(host)) return reject(res, 403, "host_not_allowed", "unexpected Host header");
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return reject(res, 403, "origin_not_allowed", "unexpected Origin header");
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const path = url.pathname;

      if (path === "/") {
        if (url.searchParams.get("token") !== actualToken) {
          return reject(res, 401, "token_required", "open the URL printed by the CLI");
        }
        res.setHeader("Set-Cookie", `fcad_token=${actualToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
        return sendStatic(res, "index.html", "text/html; charset=utf-8", reqMethod);
      }

      if (!authorized(req)) return reject(res, 403, "token_required", "missing or invalid token");

      if (STATIC[path]) {
        if (reqMethod !== "GET" && reqMethod !== "HEAD") {
          res.setHeader("Allow", "GET, HEAD");
          return reject(res, 405, "method_not_allowed", "only GET and HEAD are supported");
        }
        return sendStatic(res, STATIC[path][0], STATIC[path][1], reqMethod);
      }

      if (path === "/api/artifact") {
        if (reqMethod !== "GET" && reqMethod !== "HEAD") {
          res.setHeader("Allow", "GET, HEAD");
          return reject(res, 405, "method_not_allowed", "only GET and HEAD are supported");
        }
        const name = url.searchParams.get("name") ?? "";
        let target;
        try {
          target = engine.store.artifactPath(name);
        } catch {
          return reject(res, 403, "path_escape", "invalid artifact name");
        }
        try {
          const content = await readFile(target);
          const type = extname(name).toLowerCase() === ".svg" ? "image/svg+xml" : "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": type,
            "Content-Length": content.length,
            "Content-Disposition": `attachment; filename="${name.replace(/["\r\n]/g, "")}"`,
          });
          res.end(reqMethod === "HEAD" ? undefined : content);
        } catch {
          reject(res, 404, "not_found", "artifact not found");
        }
        return;
      }

      if (reqMethod === "GET" && GET_ROUTES[path]) {
        const result = await GET_ROUTES[path](url.searchParams);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(result));
      }
      if (reqMethod === "POST" && POST_ROUTES[path]) {
        const body = await readBody(req);
        const result = await POST_ROUTES[path](body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(result));
      }
      if (GET_ROUTES[path] || POST_ROUTES[path]) {
        res.setHeader("Allow", GET_ROUTES[path] ? "GET" : "POST");
        return reject(res, 405, "method_not_allowed", "unexpected HTTP method");
      }
      return reject(res, 404, "not_found", `no route for ${path}`);
    } catch (error) {
      return reject(res, error.status ?? 500, "request_failed", error.message ?? "internal error");
    }
  });

  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", done);
  });

  const close = () => new Promise((done) => server.close(() => done()));
  return {
    url: `http://127.0.0.1:${port}/?token=${actualToken}`,
    token: actualToken,
    port,
    server,
    close,
  };
}

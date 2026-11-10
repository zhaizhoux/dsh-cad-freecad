import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { CadEngine } from "../src/registry.js";
import { startServer } from "../server/serve.mjs";
import { cleanup, fakeEngine, minimalDocument, tempDir } from "./fixtures.mjs";

const TOKEN = "test-token-123";
let root;
let instance;
let port;

function request(path, { method = "GET", headers = {}, body = null, host } = {}) {
  return new Promise((resolvePromise, reject) => {
    const options = {
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { ...headers },
    };
    if (host) options.headers.Host = host;
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolvePromise({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    if (body !== null) {
      req.setHeader("Content-Type", "application/json");
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

const auth = (extra = {}) => ({ "X-Fcad-Token": TOKEN, ...extra });
const json = (response) => JSON.parse(response.body.toString("utf8"));

before(async () => {
  root = await tempDir();
  const engine = await fakeEngine(CadEngine, root);
  port = 33000 + Math.floor(Math.random() * 2000);
  instance = await startServer({ engine, port, token: TOKEN });
});
after(async () => {
  await instance?.close();
  await cleanup(root);
});

describe("local browser UI server", () => {
  it("serves the entry page with a one-time token, CSP and HttpOnly cookie", async () => {
    const response = await request(`/?token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /text\/html/);
    assert.match(response.headers["content-security-policy"], /default-src 'self'/);
    assert.match(response.headers["set-cookie"]?.[0] ?? "", /HttpOnly/);
    assert.match(response.body.toString("utf8"), /FreeCAD/);
  });

  it("rejects a missing token, a forged Host and a foreign Origin", async () => {
    assert.equal((await request("/api/health")).status, 403);
    assert.equal((await request("/api/health", { headers: auth(), host: "evil.example" })).status, 403);
    assert.equal((await request("/api/health", { headers: auth({ Origin: "http://evil.example" }) })).status, 403);
  });

  it("authenticates via HttpOnly cookie for static assets", async () => {
    const response = await request("/app.js", { headers: { Cookie: `fcad_token=${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /javascript/);
    assert.match(response.body.toString("utf8"), /textContent/);
  });

  it("exposes health, doctor, schema, examples and docs", async () => {
    assert.equal(json(await request("/api/health", { headers: auth() })).readonly, true);
    assert.equal(json(await request("/api/doctor", { headers: auth() })).available, true);
    assert.equal(json(await request("/api/schema", { headers: auth() })).ops.length, 14);
    assert.ok(json(await request("/api/examples", { headers: auth() })).examples.length >= 5);
    assert.ok(Array.isArray(json(await request("/api/docs", { headers: auth() })).documents));
  });

  it("validates, builds, previews and exports through POST routes", async () => {
    const document = JSON.stringify(minimalDocument());
    const validated = json(await request("/api/validate", { method: "POST", headers: auth(), body: { document } }));
    assert.equal(validated.valid, true);
    const built = json(await request("/api/build", { method: "POST", headers: auth(), body: { document } }));
    assert.equal(built.ok, true);
    const id = built.document.id;
    const preview = json(await request("/api/preview", { method: "POST", headers: auth(), body: { id } }));
    assert.match(preview.svg, /^<svg/);
    const exported = json(await request("/api/export", { method: "POST", headers: auth(), body: { id, format: "step" } }));
    assert.equal(exported.ok, true);
    const name = exported.artifact.path.split(/[\\/]/).at(-1);
    const download = await request(`/api/artifact?name=${encodeURIComponent(name)}`, { headers: auth() });
    assert.equal(download.status, 200);
    assert.equal(download.body.length, exported.artifact.bytes);
    assert.match(download.headers["content-disposition"], /attachment/);
  });

  it("blocks traversal, wrong methods, unknown routes and oversized bodies", async () => {
    assert.equal((await request("/api/artifact?name=..%2Fevil", { headers: auth() })).status, 403);
    assert.equal((await request("/api/validate", { headers: auth() })).status, 405);
    assert.equal((await request("/api/nope", { headers: auth() })).status, 404);
    const huge = await request("/api/validate", {
      method: "POST",
      headers: auth(),
      body: { document: "x".repeat(1024 * 1024 + 10) },
    });
    assert.equal(huge.status, 413);
  });
});

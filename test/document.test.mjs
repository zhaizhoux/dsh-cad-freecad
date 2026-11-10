import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DocumentStore } from "../src/document.js";
import { cleanup, minimalDocument, tempDir } from "./fixtures.mjs";

let root;
let store;

before(async () => {
  root = await tempDir();
  store = new DocumentStore(root, { maxFeatures: 50, maxDocumentBytes: 64 * 1024 });
  await store.init();
});
after(async () => { await cleanup(root); });

describe("immutable document store", () => {
  it("creates revision 1", async () => {
    const saved = await store.put(minimalDocument(), { id: "part-a" });
    assert.equal(saved.id, "part-a");
    assert.equal(saved.revision, 1);
    assert.equal(saved.sha256.length, 64);
    assert.ok(saved.bytes > 0);
  });

  it("reads back the exact document", async () => {
    const record = await store.get("part-a");
    assert.equal(record.document.name, "test-part");
    assert.equal(record.revision, 1);
    assert.equal(record.document.features[0].height, "$h");
  });

  it("appends revision 2 instead of overwriting", async () => {
    const changed = minimalDocument({ parameters: { h: 20 } });
    const saved = await store.put(changed, { id: "part-a" });
    assert.equal(saved.revision, 2);
    const first = await store.get("part-a", 1);
    const second = await store.get("part-a");
    assert.equal(first.document.parameters.h, 10);
    assert.equal(second.document.parameters.h, 20);
    assert.notEqual(first.sha256, second.sha256);
  });

  it("parameter edits create a new revision with history intact", async () => {
    const saved = await store.setParameters("part-a", { h: 30 });
    assert.equal(saved.revision, 3);
    const list = await store.revisions("part-a");
    assert.equal(list.length, 3);
    assert.equal((await store.get("part-a", 1)).document.parameters.h, 10);
    assert.equal((await store.get("part-a")).document.parameters.h, 30);
  });

  it("lists documents sorted by update time", async () => {
    await store.put(minimalDocument({ name: "second" }), { id: "part-b" });
    const list = await store.list();
    assert.ok(list.length >= 2);
    assert.ok(list.every((item) => item.id && item.active >= 1));
  });

  it("rejects unsafe ids, traversal and bad artifact names", async () => {
    await assert.rejects(() => store.put(minimalDocument(), { id: "../escape" }), /invalid_id|path_escape/);
    await assert.rejects(() => store.get("../../etc"), /invalid_id/);
    assert.throws(() => store.artifactPath("../evil.step"), /invalid_filename|path_escape/);
    assert.throws(() => store.artifactPath("a/b.step"), /invalid_filename|path_escape/);
    assert.ok(store.artifactPath("part.step").endsWith("part.step"));
  });

  it("rejects invalid documents and oversized payloads", async () => {
    await assert.rejects(() => store.put({ features: [] }), /invalid_document/);
    const big = minimalDocument({ features: Array.from({ length: 60 }, (_, index) => ({
      op: "box", id: `b${index}`, length: 1, width: 1, height: 1,
    })) });
    big.result = "b59";
    await assert.rejects(() => store.put(big), /too_large|invalid_document/);
  });

  it("writes revision files atomically (no temp leftovers)", async () => {
    const meta = JSON.parse(await readFile(join(root, "documents", "part-a", "meta.json"), "utf8"));
    assert.equal(meta.active, 3);
    assert.equal(meta.revisions.length, 3);
    const rev = JSON.parse(await readFile(join(root, "documents", "part-a", "rev-00001.json"), "utf8"));
    assert.equal(rev.document.parameters.h, 10);
  });

  it("removes a document directory", async () => {
    await store.put(minimalDocument(), { id: "part-c" });
    assert.equal((await store.remove("part-c")).removed, true);
    await assert.rejects(() => store.get("part-c"), /not_found/);
  });
});

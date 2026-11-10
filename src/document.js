/** Immutable-revision document store. All writes are atomic and confined to workDir. */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { validateDocument } from "./schema.js";
import {
  assertSafeId, ensureWithin, isSafeId, nowIso, sha256Hex, CadError,
} from "./util.js";

function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base || "model";
}

function revisionFile(revision) {
  return `rev-${String(revision).padStart(5, "0")}.json`;
}

export class DocumentStore {
  constructor(workDir, options = {}) {
    this.workDir = resolve(workDir);
    this.maxFeatures = options.maxFeatures ?? 500;
    this.maxDocumentBytes = options.maxDocumentBytes ?? 1024 * 1024;
    this._queue = Promise.resolve();
  }

  _serialize(task) {
    const result = this._queue.then(task, task);
    this._queue = result.catch(() => {});
    return result;
  }

  documentsRoot() {
    return ensureWithin(this.workDir, "documents");
  }

  documentDir(id) {
    assertSafeId(id, "document id");
    return ensureWithin(this.workDir, "documents", id);
  }

  artifactsRoot() {
    return ensureWithin(this.workDir, "artifacts");
  }

  artifactPath(filename) {
    if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename)) {
      throw new CadError("invalid_filename", "artifact filename contains unsafe characters", { filename: String(filename) });
    }
    return ensureWithin(this.workDir, "artifacts", filename);
  }

  async init() {
    await mkdir(this.documentsRoot(), { recursive: true });
    await mkdir(this.artifactsRoot(), { recursive: true });
  }

  async _readMeta(id) {
    const path = ensureWithin(this.documentDir(id), "meta.json");
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new CadError("store_corrupt", `cannot read metadata for ${id}`, { message: error.message });
    }
  }

  async _atomicWrite(path, contents) {
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, contents, "utf8");
    try {
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Create a new document or append an immutable revision. */
  async put(document, options = {}) {
    return this._serialize(async () => {
      const checked = validateDocument(document, { maxFeatures: this.maxFeatures });
      if (!checked.ok) {
        throw new CadError("invalid_document", "document failed schema validation", { errors: checked.errors.slice(0, 20) });
      }
      const bytes = Buffer.from(JSON.stringify(checked.document), "utf8");
      if (bytes.length > this.maxDocumentBytes) {
        throw new CadError("too_large", "document exceeds the configured byte limit", {
          bytes: bytes.length,
          limit: this.maxDocumentBytes,
        });
      }

      const dir = options.id ? this.documentDir(options.id) : null;
      const id = options.id ?? `${slugify(checked.document.name)}-${sha256Hex(bytes).slice(0, 8)}`;
      assertSafeId(id, "document id");
      const targetDir = dir ?? this.documentDir(id);
      await mkdir(targetDir, { recursive: true });

      const meta = await this._readMeta(id);
      const revision = (meta?.active ?? 0) + 1;
      const sha256 = sha256Hex(bytes);
      const createdAt = nowIso();
      const record = {
        id,
        revision,
        name: checked.document.name,
        sha256,
        bytes: bytes.length,
        createdAt,
        source: options.source ?? "manual",
        document: checked.document,
      };

      await this._atomicWrite(
        ensureWithin(targetDir, revisionFile(revision)),
        JSON.stringify(record, null, 2),
      );

      const nextMeta = {
        id,
        name: checked.document.name,
        createdAt: meta?.createdAt ?? createdAt,
        updatedAt: createdAt,
        active: revision,
        revisions: [
          ...(meta?.revisions ?? []),
          { revision, sha256, createdAt, source: record.source },
        ],
      };
      await this._atomicWrite(
        ensureWithin(targetDir, "meta.json"),
        JSON.stringify(nextMeta, null, 2),
      );

      return {
        id,
        name: record.name,
        revision,
        sha256,
        bytes: record.bytes,
        createdAt,
        result: checked.document.result,
      };
    });
  }

  async get(id, revision) {
    assertSafeId(id, "document id");
    const meta = await this._readMeta(id);
    if (!meta) throw new CadError("not_found", `document ${id} does not exist`);
    const wanted = revision === undefined ? meta.active : Number(revision);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > meta.active) {
      throw new CadError("not_found", `revision ${revision} does not exist`, { active: meta.active });
    }
    const path = ensureWithin(this.documentDir(id), revisionFile(wanted));
    try {
      const record = JSON.parse(await readFile(path, "utf8"));
      return { ...record, meta };
    } catch (error) {
      throw new CadError("store_corrupt", `cannot read revision ${wanted} of ${id}`, { message: error.message });
    }
  }

  async list() {
    await this.init();
    const entries = await readdir(this.documentsRoot(), { withFileTypes: true });
    const documents = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      try {
        const meta = await this._readMeta(entry.name);
        if (meta) documents.push({
          id: meta.id,
          name: meta.name,
          active: meta.active,
          revisions: meta.revisions?.length ?? 0,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        });
      } catch {
        // A corrupt entry must not break the listing.
      }
    }
    return documents.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async revisions(id) {
    const record = await this.get(id);
    return record.meta.revisions ?? [];
  }

  /** Parameter edits never overwrite history: they append revision N+1. */
  async setParameters(id, parameters) {
    const record = await this.get(id);
    if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
      throw new CadError("invalid_parameters", "parameters must be an object");
    }
    const document = {
      ...record.document,
      parameters: { ...record.document.parameters, ...parameters },
    };
    return this.put(document, { id, source: "parameters" });
  }

  async remove(id) {
    return this._serialize(async () => {
      const dir = this.documentDir(id);
      // Guard against a symlink or unexpected location before deleting.
      const expected = resolve(this.workDir, "documents", id);
      if (dir !== expected && !dir.startsWith(expected + sep)) {
        throw new CadError("path_escape", "refusing to delete outside the document directory");
      }
      await rm(dir, { recursive: true, force: true });
      return { id, removed: true };
    });
  }
}

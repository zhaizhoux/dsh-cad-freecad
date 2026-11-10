"use strict";
/** Browser UI. All dynamic content is rendered with textContent / DOM APIs. */

const $ = (id) => document.getElementById(id);

let currentId = "";
let currentRevision = null;
let lastResult = null;
let examples = [];
let dark = false;

function status(message, kind = "") {
  const element = $("footer-status");
  element.textContent = message;
  element.className = kind;
}

async function api(path, options = {}) {
  const init = { credentials: "same-origin", ...options };
  init.headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(path, init);
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: { code: "bad_response", message: "服务端返回了非 JSON 内容" } };
  }
  if (!response.ok || payload.ok === false) {
    const error = payload.error || {};
    throw new Error(`[${error.code || response.status}] ${error.message || response.statusText}`);
  }
  return payload;
}

function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function basename(path) {
  const parts = String(path || "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function setTheme(value) {
  dark = Boolean(value);
  document.body.dataset.theme = dark ? "dark" : "light";
  $("theme-toggle").textContent = dark ? "浅色主题" : "深色主题";
}

function showTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  for (const key of ["preview", "report", "raw"]) {
    $("tab-" + key).classList.toggle("hidden", key !== name);
  }
}

function setCurrent(id, revision) {
  currentId = id || "";
  currentRevision = revision ?? null;
  $("current-id").value = currentId;
  $("revision-label").value = currentRevision === null ? "—" : `r${currentRevision}`;
  $("btn-export").disabled = !currentId;
  $("btn-param").disabled = !currentId;
}

function metric(key, value) {
  const box = element("div", "metric");
  box.append(element("div", "key", key), element("div", "value", value));
  return box;
}

function renderReport(report, ref) {
  const box = $("report-box");
  box.replaceChildren();
  if (!report) {
    box.append(element("p", "hint", "尚无几何报告。"));
    return;
  }
  const grid = element("div", "report-grid");
  grid.append(
    metric("有效性", report.valid ? "✓ VALID" : "✗ INVALID"),
    metric("体积", `${report.volume} mm³`),
    metric("表面积", `${report.area} mm²`),
    metric("实体 / 面 / 边", `${report.topology.solids} / ${report.topology.faces} / ${report.topology.edges}`),
    metric("包围盒", report.bbox.size.map((item) => Number(item).toFixed(2)).join(" × ") + " mm"),
    metric("质心", report.center_of_mass.map((item) => Number(item).toFixed(2)).join(", ")),
  );
  box.append(grid);

  if (ref) {
    const info = element("div", "section-title", `文档 ${ref.id} · 修订 r${ref.revision} · ${String(ref.sha256 || "").slice(0, 16)}…`);
    box.append(info);
  }

  box.append(element("div", "section-title", "几何检查"));
  const checks = element("ul", "check-list");
  for (const check of report.checks || []) {
    checks.append(element("li", check.ok ? "" : "fail", `${check.ok ? "✓" : "✗"} ${check.id} — ${check.detail}`));
  }
  box.append(checks);

  if (report.steps && report.steps.length) {
    box.append(element("div", "section-title", "建模步骤"));
    const steps = element("ul", "check-list");
    for (const step of report.steps) {
      steps.append(element("li", "", `${step.id} · ${step.op} · ${step.solids} solid(s) · V ${step.volume} mm³`));
    }
    box.append(steps);
  }
}

function renderRaw(value) {
  $("raw-box").textContent = JSON.stringify(value ?? {}, null, 2);
}

function renderPreviewSvg(svg) {
  const box = $("preview-box");
  if (!svg) {
    box.replaceChildren(element("p", "hint", "没有可显示的预览。"));
    return;
  }
  const image = document.createElement("img");
  image.alt = "模型四视图预览";
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  box.replaceChildren(image);
}

async function refreshBackend() {
  const badge = $("backend-status");
  try {
    const result = await api("/api/doctor");
    if (result.available) {
      badge.textContent = `FreeCAD ${result.backend.version || "?"} · 可用`;
      badge.className = "badge ok";
    } else {
      badge.textContent = "FreeCAD 不可用";
      badge.className = "badge bad";
    }
  } catch (error) {
    badge.textContent = "后端检测失败";
    badge.className = "badge bad";
    status(error.message, "error");
  }
}

async function loadExamples() {
  try {
    const result = await api("/api/examples");
    examples = result.examples || [];
    const select = $("example-select");
    select.replaceChildren();
    for (const example of examples) {
      const option = document.createElement("option");
      option.value = example.name;
      option.textContent = example.title;
      select.append(option);
    }
    if (examples.length && !$("document-input").value.trim()) {
      $("document-input").value = JSON.stringify(examples[0].document, null, 2);
    }
  } catch (error) {
    status(`示例载入失败: ${error.message}`, "error");
  }
}

async function loadDocs() {
  const list = $("doc-list");
  try {
    const result = await api("/api/docs");
    list.replaceChildren();
    const documents = result.documents || [];
    if (!documents.length) {
      list.append(element("li", "empty", "暂无已存文档"));
      return;
    }
    for (const document of documents) {
      const item = element("li", "");
      item.dataset.id = document.id;
      const label = element("strong", "", document.id);
      item.append(label, document.createTextNode(`  r${document.active} · ${document.revisions} rev · ${document.name}`));
      list.append(item);
    }
  } catch (error) {
    list.replaceChildren(element("li", "empty", `列表读取失败: ${error.message}`));
  }
}

async function showPreview(id, revision) {
  const preview = await post("/api/preview", { id, revision, view: "all", dark });
  renderPreviewSvg(preview.svg);
  if (preview.report) renderReport(preview.report, preview.document);
}

async function buildAndShow(documentText) {
  status("正在用 FreeCAD 构建…");
  const result = await post("/api/build", { document: documentText });
  lastResult = result;
  setCurrent(result.document.id, result.document.revision);
  renderReport(result.report, result.document);
  renderRaw(result);
  await showPreview(currentId, currentRevision);
  showTab("preview");
  await loadDocs();
  $("validate-result").textContent = `✓ 构建成功 · 体积 ${result.report.volume} mm³`;
  status(`构建完成 ${currentId} r${currentRevision}`, "ok");
  return result;
}

async function validateCurrent() {
  const result = await post("/api/validate", { document: $("document-input").value });
  if (result.valid) {
    $("validate-result").textContent = `✓ 文档有效 · ${result.features} 个特征 · 结果 ${result.result}`;
    status("校验通过", "ok");
  } else {
    const lines = (result.errors || []).slice(0, 6).map((item) => `${item.path}: ${item.message}`);
    $("validate-result").textContent = `✗ ${lines.join(" | ")}`;
    status("校验失败", "error");
  }
  return result;
}

async function applyParams() {
  if (!currentId) throw new Error("请先构建或选择一个文档");
  let parameters;
  try {
    parameters = JSON.parse($("param-input").value || "{}");
  } catch (error) {
    throw new Error(`参数 JSON 无效: ${error.message}`);
  }
  status("正在生成新修订…");
  const result = await post("/api/param", { id: currentId, parameters });
  setCurrent(result.document.id, result.document.revision);
  lastResult = result;
  renderReport(result.report, result.document);
  renderRaw(result);
  await showPreview(currentId, currentRevision);
  await loadDocs();
  status(`已生成修订 r${currentRevision} · 历史保持不变`, "ok");
}

async function exportCurrent() {
  if (!currentId) throw new Error("请先构建或选择一个文档");
  const format = $("export-format").value;
  status(`正在导出 ${format.toUpperCase()}…`);
  const result = await post("/api/export", { id: currentId, format, dark });
  const name = basename(result.artifact.path);
  $("export-status").textContent = `${name} · ${result.artifact.bytes} bytes · sha256 ${String(result.artifact.sha256).slice(0, 12)}…`;
  const link = document.createElement("a");
  link.href = "/api/artifact?name=" + encodeURIComponent(name);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  status(`已导出 ${name}`, "ok");
}

async function loadSelectedExample() {
  const name = $("example-select").value;
  const found = examples.find((item) => item.name === name);
  if (found) {
    $("document-input").value = JSON.stringify(found.document, null, 2);
    status(`已载入示例 ${found.title}`);
  }
}

function formatDocument() {
  try {
    $("document-input").value = JSON.stringify(JSON.parse($("document-input").value), null, 2);
    status("已格式化");
  } catch (error) {
    status(`JSON 无效: ${error.message}`, "error");
  }
}

async function openDocument(id) {
  status(`正在读取 ${id}…`);
  const result = await api("/api/doc?id=" + encodeURIComponent(id));
  $("document-input").value = JSON.stringify(result.document, null, 2);
  setCurrent(id, result.ref.revision);
  lastResult = result;
  renderRaw(result);
  const measured = await api("/api/measure?id=" + encodeURIComponent(id));
  renderReport(measured.report, result.ref);
  await showPreview(id, currentRevision);
  showTab("preview");
  status(`已打开 ${id} r${currentRevision}`, "ok");
}

function guard(task) {
  return async () => {
    try {
      await task();
    } catch (error) {
      status(error.message, "error");
      $("validate-result").textContent = error.message;
    }
  };
}

$("theme-toggle").addEventListener("click", () => {
  setTheme(!dark);
  if (currentId) guard(() => showPreview(currentId, currentRevision))();
});
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
}
$("btn-load-example").addEventListener("click", guard(loadSelectedExample));
$("btn-format").addEventListener("click", formatDocument);
$("btn-validate").addEventListener("click", guard(validateCurrent));
$("btn-build").addEventListener("click", guard(() => buildAndShow($("document-input").value)));
$("btn-param").addEventListener("click", guard(applyParams));
$("btn-export").addEventListener("click", guard(exportCurrent));
$("btn-refresh").addEventListener("click", guard(loadDocs));
$("doc-list").addEventListener("click", (event) => {
  const item = event.target.closest("li[data-id]");
  if (item) guard(() => openDocument(item.dataset.id))();
});

(async function init() {
  setCurrent("", null);
  try {
    const health = await api("/api/health");
    setTheme(health.dark === true);
    const schema = await api("/api/schema");
    $("footer-schema").textContent = `${schema.schema} · ${schema.ops.length} ops · ${schema.exportFormats.length} export formats`;
    await Promise.all([refreshBackend(), loadExamples(), loadDocs()]);
    status("就绪 · 已连接本机 FreeCAD", "ok");
  } catch (error) {
    status(`初始化失败: ${error.message}`, "error");
  }
})();

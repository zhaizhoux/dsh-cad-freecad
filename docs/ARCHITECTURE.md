# 架构

## 分层

```
┌──────────────────────────────────────────────────────────────────┐
│  DeepSeek Harness        │   独立 CLI       │   浏览器 Web UI      │
│  lib/index.js            │   bin/cli.mjs    │   web/ + server/     │
│  ctx.tools.register      │   parseArgs      │   127.0.0.1 + token  │
└───────────────┬──────────┴────────┬─────────┴──────────┬───────────┘
                │                   │                     │
                └───────────────────┴─────────────────────┘
                                    │
                    src/tooldefs.js（12 个工具定义 + render）
                                    │
                    src/registry.js（CadEngine，唯一入口）
                      │         │          │           │
        schema.js  document.js  runner.js  svg.js   config.js / util.js
        DSL 校验   不可变修订   进程适配   SVG/DXF   归一化 / 安全工具
                                    │
                    ┌───────────────┴────────────────┐
                    │  FreeCADCmd 子进程（独立进程）   │
                    │  python/freecad_runner.py       │
                    │  Part / OCCT 内核               │
                    └────────────────────────────────┘
```

三个入口共用同一个 `CadEngine`，不共享业务逻辑副本。工具定义里的 `execute` 只是把参数转发给引擎方法；`output.render` 负责把结构化结果压成模型可读的短文本。

## 一次 `build` 的完整数据流

1. **入口**：`fcad_build.execute` / `cli build` / `POST /api/build` 传入文档（字符串或对象）。
2. **校验**：`_checkDocument()` → `validateDocument()` 在 Node 侧检查结构、参数引用、DAG、字段白名单，返回归一化副本。JSON 解析失败 → `invalid_json`；校验失败 → `invalid_document`。
3. **进程**：`_run()` 解析出 `freecadcmd` 路径，调用 `runFreeCADJob(command, job, {timeoutMs, signal})`：
   - 在系统临时目录建一个 `mkdtemp` 目录，写 `job.json`；
   - 通过环境变量 `DSH_CAD_JOB` 传路径，`DSH_CAD_RESULT_PREFIX` 传结果前缀；
   - `spawn(command, [runner.py], { shell: false, windowsHide: true, cwd: tempDir })`；
   - stdout/stderr 各最多捕获 4 MiB，超时或 abort 时终止进程树（Windows 用 `taskkill /T /F`）；
   - 从 stdout **逆序**找到最后一行 `DSH_CAD_RESULT:{...}` 并 `JSON.parse`。
4. **建模**：`freecad_runner.py` 读取 job，按 `op` 分派：
   - `probe` → 返回版本、Python 版本、可用模块与能力；
   - `build` → 顺序执行 features，解析 `$parameter`，构造 OCCT 形状，生成 `geometry_report`，可选 `projection_views` 与 `export_shape`；
   - `import` → 只读导入 STEP/IGES/BREP，然后同样测量 / 导出。
   - 所有异常都被 `fail(code, message, details)` 捕获并输出同一格式的结果行。
5. **持久化**：只有 runner 成功返回后，`DocumentStore.put()` 才写入新修订。建模失败不会留下半成品文档。
6. **返回**：`successResult({ document, report, ... })`；失败统一为 `errorResult(code, message, details)`。

结果协议刻意设计成「一行带前缀的 JSON」，因为 FreeCADCmd 启动时会打印大量 banner / 警告，用 stdout 全文解析不可靠。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：`name` / `inject` / `Config` / `apply(ctx, config)`，可逆注册 |
| `lib/register.js` | 逐个 `ctx.tools.register(defineTool(def))`，收集 disposer |
| `src/tooldefs.js` | 12 个工具定义、参数 field-map、`output.schema`、`output.render`、摘要渲染 |
| `src/registry.js` | 高层 API、格式归一化、artifact 落盘、错误信封包装 |
| `src/schema.js` | DSL 校验、参数解析、schema 描述 |
| `src/document.js` | 不可变修订存储、原子写、路径白名单 |
| `src/runner.js` | FreeCAD 探测、子进程生命周期、结果行解析 |
| `src/svg.js` | 零依赖四视图 SVG / DXF 生成 |
| `src/config.js` | 配置归一化与硬限制 |
| `src/util.js` | 结果信封、`CadError`、路径约束、SHA-256 |
| `python/freecad_runner.py` | OCCT 建模 / 测量 / 导入 / 导出 |
| `server/serve.mjs` | 本地 HTTP 服务、token/Cookie/CSP、API 路由 |
| `web/` | 原生 HTML/CSS/JS 前端 |

## 进程隔离

每次建模都是一个新的 FreeCADCmd 进程，工作目录是临时目录，job 与结果通过文件和 stdout 传递。好处：

- 插件进程不加载 FreeCAD 的 Python 运行时，不存在 ABI / 版本冲突。
- 单个模型崩溃或超时不会污染后续请求。
- runner 崩溃时 Node 侧只会得到 `bad_runner_output`，不会抛未捕获异常。

代价是每次调用有 0.3–1 秒冷启动，因此 `measure` / `preview` / `export` 都会重建几何而不是缓存形状对象——用确定性换取简单性和隔离性。

## 两个 FreeCAD 集成坑

1. **`__name__` 不是 `__main__`**：FreeCADCmd 把脚本当模块加载（模块名如 `freecad_runner`）。`if __name__ == "__main__": main()` 会静默不执行。入口必须无条件调用 `main()`。
2. **`Part.Compound` 没有 `CenterOfMass`**：布尔或阵列结果可能是 Compound。`geometry_report()` 依次回退到 `shape.Solids[0].CenterOfMass`，再回退到包围盒中心。

## 文档存储布局

```
<workDir>/
├── documents/
│   └── <id>/
│       ├── meta.json        { active, revisions[], ... }
│       ├── rev-00001.json   { document, sha256, bytes, createdAt, ... }
│       ├── rev-00002.json
│       └── ...
└── artifacts/
    └── <filename>
```

- `put()` 与 `setParameters()` 都写**新文件**并更新 `meta.json`，从不覆盖 `rev-*`。
- `_atomicWrite()` 先写临时文件再 rename，避免半写状态。
- 所有路径经过 `ensureWithin(root, ...)`；id 经 `assertSafeId()`；artifact 文件名经白名单正则。
- `get(id, revision)` 按修订号读取；`getDocument(id, { revision })` 及数字简写都支持。
- `remove()` 会复核目标目录仍在 `documents/` 之下才删除。

## 导出路径

- 原生格式（STEP / IGES / STL / BREP）：runner 直接在子进程里写到目标路径，Node 侧只保留 `{path, format, bytes, sha256}` 引用。
- 矢量格式（SVG / DXF）：runner 返回投影视图点集，Node 侧用 `src/svg.js` 生成文本再落盘。
- JSON：把文档、文档引用和几何报告序列化。
- `import` / `convert` 对源文件只调用 `stat` 和 FreeCAD 的导入器，不做任何写操作。

## 测试注入点

`CadEngine` 构造函数接受 `{ runner, probe, command }` 三个可选 seam：

```js
const engine = new CadEngine({ workDir }, {
  command: "fake-freecadcmd",
  probe: async () => ({ version: [1, 1, 4], modules: { Part: true }, capabilities: {} }),
  runner: async (cmd, job) => ({ report: sampleReport(), views: sampleViews() }),
});
```

因此 93 项单元测试完全不需要安装 FreeCAD；真机测试由环境变量 `DSH_CAD_FREECAD_CMD` 单独 gate。

## 安全模型

见 [SECURITY.md](SECURITY.md)。关键决策见 [ADR-0001](ADR-0001-declarative-dsl.md) 与 [ADR-0002](ADR-0002-immutable-revisions.md)。

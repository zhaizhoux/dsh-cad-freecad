# dsh-cad-freecad

**DeepSeek Harness 插件：把本机 FreeCAD 变成安全、声明式的 CAD 建模后端。**

模型用一段纯 JSON 描述，交给本机 FreeCAD 1.0+ 的 OCCT 内核建模；插件返回**精确的几何事实**（体积、面积、包围盒、质心、拓扑、有效性校验），并按需导出 STEP / IGES / STL / BREP / SVG / DXF / JSON。

它不是一个「让大模型写 Python 脚本」的封装。文档里没有表达式求值器，也不执行任何用户代码——这是刻意的边界，见 [docs/ADR-0001-declarative-dsl.md](docs/ADR-0001-declarative-dsl.md)。

三种用法互不依赖：

| 用法 | 入口 | 是否需要 DSH | 是否需要 FreeCAD |
| --- | --- | --- | --- |
| Harness 插件（12 个 `fcad_*` 工具） | `lib/index.js` | 是 | 是（建模时） |
| 独立 CLI | `bin/cli.mjs` | 否 | 是（建模时） |
| 本地浏览器 UI | `bin/cli.mjs serve` | 否 | 是（建模时） |

---

## 为什么这样设计

- **零第三方依赖**：核心引擎只用 Node 标准库；`@deepseek-ai/dsh-tools` 是可选的 peer dependency，缺失时自动降级为独立模式。不需要 `npm install` 才能跑 CLI 和测试。
- **声明式、可复现**：同一份文档 + 同一组参数永远得到同一个模型；每次保存生成不可变修订，历史不会被覆盖。
- **精确而非近似**：几何报告来自 OCCT 内核，不是估算；导出的是真正的 B-rep 文件，不是截图或点云。
- **只读外部文件**：`import` / `convert` 只读取源 STEP/IGES/BREP，从不修改它。
- **本地闭环**：Web UI 只绑 `127.0.0.1`，一次性 token + HttpOnly Cookie + CSP，无外部资源、无遥测。

---

## 前置条件

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22.5.0 | 使用 `node:test`、`parseArgs`、ESM top-level await |
| FreeCAD | 1.0+（已在 1.1.4 验证） | 只需要 `freecadcmd`（Windows 为 `freecadcmd.exe`） |
| DeepSeek Harness | 可选 | 仅插件模式需要 |

自动探测顺序：`DSH_CAD_FREECAD_CMD` 环境变量 → 配置里的 `freecadCmd` → 常见安装路径 → `PATH`。可用 `doctor` 查看探测结果：

```bash
node bin/cli.mjs doctor
# 指定内核
DSH_CAD_FREECAD_CMD="C:/Program Files/FreeCAD 1.1/bin/freecadcmd.exe" node bin/cli.mjs doctor --json
```

在 Windows 上，FreeCADCmd 执行脚本时 `__name__` 是模块名而不是 `__main__`，因此 `python/freecad_runner.py` 的入口是**无条件调用** `main()`；加 `if __name__ == "__main__"` 会导致进程静默退出、没有任何输出。

---

## 安装为 DeepSeek Harness 插件

**请使用一个独立 profile**，不要改动日常的 `desktop` / `web` profile：

```bash
dsh profile create cad-dev
dsh plugin --profile cad-dev add dsh-cad-freecad
dsh --profile cad-dev --dump-config      # 确认 dsh-cad-freecad 这一行被 compose 进来
```

插件契约（已对照 GitHub 上的 Harness 插件规范与本机已装插件核对）：

- `lib/index.js` 导出 `name` / `inject` / `apply(ctx, config)`，通过 `ctx.tools.register(defineTool(...))` 注册工具，用 `ctx.effect` 做可逆清理。
- `package.json` 声明 `dsh.plugin: true`、`dsh.kind: "server"`、`dsh.bundle.patch: "./cordis.patch.yml"`。
- `cordis.patch.yml` 是顶层 YAML 数组，用 `- insert:` 插入配置行；`config` 原样传给 `apply()`。
- 每个工具都带 object-rooted `parameters`、`output.schema` 和返回 text content 的 `output.render`。

工具名统一用 `fcad_` 前缀，避免与本机已安装的 `dsh-cad-design` 的 `cad_*` 工具冲突。

### 12 个工具

| 工具 | 作用 |
| --- | --- |
| `fcad_doctor` | 探测内核版本、能力矩阵、当前配置和 DSL 说明 |
| `fcad_validate` | 只做 DSL 校验，不建模、不写盘 |
| `fcad_build` | 建模 + 精确几何报告 + 保存不可变修订 |
| `fcad_measure` | 重算已存文档的几何事实（不产生新修订） |
| `fcad_preview` | 生成四视图 SVG（可内联返回或存为 artifact） |
| `fcad_export` | 导出 7 种格式，返回 artifact 引用而非字节 |
| `fcad_import` | 只读检查外部 STEP/IGES/BREP 文件 |
| `fcad_convert` | 外部文件转格式，源文件保持不变 |
| `fcad_docs` | 列出已存文档 |
| `fcad_doc_get` | 读取文档与完整修订历史（支持 `revision`） |
| `fcad_param` | 改参数，生成修订 N+1 并重新测量 |
| `fcad_doc_delete` | 删除文档（必须显式 `confirm: true`） |

所有结果都是统一信封：成功 `{ ok: true, ... }`，失败 `{ ok: false, error: { code, message, details } }`。`render` 把结构化结果压成模型可读的短摘要，而不是把整个几何报告塞回上下文。

---

## 独立 CLI

```bash
node bin/cli.mjs --help
node bin/cli.mjs schema                                  # 打印 DSL 参考
node bin/cli.mjs validate examples/washer.json           # 不建模，非法文档退出码为 1
node bin/cli.mjs build examples/washer.json --id washer --preview --out drawing.svg
node bin/cli.mjs measure washer --json
node bin/cli.mjs param washer --set '{"outer":40}'       # 生成修订 2
node bin/cli.mjs get washer --revision 1                 # 读回修订 1
node bin/cli.mjs export washer --format step --out washer.step
node bin/cli.mjs import washer.step --json               # 只读检查
node bin/cli.mjs convert washer.step --format svg --out washer.svg
node bin/cli.mjs docs
node bin/cli.mjs delete washer --confirm
```

常用参数：`--work-dir DIR`（状态目录，默认 `~/.dsh-cad-freecad`）、`--cmd PATH`、`--json`、`--out PATH`、`--format`、`--view front|top|right|iso|all`、`--revision N`、`--dark`。

`validate` 对非法文档返回非零退出码，可直接用于 CI / pre-commit。

---

## 本地浏览器 UI

```bash
node bin/cli.mjs serve --port 8770
```

启动后控制台会打印一个带一次性 token 的 `http://127.0.0.1:8770/?token=...` 地址。界面提供 JSON 编辑器、5 个示例、参数修改、文档列表、四视图预览、几何报告、原始结果和导出栏。

安全边界：仅监听 `127.0.0.1`；一次性 token 换 HttpOnly / SameSite=Strict Cookie；校验 Host 与 Origin；CSP `default-src 'self'`；请求体上限 1 MiB；artifact 文件名白名单；前端只用 `textContent` / DOM API 渲染。

---

## 声明式 DSL

```json
{
  "schema": "dsh.cad.freecad/document@1",
  "name": "参数化垫圈",
  "units": "mm",
  "parameters": { "outer": 30, "inner": 14, "t": 4 },
  "features": [
    { "op": "cylinder", "id": "outer", "radius": "$outer", "height": "$t" },
    { "op": "cylinder", "id": "bore",  "radius": "$inner", "height": "$t" },
    { "op": "boolean",  "id": "washer", "mode": "cut", "parts": ["outer", "bore"] }
  ],
  "result": "washer"
}
```

- 数值字段接受有限数字或 `$parameter` 引用；**没有表达式求值**（不能写 `"$outer / 2"`）。
- 形状引用只能指向**更早**的 feature id，不能自引用或前向引用。
- `result` 必须指向一个已存在的 feature id。
- 默认 `units: "mm"`、`result` 为最后一个 feature。

### 14 个操作

| op | 必填 | 可选 |
| --- | --- | --- |
| `box` | `length, width, height` | `at` |
| `cylinder` | `radius, height` | `at, axis` |
| `sphere` | `radius` | `at` |
| `cone` | `radius1, radius2, height` | `at, axis` |
| `torus` | `radius1, radius2` | `at, axis` |
| `polygon_extrude` | `points[3..512], height` | `at, axis` |
| `revolve` | `points[3..512], angle` | `at, axis` |
| `boolean` | `mode(union\|cut\|common), parts[≥2]` | — |
| `hole` | `on, diameter, at` | `axis, depth` |
| `hole_pattern` | `on, diameter`, 加 `positions` 或 `grid` | `axis, depth` |
| `fillet` | `on, radius` | `edge_ids` |
| `chamfer` | `on, size` | `edge_ids` |
| `shell` | `on, thickness` | `faces` |
| `transform` | `on` + 至少一个变换 | `translate, rotate, mirror, scale` |

完整约束见 [docs/DSL.md](docs/DSL.md)，或运行 `node bin/cli.mjs schema`。

`examples/` 下 5 个可直接使用的示例：`washer.json`（参数化垫圈）、`flange.json`（阵列孔法兰）、`hex-nut.json`（六角拉伸 + 中心孔）、`l-bracket.json`（布尔并集 + 双向孔）、`step-block.json`（布尔切除）。

---

## 导出格式与几何报告

| 格式 | 来源 | 说明 |
| --- | --- | --- |
| `step` / `iges` / `stl` / `brep` | OCCT 内核 | 真实实体/网格文件 |
| `svg` | 零依赖生成器 | 四视图工程图（亮/暗主题） |
| `dxf` | 零依赖生成器 | 投影轮廓线 |
| `json` | 引擎 | 文档 + 文档引用 + 完整几何报告 |

导入只支持 `step` / `iges` / `brep`（STL 是网格，不作为 B-rep 导入源）。

几何报告包含：`valid`、`volume`、`area`、`bbox`（min/max/size）、`center_of_mass`、`topology`（solids/faces/edges/vertices）、`checks`、以及建模步骤轨迹。`Part.Compound` 没有 `CenterOfMass` 属性，runner 会依次回退到首个 Solid 的质心、再回退到包围盒中心。

---

## 配置与硬限制

`cordis.patch.yml` 中的 `config` 原样传入 `apply()`。所有数值都会被归一化并夹到硬上限，恶意或写错的 patch 无法放大资源消耗：

| 项 | 默认 | 硬上限 |
| --- | --- | --- |
| `timeoutSeconds` | 120 | 600 |
| `maxFeatures` | 200 | 500 |
| `maxDocumentBytes` | 1 MiB | 4 MiB |
| `maxBoundingBoxMm` | 2000 | 100000 |
| `maxArtifactBytes` | 128 MiB | 256 MiB |
| `maxPreviewPoints` | 20000 | 100000 |

另有 `allowExport`、`allowModelWrite`、`enableSkill` 三个开关。`workDir` 为空时解析为 `~/.dsh-cad-freecad`，相对路径按 `homedir()` 解析，绝对路径原样使用。

### 不可变修订

每次 `put()` 或参数修改都写入新的 `rev-0000N.json` 并更新 `meta.json`，从不覆盖历史。所有路径都经过 `ensureWithin()` 校验，拒绝 `../` 穿越与绝对路径逃逸；文档 id 与 artifact 文件名使用白名单正则。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 测试

```bash
npm test          # 93 项，无需安装依赖、无需 FreeCAD
npm run check     # 入口语法检查

# 真机端到端（需要本机 FreeCADCmd）
DSH_CAD_FREECAD_CMD="/path/to/freecadcmd" node --test test/freecad.test.mjs
```

测试分层：

- 单元测试用注入的模拟 runner / probe，因此无 FreeCAD 的 CI 也能跑完整套。
- `test/safety.test.mjs` 静态检查源码里不存在 `eval`、`new Function`、`execSync`、`spawnSync`、`shell: true`、`innerHTML`、`os.system`、`subprocess`，并确认服务只绑 `127.0.0.1`、工具前缀为 `fcad_`、patch 配置与默认值一致。
- 真机测试仅在设置 `DSH_CAD_FREECAD_CMD` 时启用：5 个示例建模、7 种导出、STEP 往返体积比对、参数修订、非法几何输入。

已在 Windows + FreeCAD 1.1.4 上验证：单元测试 93/93、真机测试 6/6。

---

## 目录结构

```
lib/           DSH 插件入口、工具注册、类型声明
src/           核心引擎：DSL 校验、文档存储、进程适配、SVG/DXF、工具定义
python/        FreeCADCmd 侧建模 / 测量 / 导出脚本
bin/cli.mjs    独立 CLI
server/        本地 Web UI 后端
web/           原生 HTML/CSS/JS 前端
examples/      5 个示例文档
test/          单元、契约、安全、CLI、Web、真机测试
docs/          架构、DSL 参考、安全模型、ADR
```

---

## 已知边界

- 不执行用户代码、不支持表达式求值 —— 这是安全设计，不是缺失功能。
- `import`/`convert` 需要本机 FreeCAD；Web UI 的 `import` 路径必须是本机绝对路径。
- 插件会把 artifact 写到 `workDir/artifacts`，删除文档需要显式确认。
- FreeCADCmd 每次建模都是独立进程，冷启动约 0.3–1 秒，不适合毫秒级循环调用。

## License

MIT © 2026 zhaizhoux

# 安全模型

## 信任边界

| 区域 | 信任级别 | 说明 |
| --- | --- | --- |
| 插件配置（`cordis.patch.yml` / `apply(ctx, config)`） | 可信 | 由本机用户/管理员写入 |
| 文档 JSON（工具参数、CLI 文件、Web 编辑器） | **不可信** | 可能来自模型输出或第三方文件 |
| 外部 STEP/IGES/BREP 文件 | **不可信** | 只读取，不执行 |
| 本地网络请求 | **不可信** | 即使是 `127.0.0.1`，也可能来自恶意页面或本机其他进程 |
| FreeCADCmd 子进程输出 | 半可信 | 只解析带前缀的结构化行 |

核心假设：**文档是数据，不是代码**。整个设计围绕「不可信输入永远不会被求值」展开。

## 输入面控制

### 文档与 DSL

- 校验发生在建模之前，`validateDocument()` 检查根类型、schema id、units、参数名与值、feature 数量、字段白名单、id 唯一性、形状引用 DAG、`result` 有效性。
- 数值只允许有限数字或 `$parameter` 引用；**没有表达式求值器**，不调用 `eval`、`new Function`、Python `eval`。
- 参数名、文档 id、`$ref` 名称都用严格正则；`points` / `positions` / `edge_ids` / `faces` 有数量上限；数值绝对值上限 `1e9`。
- 归一化副本是浅拷贝的新对象，输入对象不被修改，也不会把额外字段带进 runner。

### 路径与文件

- `ensureWithin(root, ...parts)` 解析后必须仍在 root 之下；拒绝 `../` 穿越与绝对路径逃逸。
- 文档 id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`。
- artifact 文件名走白名单，不接受 `/`、`\`、`.` 开头的逃逸形式。
- 删除文档前复核目标目录确实位于 `documents/` 下。
- `import` / `convert` 只读源文件；导出只写 `workDir/artifacts` 或用户显式给出的绝对路径。
- 所有路径操作都在 Node 侧完成再传给 FreeCAD，runner 不自行拼接用户提供的路径。

### 进程

- `spawn` 使用 `shell: false`，runner 脚本路径是包内固定路径，不拼 shell 命令。
- job 通过临时目录里的 `job.json` + `DSH_CAD_JOB` 环境变量传递，不塞进命令行参数。
- stdout/stderr 捕获上限各 4 MiB，防止日志炸弹。
- 有 `timeoutSeconds` 超时；abort / 超时会终止进程树（Windows 用 `taskkill /T /F`）。
- runner 输出只认逆序最后一行 `DSH_CAD_RESULT:` JSON；banner、警告、堆栈都不会被当作结果。

### 资源上限

配置归一化会把所有数值夹到硬上限，即使 patch 写了 `999999999` 也不会生效：超时 600s、features 500、文档 4 MiB、包围盒 100000 mm、artifact 256 MiB、预览点 100000。runner 侧还有包围盒、导出体积、投影点数的复核。

### Web UI

- 只 `listen(port, "127.0.0.1")`，不监听 `0.0.0.0`。
- 启动时生成一次性 token；首页 URL 带 token，换取 `HttpOnly` + `SameSite=Strict` Cookie，token 用常量时间比较。
- 校验 `Host` 与 `Origin`，拒绝伪造 Host / 跨站 Origin（防 DNS rebinding 与 CSRF）。
- CSP `default-src 'self'`；`script-src`/`style-src`/`connect-src`/`font-src` 全部 `'self'`，`object-src 'none'`，`base-uri 'none'`，`frame-ancestors 'none'`。无 CDN、无外部资源。
- 附加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。
- 请求体上限 1 MiB，超限返回 413；API 方法不匹配返回 405 并带 `Allow`。
- artifact 下载按文件名白名单从 `workDir/artifacts` 读取，不接受任意路径。
- 前端全部使用 `textContent` 与 DOM API 渲染，不用 `innerHTML` / 字符串拼 HTML。

## 静态检查

`test/safety.test.mjs` 会在每次 `npm test` 时扫描源码，禁止出现：

```
eval(                new Function(        execSync          spawnSync
shell: true          innerHTML           os.system         subprocess
```

并断言服务绑定 `127.0.0.1`、工具前缀为 `fcad_`、patch 配置与默认值一致、runner 不写源文件。

## 不做的事 / 已知风险

- **不提供多用户隔离**：Web UI 面向单用户本机使用，(token, Cookie) 是访问控制而非身份系统。
- **不沙箱化 FreeCAD 进程**：runner 与插件进程同权限运行。它能读写用户有权访问的文件；防护来自「不把用户可控路径传给它」和「只读外部文件」，而不是 OS 级沙箱。
- **不校验 CAD 语义正确性**：DSL 合法不代表模型可制造；几何有效性由 OCCT 的 `isValid()` 报告，需要调用方判断。
- **不防侧信道 / 不防本机恶意进程**：本机其他进程可以读取 `workDir`。
- **导出文件不包含加密或签名**：`sha256` 用于完整性核对，不是防伪。

## 报告问题

发现绕过方式请直接在 GitHub 提 issue，附最小复现文档与期望行为；不要在公开 issue 里粘贴本机绝对路径或敏感文件内容。

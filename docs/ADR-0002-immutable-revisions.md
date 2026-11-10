# ADR-0002：文档采用不可变修订，不覆盖历史

- 状态：已接受
- 日期：2026-11-09
- 影响范围：`src/document.js`、`CadEngine.setParameters()` / `getDocument()` / `revisions()`

## 背景

参数化建模的典型操作是「把孔径从 6 改成 8」。如果原地覆盖文档，调用方就无法回答：改之前的体积是多少？上一版导出的是哪个 STEP？模型在多轮对话中改坏了参数怎么回滚？

对 Agent 场景而言这更严重：模型只看到当前上下文，一旦覆盖，历史几何事实就永久丢失，无法验证「这个改动是否真的让体积变大」。

## 备选方案

| 方案 | 问题 |
| --- | --- |
| 原地覆盖单文件 | 无历史、无回滚、无法比对 |
| 全量快照 + 软删除标记 | 需要额外索引，读路径复杂 |
| 只记录参数 diff | 重建几何依赖内核版本，无法精确复现 |
| 追加不可变修订文件 | 需要额外磁盘，但实现最简单、语义最清晰 |

## 决策

每个文档一个目录，每次 `put()` 或参数修改写入新的 `rev-0000N.json`，`meta.json` 只记录 `active` 与修订列表。

```
<workDir>/documents/<id>/
├── meta.json
├── rev-00001.json   { document, sha256, bytes, createdAt, ... }
└── rev-00002.json
```

- `rev-*` 文件**从不修改**；`setParameters()` 生成修订 N+1 并重新测量。
- 写操作用 `_atomicWrite()`（临时文件 + rename），并用一个串行队列 `_serialize()` 包住，避免并发请求写坏 `meta.json`。
- 每条修订保存文档的 SHA-256 与字节数，可直接比对两版是否相同。
- `get(id, revision)` 按修订号读取；`revisions(id)` 返回完整历史。
- 只有 runner 成功返回后才写盘，建模失败不产生半成品修订。
- 删除是显式的、需要 `confirm: true`，且会复核路径仍在 `documents/` 内。

## 后果

**正面**

- 可精确回答「r1 的参数是什么 / 体积是多少」，真机测试里直接断言 `r1.outer === 30` 而 `active.outer === 40`。
- 参数修改可以立即对比新旧体积（`setParameters()` 默认带 `measure`）。
- 磁盘上的文件本身就是审计日志，不需要数据库。
- 便于未来做 diff / 回滚 / 导出归档。

**负面 / 代价**

- 频繁修改会累积文件；`maxDocumentBytes`（默认 1 MiB，硬上限 4 MiB）限制单份文档大小，但修订总数没有自动清理策略。
- `remove()` 会删除整个文档目录（含全部修订），这是唯一会丢历史的操作，因此要求显式确认。
- `measure` / `preview` / `export` 都从修订文件重建几何，不缓存形状对象；换来的是无状态、可复现。

## 相关

- 路径与 id 白名单见 [SECURITY.md](SECURITY.md)。
- 存储布局与 `_atomicWrite()` 细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。

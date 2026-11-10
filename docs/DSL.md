# DSL 参考：`dsh.cad.freecad/document@1`

文档是**纯 JSON 数据**。校验器在 Node 侧运行，通过后才把归一化副本交给 FreeCAD 进程；不会执行任何来自文档的 Python / JavaScript / 表达式。

## 顶层结构

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `schema` | string | 否 | 只能省略或等于 `dsh.cad.freecad/document@1`；其他值报错 |
| `name` | string | 否 | 缺省 `untitled`，去首尾空白，截断到 120 字符 |
| `units` | string | 否 | 只支持 `"mm"`（缺省 `mm`） |
| `parameters` | object | 否 | 键为 `[A-Za-z_][A-Za-z0-9_]{0,63}`，值必须是有限数字 |
| `features` | array | 是 | 非空，最多 `maxFeatures`（默认 200，硬上限 500） |
| `result` | string | 否 | 必须是已存在的 feature id；缺省取最后一个 feature |

校验通过后会返回一份**归一化副本**：补齐 schema / name / units / parameters / result，feature 逐个浅拷贝。原始输入对象不会被修改。

## 参数引用

任何数值字段都可以写成有限数字，或 `"$name"` 形式的参数引用：

```json
"parameters": { "outer": 30, "t": 4 },
"features": [{ "op": "cylinder", "id": "c", "radius": "$outer", "height": "$t" }]
```

规则：

- 参数名必须存在且值为有限数字，否则校验失败。
- **没有表达式求值**：`"$outer / 2"`、`"$outer+1"` 都是非法字符串。需要派生值时请显式增加一个参数。
- 引用可以出现在向量和点数组内部，例如 `"at": ["$x", 0, 0]`。
- `resolveValue()` 只用于文档展示 / UI 预览，FreeCAD runner 自己也做一次解析。
- 数值绝对值不得超过 `1e9`。

## 通用字段规则

| 类别 | 字段 | 规则 |
| --- | --- | --- |
| 形状 id | `id` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`，全局唯一，1–64 字符 |
| 轴 | `axis` | `x` / `y` / `z`（缺省由 runner 决定，通常为 `z`） |
| 向量 | `at`, `translate`, `mirror` | 恰好 3 个数值 |
| 点列 | `points` | 3..512 个 `[x, y]` 二维点 |
| 位置列 | `positions` | 1..256 个 `[x, y, z]` 三维点 |
| 旋转 | `rotate` | 4 个数值：`[axis_x, axis_y, axis_z, angle_degrees]` |
| 索引列 | `edge_ids`, `faces` | 最多 256 个非负整数 |
| 网格 | `grid` | 必含 `origin`(3 维向量)、`step_x`、`step_y`、`count_x`、`count_y`；count 必须为正 |

需要「大于零」的数值字段：`length`、`width`、`height`、`radius`、`radius1`、`diameter`、`depth`、`thickness`、`size`、`scale`、`count_x`、`count_y`。`radius2` 允许为 0（用于圆锥尖端）。`angle` 与向量分量只要求有限数字。

每个 feature 只能出现该 op 允许的字段，多余字段会报 `unknown field for this op`。

## 形状引用（严格 DAG）

`on`、`parts` 等引用字段只能指向**更早出现**的 feature id：

- 不能引用自己，不能前向引用。
- `parts` 至少需要 2 个 id。
- `result` 也必须是已出现的 id。

这让建模过程天然是一个有向无环的线性序列，runner 可以顺序构建，不需要图解析或循环检测。

## 14 个操作

### 基本体

| op | 必填 | 可选 | 说明 |
| --- | --- | --- | --- |
| `box` | `length, width, height` | `at` | 长方体 |
| `cylinder` | `radius, height` | `at, axis` | 圆柱 |
| `sphere` | `radius` | `at` | 球 |
| `cone` | `radius1, radius2, height` | `at, axis` | 圆锥 / 圆台（`radius2: 0` 为尖锥） |
| `torus` | `radius1, radius2` | `at, axis` | 圆环 |
| `polygon_extrude` | `points, height` | `at, axis` | 闭合多边形沿轴拉伸 |
| `revolve` | `points, angle` | `at, axis` | 轮廓绕轴旋转 `angle` 度 |

### 组合与特征

| op | 必填 | 可选 | 说明 |
| --- | --- | --- | --- |
| `boolean` | `mode, parts` | — | `union` / `cut` / `common`，`parts` 为 2 个以上已有形状 |
| `hole` | `on, diameter, at` | `axis, depth` | 在 `on` 上打一个圆孔 |
| `hole_pattern` | `on, diameter` + `positions` 或 `grid` | `axis, depth` | 多孔阵列；`grid` 生成 `count_x × count_y` 网格 |
| `fillet` | `on, radius` | `edge_ids` | 倒圆角；省略 `edge_ids` 时由 runner 选择全部可用边 |
| `chamfer` | `on, size` | `edge_ids` | 倒角 |
| `shell` | `on, thickness` | `faces` | 抽壳 |
| `transform` | `on` + 至少一个变换 | `translate, rotate, mirror, scale` | 平移 / 旋转 / 镜像 / 缩放 |

`hole_pattern` 的 `grid` 示例：

```json
{
  "op": "hole_pattern", "id": "holes", "on": "plate", "diameter": 6,
  "grid": { "origin": [-20, -20, 0], "step_x": 40, "step_y": 40, "count_x": 2, "count_y": 2 }
}
```

## 完整示例

```json
{
  "schema": "dsh.cad.freecad/document@1",
  "name": "L 型支架",
  "units": "mm",
  "parameters": { "w": 60, "h": 40, "t": 8, "hole": 6 },
  "features": [
    { "op": "box", "id": "base", "length": "$w", "width": "$w", "height": "$t" },
    { "op": "box", "id": "wall", "length": "$w", "width": "$t", "height": "$h", "at": [0, 0, "$t"] },
    { "op": "boolean", "id": "body", "mode": "union", "parts": ["base", "wall"] },
    { "op": "hole", "id": "top_hole", "on": "body", "diameter": "$hole", "at": [30, 30, 0] }
  ],
  "result": "top_hole"
}
```

## 校验错误

`validateDocument()` 返回 `{ ok, errors, document }`，`errors` 是 `{ path, message }` 数组，路径形如 `$.features[1].axis`。引擎层把校验失败映射为 `invalid_document`（或 JSON 解析失败时的 `invalid_json`），并附带前 20 条错误；`fcad_validate` 把它们作为**领域结果**返回（`ok: true, valid: false`），而不是工具异常。

CLI 的 `validate` 对非法文档返回退出码 1，便于接入 CI。

## 运行时限制

DSL 校验之外，runner 还会在 FreeCAD 侧复核：

- 包围盒最大边不超过 `maxBoundingBoxMm`。
- 导出文件不超过 `maxArtifactBytes`。
- 预览投影点数不超过 `maxPreviewPoints`。
- 建模超时 `timeoutSeconds`，超时进程会被终止。

这些值由配置归一化并夹到硬上限，文档本身无法覆盖。

# ADR-0001：用声明式 DSL 而不是执行用户代码

- 状态：已接受
- 日期：2026-11-09
- 影响范围：`src/schema.js`、`python/freecad_runner.py`、全部工具 / CLI / Web 入口

## 背景

让大模型驱动 CAD 内核，最直接的写法是「模型生成一段 FreeCAD Python 脚本 → 在本机执行 → 把结果贴回上下文」。本机已安装的 `dsh-cad-design` 插件大体也是这个方向。

但插件运行在用户桌面会话里，脚本来源可能是模型输出、第三方文档、粘贴的 JSON 或被污染的上下文。一旦把「生成代码并执行」作为主路径，就等于给不可信输入本机代码执行权限，哪怕加了黑名单也难以证明安全。

## 备选方案

| 方案 | 优点 | 问题 |
| --- | --- | --- |
| A. 执行模型生成的 Python 脚本 | 表达力最强，任何 FreeCAD API 都能用 | 任意代码执行；无法沙箱化；结果不可复现；难以审计 |
| B. Python 子集 + AST 白名单 | 比 A 安全一些 | 白名单极难完备（属性访问、lambda、`getattr`、导入链）；维护成本高；仍需逐版本跟进 FreeCAD API |
| C. 参数化模板 + 固定参数 | 简单 | 表达力不足，无法组合布尔/孔阵列/倒角 |
| D. 声明式 JSON DSL（14 op） | 纯数据、可校验、可复现、易审计 | 表达力有限；新能力要显式扩展 schema |

## 决策

选 D。文档是纯 JSON，只有 14 种显式 op；数值字段只允许有限数字或 `$parameter` 引用，**不提供表达式求值器**。

具体约束：

- 校验全部在 Node 侧完成，通过后才把归一化副本交给 FreeCAD 进程。
- feature 形成严格 DAG，`on` / `parts` 只能引用更早的 id，runner 顺序构建即可，不需要图解析或循环检测。
- runner 只按 op 分派到固定的 FreeCAD API 调用，不把文档字段当作属性名、函数名或路径使用。
- `Part.Compound` 之类内核差异在 runner 内部处理，不泄漏到 DSL。

## 后果

**正面**

- 静态检查可以证明核心路径没有 `eval` / `new Function` / `shell: true` / `os.system` / `subprocess`（见 `test/safety.test.mjs`）。
- 同一份文档 + 同一组参数永远得到同一几何，便于复现与回归测试。
- 错误信息带 `$.features[i].field` 路径，模型可以自行修正，不需要读堆栈。
- 无 FreeCAD 的 CI 也能跑完整套校验测试。

**负面 / 代价**

- 派生尺寸必须显式增加参数（不能写 `"$outer / 2"`），文档会略啰嗦。
- 支持新特征需要同时改 `src/schema.js` 的 op 表和 `python/freecad_runner.py` 的实现。
- 不覆盖 FreeCAD 全部能力（例如草图约束、装配、FEM）。这是有意为之：这个项目定位是「安全、可复现的参数化实体建模」，不是完整 CAD IDE。
- runner 每次建模都是独立进程，冷启动 0.3–1 秒。

## 相关

- 工具名用 `fcad_` 前缀，避免与本机 `dsh-cad-design` 的 `cad_*` 工具冲突，两者可共存。
- 不可变修订见 [ADR-0002](ADR-0002-immutable-revisions.md)。
- 输入面控制见 [SECURITY.md](SECURITY.md)。

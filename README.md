# dsh-code-intelligence

DeepSeek Harness 的单包代码检索插件：默认提供 AST 声明定位，可按需启用词法源码检索、声明引用查询和前置批量 LSP 定义导航。目标是让 Agent 用较少的重复阅读获取足够证据；目前尚未证明稳定降低总 Token 消耗。

## 构建与接入

当前包为私有本地项目，尚未发布到 npm。需要 Node.js、pnpm，以及已装配文件和工具服务的 Harness 宿主。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

在宿主的 Cordis Context 上加载构建入口；下面的路径须替换为本机绝对路径：

```ts
import * as codeIntelligence from '/absolute/path/to/dsh-code-intelligence-new/dist/index.js'

await ctx.plugin(codeIntelligence, {
  enablePrecedingLsp: true,
})
```

宿主须先装配 `tools`、`fs` 服务。LSP 功能还需要宿主 `lsp` 服务和匹配的语言 provider；语言服务器的安装、配置及生命周期由宿主负责。插件不替换原生 `lsp` 工具，也不自行启动服务器。只有宿主提供 `systemPrompt` 服务时，相应指导段才会注入。

截至 2026-10-13，本项目固定的接口基线为 `@deepseek-ai/cordis@4.0.4`，Harness 的 `dsh-fs`、`dsh-tools`、`dsh-lsp`、`dsh-system-prompt` 为 `0.2.0-rc.2`，运行时语法解析依赖 `typescript@6.0.3`。这是已验证的固定基线，不代表此刻上游最新版本；升级须重新核对公开接口。

## 配置

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `enableCodeContext` | `false` | 注册 `ci_search_context`，词法检索并回传源码上下文 |
| `enableDeclarationReferences` | `false` | 有宿主 LSP 服务时注册 `ci_find_references` |
| `enablePrecedingLsp` | `false` | 有宿主 LSP 服务时注册 `ci_batch_definitions`，并提供前置导航指导 |
| `enableToolCooperationPrompt` | `false` | 注入按实际可见工具生成的协同使用指导 |

`ci_find_declarations` 始终注册。前置 LSP 自身的指导段不依赖 `enableToolCooperationPrompt`。没有 LSP 服务时不会注册两个 LSP 扩展工具；有服务但没有匹配 provider 时如实返回错误。

## 工具与使用顺序

优先使用已有证据：路径未知时先定位候选文件；需要声明身份时用 AST；跨文件实际绑定仍不明确时，对已见使用点做 LSP 查询；只补读缺失或截断的上下文。工具不要求每题全部调用。

### `ci_find_declarations`：声明身份与坐标

```json
{"names": ["createSession"], "files": ["src/session.ts"]}
```

支持 `.ts/.tsx/.js/.jsx`，一次 1–8 个精确名称、1–20 个明确文件。返回声明名称、文件、容器、语法种类和从 1 开始的 UTF-16 行列坐标。覆盖直接命名的函数、类、接口、类型别名、枚举、变量和方法；不覆盖解构名称、类属性和接口属性/方法签名。240 字符首行预览不是完整签名或推导类型。

省略 `files` 时通过宿主字面 grep 发现候选，最多 20 个文件，引用和 import 也会进入候选。候选超限时不解析文件：根据返回线索确认路径后，使用原名称和明确 `files` 重试；不要重复同一个无范围查询。

### `ci_search_context`：词法 RAG

```json
{"terms": ["createSession", "signal"], "path": "src", "limit": 4}
```

输入 1–6 个区分大小写的字面代码词，每词 2–64 字符，不接受正则或自动翻译自然语言。可指定工作区内路径；`limit` 为 1–6，默认 4。对 TS/JS 源码复用宿主 grep，读取匹配文件，再选择、合并和裁剪语法上下文；支持的函数、方法和特定变量初始化上下文会一起呈现，其他情况退回词法窗口或明确省略。

每片最多 40 行、2 KiB，源码总量最多 8 KiB，渲染最多 10 KiB。返回编号源码、路径、关联上下文范围和截断/跳过信息。词法命中不证明语义关系或完整覆盖。

当前产品没有向量检索、图 RAG、树索引、持久库或增量索引。既有本地向量实验不属于插件运行时能力。

### `ci_find_references`：已知声明的引用

```json
{"file_path": "src/session.ts", "name": "createSession"}
```

仅支持已知工作区相对 `.ts` 文件中的精确声明名。唯一声明触发一次宿主引用查询；重名时只返回候选，不猜选。结果包含声明、精确引用范围及有界源码，不代表调用层级。路径未知时先定位声明；其他使用点导航可用原生 `lsp`。

### `ci_batch_definitions`：前置批量定义导航

```json
{"queries": [{"file_path": "src/consumer.ts", "line": 18, "character": 12}]}
```

示例坐标仅展示参数格式，实际须取自已经看到的 `.ts` 引用标识符。路径可为工作区内的相对或绝对路径；行列从 1 开始，列按 UTF-16 计算。一次提交 1–8 个独立引用，避免每个目标单独确认；同一规范路径的完全相同坐标去重。

每输入最多 3 个目标；单文件读取最多 64 KiB、总读取 384 KiB；每目标最多 17 行，整次最多 96 行，单行最多 240 字符，渲染最多 12,000 UTF-8 字节。返回使用点到定义的映射、精确目标坐标、支持的语法元数据及编号源码；外部目标不读取，错误、空结果、省略和截断明确标记。`unknown` 表示没有匹配的受支持语法元数据，不表示没有定义。

指导段鼓励在少量定位阅读后尽早批量导航，并复用足够的结果；它是软提示，不是强制顺序。产品没有“两次阅读”硬守卫、每任务 32 次查询限制、跨调用缓存或阅读历史去重。普通阅读窗口及任务预算由宿主管理。源码版本复核可发现部分变化，但结果不构成原子 LSP 快照。

## 已验证与限制

前置 LSP 运行时基线为提交 `f827943`。已通过类型检查、构建、实际官方 Harness Session 的 24 个绑定核对，以及坐标校验、重复去重、工作区约束、取消、版本变化、缺服务/provider 和提示作用域等定向验证。

2026-10-13，通过正式插件入口进行两个已见题、三组各一次的 Flash Agent 对照：

| 组别 | 所需目标身份 | 严格完整答案 | 总 Token | 请求数 |
| --- | --- | --- | --- | --- |
| 默认插件：文本工具 + AST | 8/8 | 2/2 | 38,044 | 6 |
| 默认插件 + 原生 LSP | 8/8 | 1/2 | 47,677 | 7 |
| 默认插件 + 前置批量 LSP | 8/8 | 0/2 | 42,469 | 6 |

前置批量工具两题都被调用，共执行 9 次底层定义查询，所需绑定均正确；严格扣分来自额外说明中的源/目标文件混淆及类/constructor 元数据表述，详见本地评测记录。相对默认插件总 Token 增加 11.6%，分题分别为 −5.3% 和 +26.2%。原生组实际未调用 LSP，不能把组间差异归因为原生导航后端。

这是小样本、有候选路径、已见题实验，且基线含 AST，不是纯 `rg`；未启用 RAG 或声明引用。它证明正式接入可用和模型能够采用批量导航，尚不证明稳定节省 Token 或提高严格正确率，因此可选功能仍默认关闭。总 Token 包含缓存读取，不等于现金费用；结果不外推到其他语言。

## 开发资料

- [AGENTS.md](AGENTS.md)：工作范围、验证与版本管理约定。
- [src/index.ts](src/index.ts)：唯一插件入口，只导出 `name`、`inject`、`apply`。
- `src/tools/`：模型可见参数、输出、渲染和提示。
- `src/search/`：候选发现、词法检索及结果整理。
- `src/ast/`：独立的 TypeScript 语法解析。
- `src/lsp/`：宿主文件/LSP 服务适配及有界查询。

本地 `docs/design/redevelopment-plan.md` 为总体设计入口；评测资料按实验存于 `docs/evaluation/`，最新插件实验为 `lsp-plugin-agent-small/`，运行时验证为 `lsp-preceding-plugin/`。这些资料以及 `HANDOFF.md`、旧归档、上游检出和生成物均不跟踪到 Git，干净检出不保证包含它们。

文档改动只需内容、链接和差异检查；行为改动先做最小相关静态检查，再按风险使用现有命令或实际运行。默认不新增测试文件。

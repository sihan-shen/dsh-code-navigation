# dsh-code-intelligence

DeepSeek Harness 的单包代码检索插件，默认提供 AST 声明定位，可按需启用词法 RAG（源码上下文检索）、固定文件语义检索、子系统概览、声明引用查询和批量 LSP 定义导航。

## 项目架构

插件入口负责装配和注册工具，检索与导航复用宿主的文件、搜索及 LSP 服务，语言专属语法解析由 TypeScript 提供。

| 模块 | 职责 |
| --- | --- |
| `src/index.ts` | 唯一插件入口，导出 `name`、`inject`、`apply` |
| `src/tools/` | 模型可见的参数、输出、渲染和使用指导 |
| `src/search/` | 候选发现、词法检索、工作区文件约束及结果整理 |
| `src/ast/` | TypeScript/JavaScript 语法解析 |
| `src/lsp/` | 宿主文件与 LSP 服务接入及有界导航 |
| `src/semantic/` | 固定源码快照、向量、一跳引用和显式概览的准备与持久复用 |

## 构建与接入

当前为私有本地包。需要 Node.js、pnpm，以及已装配 `tools`、`fs` 服务的 Harness 宿主。依赖版本由 [package.json](package.json) 和 [pnpm-lock.yaml](pnpm-lock.yaml) 固定。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

在宿主的 Cordis Context 上加载构建入口，替换为本机绝对路径，并按需传入下表配置：

```ts
import * as codeIntelligence from '/absolute/path/to/dsh-code-intelligence-new/dist/index.js'

await ctx.plugin(codeIntelligence, {})
```

LSP 工具需要宿主提供 `lsp` 服务及匹配的语言 provider，语言服务器的安装、配置和生命周期由宿主负责。使用指导通过宿主的可选 `systemPrompt` 服务注入。

## 配置

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `enableFindDeclarations` | `true` | 注册 `ci_find_declarations` |
| `enableCodeContext` | `false` | 注册词法 RAG 工具 `ci_search_context` |
| `enableDeclarationReferences` | `false` | 有宿主 LSP 服务时注册 `ci_find_references` |
| `enablePrecedingLsp` | `false` | 有宿主 LSP 服务时注册 `ci_batch_definitions`，并提供前置导航指导 |
| `enableToolCooperationPrompt` | `false` | 按实际可见工具生成协同使用指导 |
| `semanticIndex` | 未配置 | 注册 `ci_search_semantic_context`；须提供本地 embedding 回调并显式准备固定文件索引 |
| `semanticIndex.overviews` | 未配置 | 额外注册 `ci_get_code_overview`；须配置分组、生成回调并显式准备摘要 |

## 工具

| 工具 | 用途 | 主要输入 |
| --- | --- | --- |
| `ci_find_declarations` | 按精确名称查找 TS/JS 语法声明，返回种类、容器、名称坐标和名称所在行预览；省略 `files` 时自动候选最多 20 个文件 | `names`，可选 `files` |
| `ci_search_context` | 词法 RAG：按字面代码词检索 TS/JS 源码，结合语法上下文返回有界源码片段；配置语义索引时可选用自然语言 `query` 做词法+向量候选并集 | `terms` 和/或 `query`，可选 `mode`、`path`、`limit` |
| `ci_find_references` | 查询已知 `.ts` 文件内唯一具名声明的 LSP 引用（含声明位置），附有界源码 | `file_path`、`name` |
| `ci_batch_definitions` | 从已见 `.ts` 使用点批量导航到静态定义，附有界源码及有限局部续查 | `queries`，每项提供 `file_path`、`line` 和 `symbol` 或 `character` |
| `ci_search_semantic_context` | 在已准备的固定 TS/JS 文件集召回语义相近源码；可选一跳入向引用 | `query`，可选 `path`、`limit`、`expand_relations` |
| `ci_get_code_overview` | 读取显式分组的概览摘要或有界源码 | 可选 `node`、`view`（`summary` / `source`） |

批量导航的 `line` 从 1 开始，`symbol` 使用该行已见的精确标识符；也可改用从 1 开始的 UTF-16 列号 `character`，二者互斥。`queries` 中每项可设置 `definition_only: true`，只查询即时定义。按缺少的事实选择工具，已有源码或返回结果足以回答时即可作答。

`ci_find_declarations` 的系统指导保持精简：只说明何时选择该工具、声明结果可替代哪些读取，以及只补缺失的实现/签名上下文；20 文件候选上限和溢出恢复由工具说明承载，系统指导中的 LSP 坐标交接仅在宿主 `lsp` 工具可见时追加。

### 实现方法

| 工具 | 实现方法 |
| --- | --- |
| [ci_find_declarations](src/search/declaration-search.ts) | 读取指定候选文件；省略文件时先通过宿主字面 `grep` 发现候选。再用 TypeScript AST 筛选精确名称的语法声明，提取种类、容器、名称坐标和所在行预览。 |
| [ci_search_context](src/search/code-context-search.ts) | 通过宿主字面 `grep` 召回命中，读取候选文件；用 TypeScript AST 提取受支持的函数、方法或变量初始化上下文，其余情况使用词法窗口。候选文件在 12 文件上限前按稀有词与声明形态保留；超预算声明返回声明头/命中邻域/省略范围的部分视图。配置 `semanticIndex` 且传入 `query` 时，按 `mode` 把向量命中块的范围作为候选补充；同文件词法/向量范围合并，seed 与相交声明取并集并裁剪部分重叠，词法声明/锚点优先，vector-only 文件最多 2 槽，每文件最多 2 个不同 seed 范围片段，片段级保留 seed 范围与来源。输出按术语报告匹配、选中、锚点、省略原因及 vector 状态；向量片段渲染为导航卡：top-1 卡附最多 2KiB 正文，其余给声明/seed 首尾，按精确范围再读正文；片段附 `seedCoverage`（full/partial）与最多 3 个 1-based UTF-16 锚点；同 Session 内重复 query 复用 seed，不重复 embedding。 |
| [ci_find_references](src/lsp/declaration-references.ts) | 用 AST 定位已知文件内的唯一具名声明，再调用宿主 LSP 的 `findReferences`，按精确范围去重并附引用源码；短 import/export 语句由 AST 补齐上下文。 |
| [ci_batch_definitions](src/lsp/batch-definitions.ts) | 用 AST 选择 `line + symbol` 对应的唯一标识符，或使用显式 UTF-16 列号，再调用宿主 LSP 的 `goToDefinition`；根据目标源码补充受支持的声明信息、成员/容器上下文和省略状态。 |

这里的**词法 RAG**是把检索到的源码片段作为 Agent 生成回答时的证据：召回使用字面匹配，AST 用于上下文组织和选择，检索工具本身不调用生成模型或向量模型。

批量定义导航由 **AST 与 LSP 协作**：局部续查时，AST 从定义源码中选择唯一受支持的下一使用点，再交给宿主 LSP 查询其定义。AST 负责语法定位、上下文组织和续查位置选择，跨文件绑定由 LSP 解析。这里的内部 AST 解析不依赖 `ci_find_declarations` 是否注册。

### 固定文件语义检索与概览准备

通过包子入口 `dsh-code-intelligence/semantic-index` 显式准备，再传入同一配置加载插件。以下示例假定宿主 `ctx`、工作区绝对路径 `cwd` 和本地回调 `localEmbedding` 已提供：

```ts
import {
  prepareSemanticIndex,
  type SemanticIndexConfig,
} from 'dsh-code-intelligence/semantic-index'

const semanticIndex: SemanticIndexConfig = {
  files: ['src/service.ts'], // 替换为明确的 TS/JS 文件集合
  embedding: localEmbedding,
}
await prepareSemanticIndex(ctx.fs, semanticIndex, { cwd })
await ctx.plugin(codeIntelligence, { semanticIndex })
```

`localEmbedding` 实现同入口导出的 `LocalEmbedding`：提供模型/预处理修订 `id`、向量 `dimensions` 和 `embed(texts, purpose, signal)`，按输入顺序返回有限非零向量；`purpose` 为 `document` 或 `query`。将取消信号传给后端。插件不内置模型下载或 embedding 网络客户端。

需要概览时，在准备前为配置增加 `overviews`，提供 `OverviewGenerator` 生成回调和显式节点，例如：

```ts
semanticIndex.overviews = {
  generator: overviewGenerator, // 已提供的 OverviewGenerator 实现
  nodes: [{ id: 'service', label: '服务概览', files: ['src/service.ts'] }],
}
```

先准备基础索引，再调用同子入口的 `prepareSemanticOverviews(ctx.fs, semanticIndex, { cwd })`，最后加载插件。查询时省略 `node` 使用配置根节点；`view: 'summary'` 读取摘要，`view: 'source'` 读取原文且不要求摘要已经生成。查询不调用生成器。

需要持久一跳引用时，增加 `relations`（准确的 `lspId`、`environmentFiles` 和声明名称坐标 `anchors`），在基础索引准备后调用 `prepareSemanticRelations(ctx.fs, ctx.lsp, semanticIndex, { cwd })`。构建需要宿主 LSP，查询不调用 LSP；`expand_relations: false` 可关闭查询中的引用扩展。

准备结果持久化在各工作区的 `.code-intelligence/`，有效快照可跨进程复用。源码、固定范围、模型身份、生成器或分组变化后，按相应准备接口显式传入 `rebuild: true` 重建；不同工作区/worktree 的索引不可直接复用。完整配置类型见 [语义索引接口](src/semantic/types.ts) 和 [概览接口](src/semantic/overview-types.ts)。

## 开发资料

[AGENTS.md](AGENTS.md) 记录项目工作约定。设计、实施计划和评测资料分别保存在本地 `docs/design/`、`docs/plans/`、`docs/evaluation/`，不随 Git 分发。

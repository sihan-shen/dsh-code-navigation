# dsh-code-navigation

Code navigation and retrieval toolkit for DeepSeek Harness.

本项目是一个单包 Cordis 插件：默认提供 TypeScript/JavaScript 语法声明定位；按需启用词法 RAG、固定文件语义索引、Hybrid 词法+向量检索、子系统概览、声明引用和批量 LSP 定义导航。所有检索工具只负责召回和整理源码证据，不调用生成模型；是否使用字面搜索、AST、向量或 LSP 由工具与配置显式区分。

## Table of Contents

- [Security](#security)
- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [Language Scope](#language-scope)
- [Tools](#tools)
- [RAG Modes and Principles](#rag-modes-and-principles)
- [Semantic Index Preparation](#semantic-index-preparation)
- [Batch LSP Navigation](#batch-lsp-navigation)
- [API](#api)
- [Contributing](#contributing)
- [License](#license)

## Security

- 语义索引只读取显式配置的固定文件集合，不进行全仓 glob、自动发现或自动更新。
- 插件不内置模型下载、embedding 网络客户端或凭据管理；embedding 和 LSP 由宿主/操作者提供。
- 索引和概览保存在工作区 `.code-navigation/`；不要把密钥、认证信息或未授权源码加入索引文件。
- LSP 工具使用宿主提供的服务；语言服务器的安装、权限和生命周期由宿主负责。
- 查询结果中的源码片段和摘要只作为证据线索，不代表运行时或完整语义证明。

## Background

代码检索通常需要在“精确符号”和“自然语言概念”之间切换。纯字面搜索对已知标识符可靠，但不擅长概念召回；向量检索能补充候选，却不能替代源码证据。本项目把两类能力拆成不同工具和模式：

- 先用最小、明确的检索信号定位文件和范围；
- 用 TypeScript AST 补声明身份、容器和有界上下文；
- 可选地用固定文件语义索引补充候选；
- 绑定、引用和定义跳转交给宿主 LSP；
- 最终答案仍由 Agent 读取和判断源码。

抽象依赖为 DeepSeek Harness 的 `tools`、`fs` 服务，以及可选的 `lsp`、`systemPrompt` 服务。依赖版本由 [package.json](package.json) 和 [pnpm-lock.yaml](pnpm-lock.yaml) 固定。

## Install

需要 Node.js、pnpm，以及已装配 `tools`、`fs` 服务的 Harness 宿主。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

当前为私有本地包，未发布到公共 registry。`peerDependencies` 兼容 DSH `0.2.0-rc.2`、`0.2.1-rc.2` 及 `0.2.x` stable；更新的 prerelease 需要重新验证。实际运行验证使用 DSH `0.2.1-rc.2`。安装完成后，在宿主 Cordis Context 上加载构建入口，替换为实际绝对路径：

```ts
import * as codeNavigation from '/absolute/path/to/dsh-code-navigation/dist/index.js'

await ctx.plugin(codeNavigation, {})
```

## Usage

最小用法是只启用默认的 AST 声明定位：

```ts
await ctx.plugin(codeNavigation, {
  enableFindDeclarations: true,
})
```

启用词法 RAG 和可选语义索引：

```ts
await ctx.plugin(codeNavigation, {
  enableCodeContext: true,
  semanticIndex, // 显式准备的固定文件索引；未配置时只有词法模式
})
```

典型工具选择：

1. 已知精确名称：`nav_find_declarations`。
2. 需要实现源码：`nav_search_context`（词法模式）。
3. 需要概念召回且已有索引：`nav_search_context` + `query` + `mode: 'hybrid'`。
4. 需要纯语义召回：`nav_search_semantic_context`。
5. 已知声明或使用点的绑定/引用：`nav_find_references`、`nav_batch_definitions`。
6. 子系统导航：`nav_get_code_overview`；摘要不是实现证据。

## Configuration

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `enableFindDeclarations` | `true` | 注册 `nav_find_declarations` |
| `enableCodeContext` | `false` | 注册 `nav_search_context`；配置 `semanticIndex` 后支持 `query`/`mode` |
| `enableDeclarationReferences` | `false` | 有宿主 LSP 时注册 `nav_find_references` |
| `enablePrecedingLsp` | `false` | 有宿主 LSP 时注册 `nav_batch_definitions`，并注入前置导航指导 |
| `enableToolCooperationPrompt` | `false` | 按当前 Session 实际可见的工具生成协同使用指导 |
| `semanticIndex` | 未配置 | 注册 `nav_search_semantic_context`；要求显式准备固定文件索引 |
| `semanticIndex.overviews` | 未配置 | 额外注册 `nav_get_code_overview`；要求显式准备概览 |

LSP 工具需要宿主提供 `lsp` 服务及匹配的语言 provider；缺少服务时不会注册对应工具。系统提示通过宿主的可选 `systemPrompt` 服务注入。

## Language Scope

解析与检索路径覆盖 `.ts`、`.tsx`、`.js`、`.jsx`；批量 LSP 和引用查询只接受 `.ts` 使用点。其他语言不在当前范围内，不要把 TypeScript/JavaScript 的结果外推为其他语言支持。

## Tools

| 工具 | 用途 | 主要输入 |
| --- | --- | --- |
| `nav_find_declarations` | 按精确名称查找 TS/JS 语法声明；返回种类、容器、名称坐标和首行预览。省略 `files` 时用宿主 grep 自动发现最多 20 个候选文件 | `names`（1–8），可选 `files`（1–20） |
| `nav_search_context` | 词法 RAG：字面匹配 + AST 声明上下文/有界源码；配置索引且传 `query` 时支持词法+向量候选并集 | `terms`（1–6）和/或 `query`，可选 `mode`、`path`、`limit` |
| `nav_search_semantic_context` | 纯语义 RAG：在已准备的固定文件快照中按 query 向量召回源码块；可选一跳引用扩展 | `query`，可选 `path`、`limit`（1–6）、`expand_relations` |
| `nav_find_references` | 查询已知 `.ts` 文件内唯一具名声明的 LSP 引用，附有界源码 | `file_path`、`name` |
| `nav_batch_definitions` | 从已见 `.ts` 使用点批量导航到静态定义；支持 `line + symbol` 或 `line + character` | `queries`（1–8） |
| `nav_get_code_overview` | 读取显式分组的概览摘要或有界源码 | 可选 `node`、`view`（`summary`/`source`） |

`nav_search_context` 的 `terms` 与 `query` 至少提供一个；`mode` 默认 `auto`：

- `lexical`：只走字面检索，不调用向量；
- `auto`：词法覆盖为空或某 term 无候选时才尝试向量；
- `hybrid`：显式并集词法候选与向量候选，需要 `query` 和 `semanticIndex`。

无 `semanticIndex` 时，schema 不暴露 `query`/`mode`。

## RAG Modes and Principles

本包的 RAG 只负责检索和证据整理，不调用生成模型。

| 模式 | 工具 | 检索信号 | 原理 | 边界 |
| --- | --- | --- | --- | --- |
| 词法 RAG | `nav_search_context`（无 `semanticIndex`） | 字面 `grep` | 宿主 grep 召回文件和行；TypeScript AST 扩展为声明头、命中邻域或词法窗口；按术语、稀有度和声明形态选择有界片段 | 不做 embedding、不做语义相似、不调用生成模型 |
| Hybrid RAG | `nav_search_context` + `semanticIndex` + `query` | grep + 固定文件向量索引 | 词法候选与向量 top seeds 并集；词法声明/锚点优先，向量只提供候选文件和范围；seed 与相交声明取并集、裁剪部分重叠；向量片段以导航卡呈现，源码仍从当前工作区读取 | 不做 raw score 融合/RRF、不把 cosine 当语义证明、不自动建索引、不扩到未准备文件 |
| 纯语义 RAG | `nav_search_semantic_context` | 固定文件向量索引 | 对已准备快照计算 query embedding，按 top-k chunk 返回源码；配置 relations 时可加一跳入向引用 | 不做字面候选、不调用生成模型、不自动发现或增量更新 |
| AST 声明定位 | `nav_find_declarations` | TypeScript AST | 按精确名称筛选语法声明，返回种类、容器和坐标 | 不是证据召回；不证明运行时行为 |
| LSP 导航 | `nav_find_references`、`nav_batch_definitions` | AST + 宿主 LSP | 已知声明/使用点交给宿主 LSP 解析绑定、引用或定义 | 不建全仓图；不替代源码证据 |
| 概览导航 | `nav_get_code_overview` | 显式分组摘要 | 返回节点摘要或基础快照源码 | 摘要不是正确性或完整实现证明 |

Hybrid 的边界：

- 向量只补充候选，不替代词法声明/锚点；最终片段仍从当前工作区读取。
- `seedCoverage=full` 只表示片段覆盖 seed 范围，不表示覆盖题目或完整语义。
- 向量片段默认渲染为导航卡：top-1 卡附最多 2KiB 正文，其余为范围/声明/锚点 pointer；未展示正文不作为证据。
- 当前没有 RRF、LLM reranker、全仓图、摘要树或查询改写。
- 同一 Session 内相同 query 的 vector seed 可有界复用（最多 8 条），不跨 Session；索引重建后应新开 Session。

## Semantic Index Preparation

语义能力不会自动发现文件、下载模型或更新索引。通过包子入口显式准备：

```ts
import {
  prepareSemanticIndex,
  type SemanticIndexConfig,
} from 'dsh-code-navigation/semantic-index'

const semanticIndex: SemanticIndexConfig = {
  files: ['src/service.ts'], // 1–32 个明确的 TS/JS 文件
  embedding: localEmbedding,
}
await prepareSemanticIndex(ctx.fs, semanticIndex, { cwd })
await ctx.plugin(codeNavigation, { semanticIndex })
```

`localEmbedding` 实现 `LocalEmbedding`：

- `id`：包含模型、pooling、预处理和 query/document 指令版本；
- `dimensions`：1–4096；
- `embed(texts, purpose, signal)`：按顺序返回有限非零向量；`purpose` 为 `document` 或 `query`，需传递取消信号。

索引固定为配置的 `files`，不进行 glob、全仓发现或增量更新；源码、模型身份、解析版本或固定范围变化后，显式调用 `prepareSemanticIndex(..., { rebuild: true })`。

### Overviews

```ts
semanticIndex.overviews = {
  generator: overviewGenerator, // OverviewGenerator 实现
  nodes: [{ id: 'service', label: '服务概览', files: ['src/service.ts'] }],
}
await prepareSemanticIndex(ctx.fs, semanticIndex, { cwd })
await prepareSemanticOverviews(ctx.fs, semanticIndex, { cwd })
```

节点最多 8 个、最多 3 层；父节点只聚合子摘要。查询 `view: 'summary'` 读摘要，`view: 'source'` 读基础快照源码，不要求摘要已生成；查询不调用生成器。

### Relations

```ts
semanticIndex.relations = {
  lspId: 'typescript-language-server@5.3.0',
  environmentFiles: ['tsconfig.json'],
  anchors: [{ path: 'src/service.ts', line: 10, character: 3 }],
}
await prepareSemanticIndex(ctx.fs, semanticIndex, { cwd })
await prepareSemanticRelations(ctx.fs, ctx.lsp, semanticIndex, { cwd })
```

查询侧只读取已准备关系，不调用 LSP；`expand_relations: false` 可关闭扩展。关系是一跳语法/引用线索，不证明运行时调用。

准备结果保存在工作区 `.code-navigation/`；不同工作区/worktree 的索引不能直接复用。完整类型见 [语义索引接口](src/semantic/types.ts) 和 [概览接口](src/semantic/overview-types.ts)。

## Batch LSP Navigation

`nav_batch_definitions` 只处理 `.ts` 中已见的使用点：

- 优先 `line + symbol`，也可用一基 UTF-16 `line + character`，二者互斥；
- 每个 cursor 最多 3 个目标，单文件 64KiB、总读取 384KiB、96 个唯一源码行、12000 UTF-8 渲染字节；
- 省略 `definition_only` 时，可对唯一的 callback/new、return this、构造器赋值或数组初始化调用做最多两层、四个内部续查；
- `file_too_large` 不能靠移动 cursor 或换路径解决；应复用已有证据或改用原生 LSP/聚焦 read；
- 静态定义不证明运行时 dispatch。

`nav_find_references` 只对已知 `.ts` 文件内唯一具名声明发起一次宿主引用查询；同名歧义返回候选，不猜选。源码片段是引用上下文，不是调用层级证明。

## API

公开入口：

- 主入口 `dsh-code-navigation`：导出 `name`、`inject`、`apply`，由 Harness 装载。
- 子入口 `dsh-code-navigation/semantic-index`：导出 `prepareSemanticIndex`、`prepareSemanticOverviews`、`prepareSemanticRelations`，以及 `LocalEmbedding`、`SemanticIndexConfig`、`SemanticRelationsConfig`、`OverviewGenerator` 等类型。

工具是模型可见 API，参数、输出和渲染实现位于 [src/tools/](src/tools/)；检索与语义准备实现位于 [src/search/](src/search/) 和 [src/semantic/](src/semantic/)。完整类型定义见 [语义索引接口](src/semantic/types.ts) 和 [概览接口](src/semantic/overview-types.ts)。

## Contributing

当前为私有本地包，不接受外部 Pull Request。问题、缺陷和改动请求请通过仓库所有者或内部协作渠道提出；提交前请运行：

```sh
pnpm typecheck
pnpm build
```

项目工作约定见 [AGENTS.md](AGENTS.md)。修改检索协议、工具 schema 或语义索引格式时，应同步更新本 README 和相关设计文档。

## License

[MIT](LICENSE) © 2026 dsh-code-navigation contributors。

本项目采用与常见 DeepSeek Harness 插件一致的 MIT 协议。

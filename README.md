# dsh-code-intelligence

DeepSeek Harness 的单包代码检索插件，默认提供 AST 声明定位，可按需启用词法 RAG（源码上下文检索）、声明引用查询和批量 LSP 定义导航。

## 项目架构

插件入口负责装配和注册工具，检索与导航复用宿主的文件、搜索及 LSP 服务，语言专属语法解析由 TypeScript 提供。

| 模块 | 职责 |
| --- | --- |
| `src/index.ts` | 唯一插件入口，导出 `name`、`inject`、`apply` |
| `src/tools/` | 模型可见的参数、输出、渲染和使用指导 |
| `src/search/` | 候选发现、词法检索、工作区文件约束及结果整理 |
| `src/ast/` | TypeScript/JavaScript 语法解析 |
| `src/lsp/` | 宿主文件与 LSP 服务接入及有界导航 |

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

## 工具

| 工具 | 用途 | 主要输入 |
| --- | --- | --- |
| `ci_find_declarations` | 按精确名称查找 TS/JS 语法声明，返回种类、容器、名称坐标和名称所在行预览 | `names`，可选 `files` |
| `ci_search_context` | 词法 RAG：按字面代码词检索 TS/JS 源码，结合语法上下文返回有界源码片段 | `terms`，可选 `path`、`limit` |
| `ci_find_references` | 查询已知 `.ts` 文件内唯一具名声明的 LSP 引用（含声明位置），附有界源码 | `file_path`、`name` |
| `ci_batch_definitions` | 从已见 `.ts` 使用点批量导航到静态定义，附有界源码及有限局部续查 | `queries`，每项提供 `file_path`、`line` 和 `symbol` 或 `character` |

批量导航的 `line` 从 1 开始，`symbol` 使用该行已见的精确标识符；也可改用从 1 开始的 UTF-16 列号 `character`，二者互斥。`queries` 中每项可设置 `definition_only: true`，只查询即时定义。按缺少的事实选择工具，已有源码或返回结果足以回答时即可作答。

### 实现方法

| 工具 | 实现方法 |
| --- | --- |
| [ci_find_declarations](src/search/declaration-search.ts) | 读取指定候选文件；省略文件时先通过宿主字面 `grep` 发现候选。再用 TypeScript AST 筛选精确名称的语法声明，提取种类、容器、名称坐标和所在行预览。 |
| [ci_search_context](src/search/code-context-search.ts) | 通过宿主字面 `grep` 召回命中，读取候选文件；用 TypeScript AST 提取受支持的函数、方法或变量初始化上下文，其余情况使用词法窗口。随后按声明锚点、词覆盖及文件分散选择片段，去重、裁剪并返回编号源码。 |
| [ci_find_references](src/lsp/declaration-references.ts) | 用 AST 定位已知文件内的唯一具名声明，再调用宿主 LSP 的 `findReferences`，按精确范围去重并附引用源码；短 import/export 语句由 AST 补齐上下文。 |
| [ci_batch_definitions](src/lsp/batch-definitions.ts) | 用 AST 选择 `line + symbol` 对应的唯一标识符，或使用显式 UTF-16 列号，再调用宿主 LSP 的 `goToDefinition`；根据目标源码补充受支持的声明信息、成员/容器上下文和省略状态。 |

这里的**词法 RAG**是把检索到的源码片段作为 Agent 生成回答时的证据：召回使用字面匹配，AST 用于上下文组织和选择，检索工具本身不调用生成模型或向量模型。

批量定义导航由 **AST 与 LSP 协作**：局部续查时，AST 从定义源码中选择唯一受支持的下一使用点，再交给宿主 LSP 查询其定义。AST 负责语法定位、上下文组织和续查位置选择，跨文件绑定由 LSP 解析。这里的内部 AST 解析不依赖 `ci_find_declarations` 是否注册。

## 开发资料

[AGENTS.md](AGENTS.md) 记录项目工作约定。设计、实施计划和评测资料分别保存在本地 `docs/design/`、`docs/plans/`、`docs/evaluation/`，不随 Git 分发。

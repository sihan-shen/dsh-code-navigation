# dsh-code-intelligence

DeepSeek Harness 的单包代码检索插件：默认提供 AST 声明定位，可按需启用词法源码检索、固定文件语义检索、子系统概览摘要、声明引用查询和前置批量 LSP 定义导航。目标是让 Agent 用较少的重复阅读获取足够证据；目前尚未证明稳定降低总 Token 消耗。

2026-10-14的新仓库对照（4仓库、8题、两组各重复2次）中，前置LSP插件总Token比原生read/grep/glob/lsp高5.5%；正常入口子组低19.2%，超出64 KiB入口限制的子组高69.2%。较少阅读没有转化为整体成本下降，前置LSP仍默认关闭。

上一次修正实验（三题四组各一次）中，仅错误恢复版比旧版少27.3%总Token，停止描述版比错误版贵2.0%，当时未保留到主描述。最新两候选分别与原生的18格复验中，停止指导版比原生少32.4%、比错误版少20.9%；两次都在同文件证据足够时直接答，跨文件题仍采用批量导航。已将停止指导版合回主插件，默认前置仍关闭。短导入目标题仍比原生贵6.3%，三题两次不能证明通用稳定收益。

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
  enableFindDeclarations: false, // 只调查使用点绑定时，减少无关声明工具协议
})
```

宿主须先装配 `tools`、`fs` 服务。LSP 功能还需要宿主 `lsp` 服务和匹配的语言 provider；语言服务器的安装、配置及生命周期由宿主负责。插件不替换原生 `lsp` 工具，也不自行启动服务器。只有宿主提供 `systemPrompt` 服务时，相应指导段才会注入。

截至 2026-10-13，本项目固定的接口基线为 `@deepseek-ai/cordis@4.0.4`，Harness 的 `dsh-fs`、`dsh-tools`、`dsh-lsp`、`dsh-system-prompt` 为 `0.2.0-rc.2`，运行时语法解析依赖 `typescript@6.0.3`。这是已验证的固定基线，不代表此刻上游最新版本；升级须重新核对公开接口。

## 配置

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `enableFindDeclarations` | `true` | 注册 `ci_find_declarations`；只需入口使用点导航时可关闭 |
| `enableCodeContext` | `false` | 注册 `ci_search_context`，词法检索并回传源码上下文 |
| `enableDeclarationReferences` | `false` | 有宿主 LSP 服务时注册 `ci_find_references` |
| `enablePrecedingLsp` | `false` | 有宿主 LSP 服务时注册 `ci_batch_definitions`，并提供前置导航指导 |
| `enableToolCooperationPrompt` | `false` | 注入按实际可见工具生成的协同使用指导 |
| `semanticIndex` | 未配置 | 注册 `ci_search_semantic_context`；须显式准备固定文件索引并提供本地 embedding 函数 |
| `semanticIndex.overviews` | 未配置 | 额外注册 `ci_get_code_overview`；显式分组、生成接口及摘要准备，查询不调用模型 |

`ci_find_declarations` 默认注册，`enableFindDeclarations: false` 可关闭；前置LSP的内部语法解析不依赖该声明工具。前置 LSP 自身的指导段不依赖 `enableToolCooperationPrompt`。没有 LSP 服务时不会注册两个 LSP 扩展工具；有服务但没有匹配 provider 时如实返回错误。

## 工具与使用顺序

按所缺证据选择可以替代常规 `read` 的工具：只缺已知名称的声明身份时用 AST；字面检索需要有界实现上下文时用词法源码检索；已见 `.ts` 使用点的静态绑定或短调用链未明时，用前置 LSP 替代候选目标文件阅读。返回的身份、映射和源码足够时直接作答，之后 `grep/read` 仅补未覆盖事实；不要先读目标，再调用这些工具确认。工具不要求每题全部调用。

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

该词法工具不调用 embedding，不依赖语义索引。可选的固定文件向量召回见下节；既有本地向量实验的收益不代表当前产品已通过效果验收。

### `ci_search_semantic_context`：固定文件语义检索

```json
{"query": "超时后如何取消请求并清理资源", "path": "src", "limit": 4}
```

适合名称未知、能够描述行为的 TS/JS 问题。它在操作者明确准备的文件集合内做精确 cosine 排序，返回编号源码及支持的 AST 声明位置、范围和最近命名父声明。`query` 为 1–1000 字符，`path` 为可选的工作区相对文件/目录，`limit` 为 1–6、默认 4；范围外不自动发现文件。相似度不证明调用或绑定关系，语法包含不等于业务或运行时关系。

先通过同包 `semantic-index` 子入口显式准备，再加载插件；主入口仍只导出 `name`、`inject`、`apply`。以下装配函数接收你已有的本地 embedding 实现：

```ts
import type { Context } from '@deepseek-ai/cordis'
import * as codeIntelligence from '/absolute/path/to/dsh-code-intelligence-new/dist/index.js'
import {
  prepareSemanticIndex,
  type LocalEmbedding,
} from '/absolute/path/to/dsh-code-intelligence-new/dist/semantic/index.js'

async function attachSemanticSearch(ctx: Context, cwd: string, embedding: LocalEmbedding) {
  const semanticIndex = {
    files: ['src/session.ts', 'src/request.ts'], // 替换为明确的源码范围
    embedding,
  }
  const preparation = await prepareSemanticIndex(ctx.fs, semanticIndex, { cwd })
  await ctx.plugin(codeIntelligence, { semanticIndex })
  return preparation
}
```

作为包导入时，准备入口为 `dsh-code-intelligence/semantic-index`。embedding 合同为：

```ts
interface LocalEmbedding {
  id: string
  dimensions: number
  embed(texts: readonly string[], purpose: 'document' | 'query', signal: AbortSignal):
    Promise<readonly (readonly number[])[]>
}
```

`id` 必须包含准确模型修订、pooling、预处理和 query/document 指令版本；改变任一项应换 ID 并重建。`embed` 返回与输入顺序一致的有限非零向量，维度为 `dimensions`（1–4096）；文档输入是 `path:start-end` 加原始连续源码，问题输入是原始查询，适用的不同指令由适配器按 `purpose` 处理。适配器须将 `signal` 传给本地后端并配合取消。插件不内置模型、网络客户端或下载逻辑；函数应连接你选择的本地模型，插件无法验证任意回调内部使用的服务。

快照保存在各工作区的 `.code-intelligence/semantic-index.json`，包含源码、向量及 AST 元数据，默认忽略不纳入 Git。固定集合为 1–32 个 `.ts/.tsx/.js/.jsx` 文件，单文件最多 1 MiB、总计 4 MiB；每块最多 40 行/2 KiB、重叠最多 8 行，超长单行明确省略。最多 2048 块、4096 声明、2097152 个向量数值、64 MiB 快照；不完整 AST 或其他缺口会标记。查询合并重叠源码行，源文本总计最多 8 KiB、渲染最多 10 KiB。

再次准备会直接复用有效快照，`embeddedDocuments: 0`，跨进程也不重复计算文档向量或 AST；每次有候选的查询只计算一个问题向量。准备结果区分 `created/rebuilt/reused`，记录文档数、声明数、源码/索引字节和耗时；查询记录候选数、embedding 次数及耗时。没有问题向量缓存，也没有内存常驻模型或索引服务。

缺索引时，工具要求操作者运行准备 API。文件改动、删除/改名、固定范围、模型 ID/维度或 TypeScript/快照格式变化后，拒绝复用，须显式调用 `prepareSemanticIndex(ctx.fs, semanticIndex, { cwd, rebuild: true })` 整体重建；查询不自动更新、不悄悄回退词法。源码变化依据宿主的文件版本与 canonical identity；没有哈希检查，前后版本复核也不是原子仓库快照。不同工作区/worktree 不共享索引，缓存目录/文件不接受符号链接，源码别名须仍处于工作区内。

固定本地 Qwen3-Embedding-0.6B 的一次开发语料验证已完成：8文件55块，三题必要可见事实向量5/6、带人工实现词的词法6/6，未证明通用召回或完整 Agent Token 收益。默认配置不启用语义检索；没有自动聚类或增量更新。显式概览层级见下节。


### 可选的持久一跳引用

在同一 `semanticIndex` 中增加 `relations`，先完成向量准备，再调用同包子入口的 `prepareSemanticRelations(ctx.fs, ctx.lsp, semanticIndex, { cwd })`。构建时需要已有宿主 LSP 服务，插件不启动语言服务器；查询和复用只读磁盘，不调用 LSP。

```ts
import { prepareSemanticIndex, prepareSemanticRelations } from 'dsh-code-intelligence/semantic-index'

const semanticIndex = {
  files: ['src/service.ts', 'src/caller.ts'],
  embedding: localEmbedding,
  relations: {
    lspId: 'my-typescript-provider@version;toolchain-and-config-v1',
    environmentFiles: ['tsconfig.json', 'package.json', 'pnpm-lock.yaml'],
    anchors: [{ path: 'src/service.ts', line: 12, character: 23 }],
  },
}
await prepareSemanticIndex(ctx.fs, semanticIndex, { cwd })
await prepareSemanticRelations(ctx.fs, ctx.lsp, semanticIndex, { cwd })
await ctx.plugin(codeIntelligence, { semanticIndex })
```

锚点必须是已准备源码中支持的命名声明的精确一基 UTF-16 名称坐标，1–8个；每个锚点一次公开 `findReferences`，最多处理前256个位置、保存24个不同使用点。只保存固定源码集合内、精确匹配 AST 标识符的使用点；声明、import 声明、范围外/未知语法及额度省略有计数。这是对该锚点符号的静态 `references`，附 `callee/argument/other` 语法角色和最近支持的容器 ID；参数不是调用，callee 不证明运行时执行，也不证明重载唯一实现。非标识符、计算属性等未覆盖位置不会猜选。

关系单独存入 `.code-intelligence/semantic-relations.json`（最多512KiB），绑定向量快照的宿主版本及所有源码版本，并记录1–16个显式环境文件的 canonical identity/版本。`lspId` 由操作者标识实际 provider、工具链与配置，宿主未返回 provider 身份供验证；环境文件不是完整依赖闭包，未列入的配置、依赖和工具链变化须更新 ID 并显式重建。索引重建、环境文件/关系配置变化后调用 `prepareSemanticRelations(..., { cwd, rebuild: true })`，缺失/损坏/过期不自动修复或回退。

配置后查询默认扩展：只从原向量排名块中出现声明名称位置的锚点取入向引用，最多一跳、8条/2KiB映射，`path` 同时约束种子与引用来源。锚点按最早命中种子的排名轮转，每轮最多选一条可容纳引用；锚点内优先种子未出现的文件，再选同文件未覆盖位置，最后选已覆盖位置，路径/行/列稳定排序。较大记录放不下时跳过并继续尝试其他记录；预算仍可能省略锚点或使用点，这个启发式不保证问题相关性。返回 `relations` 的源/目标坐标与版本、语法角色及容器，`relationIndexCreatedAt/relationIndexBytes/lspQueries` 说明复用情况。扩展源码先占最多3KiB，种子源码使用剩余预算；总源码仍8KiB、渲染仍10KiB，可能挤出种子证据，所有省略会标记。`expand_relations: false` 保留相同向量种子的不扩展对照，也可在关系快照暂时不可用时明确选择它。没有递归、自动全仓建图、查询缓存或运行时调用图。

### `ci_find_references`：已知声明的引用

```json
{"file_path": "src/session.ts", "name": "createSession"}
```

仅支持已知工作区相对 `.ts` 文件中的精确声明名。唯一声明触发一次宿主引用查询；重名时只返回候选，不猜选。结果包含声明、精确引用范围及有界源码，不代表调用层级。路径未知时先定位声明；其他使用点导航可用原生 `lsp`。

### `ci_get_code_overview`：显式子系统概览

```json
{"node": "request", "view": "summary"}
```

适用于整体职责、边界和下一步检查区域；省略`node`返回根概览及节点目录。`view: "source"`提供同节点文件集合的有界原文，不要求摘要先生成。查询不调用生成器、embedding或LSP；摘要声明附源码范围，坐标合法不代表语义正确或证据完整，精确条件、异常及绑定仍需引用原文/适用语言工具。

```ts
import type { Context } from '@deepseek-ai/cordis'
import * as codeIntelligence from '/absolute/path/to/dsh-code-intelligence-new/dist/index.js'
import {
  prepareSemanticIndex, prepareSemanticOverviews,
  type LocalEmbedding, type OverviewGenerator, type SemanticIndexConfig,
} from 'dsh-code-intelligence/semantic-index'

async function attachOverviews(ctx: Context, cwd: string,
  embedding: LocalEmbedding, generator: OverviewGenerator) {
  const semanticIndex: SemanticIndexConfig = {
    files: ['src/session.ts', 'src/request.ts'],
    embedding,
    overviews: {
      generator,
      nodes: [
        { id: 'root', label: '会话与请求概览', children: ['session', 'request'] },
        { id: 'session', label: '会话', files: ['src/session.ts'] },
        { id: 'request', label: '请求生命周期', files: ['src/request.ts'] },
      ],
    },
  }
  await prepareSemanticIndex(ctx.fs, semanticIndex, { cwd })
  const preparation = await prepareSemanticOverviews(ctx.fs, semanticIndex, { cwd })
  await ctx.plugin(codeIntelligence, { semanticIndex })
  return preparation
}
```

生成接口来自同包子入口：

```ts
import type { OverviewRequest, GeneratedOverview } from 'dsh-code-intelligence/semantic-index'

interface OverviewGenerator {
  id: string // 模型、提示、解码配置修订；语义变化须换id
  generate(request: OverviewRequest, signal: AbortSignal): Promise<GeneratedOverview>
}
// request含profile/instruction/node，以及sources或children：
// 叶sources为完整文件path/source；父children只含直接子节点摘要及出处。
// GeneratedOverview示意，坐标必须对应本节点可用证据：
const output: GeneratedOverview = {
  claims: [{ text: '请求状态由该子系统维护。',
    evidence: [{ path: 'src/request.ts', startLine: 10, endLine: 18 }] }],
  limitations: ['摘要用于概览，具体取消条件需要回到源码。'],
  usage: { totalTokens: null, requests: null }, // 实际数值或null，未知不当0
}
```

适配器应把SDK返回值规范为上述字段，不原样返回包含额外字段的响应。每节点1次显式回调；1–6条声明，每条≤400 UTF-8字节、1–3段引文，每段≤12行；最多4条限制、每条≤200字节。叶引文须在该组完整原文内，父只能复用直接子摘要已有的精确引文，不能编造新坐标。位置与范围校验不能检测生成内容的事实错误，回调也不能把源码中的指令当作操作授权。

配置是1–8节点、最多3层的单父有根树；叶`files`与父`children`互斥。叶可跨目录并交叉引用同一文件，根并集必须覆盖固定集。这里是操作者定义的概览层级，不是自动语义聚类/RAPTOR。每次回调的请求JSON≤64KiB，输入完整、不静默截断；超限须收窄固定集/分组，单个超限文件本轮不支持片段摘要。查询原文视图按各文件开头的连续块轮转，最多8KiB/96行，所有缺口明确；它不是按问题优化的检索基线。两视图渲染≤10KiB，声明与引文作为整体保留或省略。

摘要保存在`.code-intelligence/semantic-overviews.json`，最多256KiB；复用基础快照身份、宿主版本、生成器id和规范分组。首次基础向量准备的成本仍存在，不是独立纯摘要部署。变更原文须先显式重建基础索引，再`prepareSemanticOverviews(..., { cwd, rebuild: true })`；仅改分组/生成器id也要求显式重建摘要。查询拒绝缺失/损坏/过期摘要，不自动生成；source视图只依赖有效基础快照。准备/查询前后复核版本、拒绝缓存链接、使用宿主版本守卫原子写，不是原子仓库快照或哈希校验。

准备结果区分created/rebuilt/reused，报告本次回调数、JSON输入/输出字节、reported Token/requests及未知回调数，`storedCosts`保留原构建记录；暖复用与查询本次回调0。字节不等于Token，适配器添加的prompt/transport成本须自行准确报告。失败/取消不发布半成品，已花请求成本不能因未返回准备结果而丢弃；适配器须自行记账并响应取消。准备有120秒组合取消，但插件不能强制终止忽略signal的外部工作。不内置生成模型、下载、网络客户端或外部实验预算。

已完成受控生命周期验证及一次真实模型的四节点生成/跨进程暖复用（2026-10-16，DeepSeek Flash/high，输出上限16384）；源码审计仍发现引文不足，真实摘要质量、维护成本和完整Agent收益尚未通过验收。`overviews`不配置时不注册工具或触发生成。

### `ci_batch_definitions`：前置批量定义导航

```json
{"queries": [{"file_path": "src/consumer.ts", "line": 18, "symbol": "createSession"}]}
```

示例仅展示参数格式，实际须取自已经看到的 `.ts` 引用标识符。优先提供 `line + symbol`，AST 只选择该行唯一精确标识符，忽略注释/字符串；零命中或重名返回未解决及有界候选，不猜列号。旧 `line + character` 仍支持，列从1开始按UTF-16计算；`symbol` 与 `character` 必须二选一。可用 `expected_symbol` 检查光标实际标识符，不匹配仅跳过该项，不移动光标或丢弃其他成功项。

路径可为工作区内相对或绝对路径。已有源码足以证明所问身份、种类和位置时直接作答，包括简单同文件声明；不为额外确认而导航或hover。只有请求的绑定或短链事实仍未证，才以本工具替代目标read，一次提交1–8个已见引用。**入口中一个外层使用点就足够开始；不必先找齐所有角色的名称、目标文件或内部光标。** 对未证事实先提交入口已见锚点，让工具补内部使用点；1–8是容量，不是完整性要求。不要为收集四个角色而先read导入文件/基类/目标实现；同一规范路径的完全相同坐标去重。

省略 `definition_only` 或设为 `false` 时，自动在真实定义目标中选择唯一受支持的局部语法关系，再通过宿主LSP确认下级绑定，最多两层、四个内部续查记录。支持调用参数回调内的 `new`、直接 `return this` 调用、构造器字段赋值右侧调用、局部数组初始化中的裸函数调用；类目标可选择唯一有体构造器。多个关系、调用位置或目标函数体时止步报告，不猜选。只需要当前即时定义时设置 `definition_only: true`；题目要求内部绑定时省略该字段。

模型工具协议已移除 `follow` 参数：旧 `follow: []` 调用迁为 `definition_only: true`；旧显式选择器不再是模型参数。底层有界引擎未变；缺口允许在结果返回后用已见内部锚点继续查询，而不是在调用前先读齐目标。比如入口构造调用可返回构造器字段赋值中的调用，再返回对应字段体的数组裸调用；无需先打开目标文件取得这两个内部光标。

超限错误`file_too_large`给出实际字节、上限及`retryable=false`；改写相对/绝对路径、光标或`definition_only`不能解决同文件超限。复用已有证据，只有事实仍未证才用可见原生LSP或有界grep/read。`source_budget_exhausted`表示调用内预算不足；非普通文件与无效大小分别报告，不再合并为含糊文件错误。工具没有自动回退或放宽上限。

每输入最多 3 个目标；单文件读取最多 64 KiB、总读取 384 KiB；每目标普通窗口最多 17 行，可补充成员签名和容器头（每段最多 12 行）；整次最多 96 个唯一源码行，单行最多 240 字符，渲染最多 12,000 UTF-8 字节。调用内共享同文件版本的重叠源码，保留每个使用点到全部有界目标的映射。返回精确目标坐标、支持的语法元数据及编号源码；外部目标不读取，错误、空结果、省略和截断明确标记。`unknown` 表示没有匹配的受支持语法元数据，不表示没有定义。 批量工具额外识别精确位置上的 constructor、标识符名称的类方法/字段与接口方法/属性签名，并提供命名类或接口的必要容器头；这不扩大默认声明搜索工具的覆盖。共享证据块分别说明源码行预算和渲染缺口，完整的有界窗口不代表完整声明或行为。

结果还提供光标处的 `sourceSymbol` 和语法角色 `sourceRole`（`declaration/reference/unknown`）；不支持的角色保持未知。目标 `relation=self` 表示同文件目标范围包含输入光标，`definition` 表示其他目标范围。`line/character` 保留服务器目标坐标，`declarationLine/declarationCharacter` 标明语法声明起点，避免把箭头初始化位置当字段声明起点。内部项带 `depth/parentQuery/rootIndex`，保留实际下级使用点映射和续查停止原因。声明点查询不能代替另一个使用点的绑定证明；语法分类不代表运行时关系。`kind=unknown` 仅是语法缺口，只在题目仍需要该事实且已有源码不足时补读。

适用顺序是：读取入口→立刻提交已见外层锚点（内部角色尚未知也可调用）→批量LSP及内部续查替代目标 `read`→证据足够则作答。定位后允许 `grep` 或局部 `read` 补未解决绑定、不支持语法、截断或额外行为；不把定位工具作为读齐后的确认步骤。它是按证据缺口生成的软指导，产品不实施实验中的阅读阶段硬拒绝；宿主管理普通阅读和任务资源。没有跨调用缓存或阅读历史去重，源码版本复核也不构成原子LSP快照。

## 已验证与限制

2026-10-14按用户授权继续修改主插件：入口外层锚点立即导航指导、`definition_only`接口、精简渲染与可关闭声明AST已合入；默认前置LSP仍关闭。指导仍为软提示，无普通read拦截。动态预算分离属于宿主/评测接入，插件不自行管理任务预算。本轮类型检查/build、六成功本地场景17实际LSP、schema预拒绝/服务与配置降级通过；MT真实前后各一次，新版入口read→两入口根及两内部绑定→答案，无普通目标read。Token33283→14193（−57.4%）、请求5→3，两版所需身份/绑定均4/4，后端定义仍各4次；旧版有构造器附加措辞的严格失分。两组均隐藏声明AST、预算独立、无阅读顺序硬守卫。该单题组合结果尚不证明其他任务稳定采用或某句提示独立收益。

前置LSP初版为提交 `f827943`。2026-10-14按用户授权合入行符号输入、精确声明起点及有界内部续查，工具指导在上述条件下替代常规read；`enablePrecedingLsp`仍默认关闭。调用内源码合并、工作区/版本/取消边界沿用，未加入额外依赖或自建语言服务器。

较早行符号/续查版本合入已通过类型检查/build、真实官方Harness的输入/输出schema与渲染链路、两题八个使用点绑定；20个定向实际场景共52次宿主LSP查询覆盖两种输入、显式/关闭续查、重复项、不匹配/歧义及部分成功保留、混合输入预拒绝和取消，另核对注释/字符串排除及UTF-16列号。缺LSP服务不注册、有服务缺provider如实报错、隐藏工具不留下前置/协同提示均通过；未重复旧版全部版本变化/外部URI/渲染压力边界。

合入前的同引擎前置方法实验为两已见题各一次：LSP/AST/文本分别31447/64635/30844Token、6/10/7请求，所需身份均8/8，LSP严格2/2。LSP均只读入口后一次批量续查即可作答，目标普通read和读后确认均0；相对文本继承题少12.6%、计时题多21.7%，合计多2.0%。文本计时题未用grep，Prompt和实验守卫也与自然采用不同，不能声称稳定成本收益；这些数字仅对应合入前冻结协议。

随后当前产品描述/自身Prompt原样的KV/MT真实模型测试完成，两题都先read入口再用插件batch，无阅读顺序守卫，保留默认AST与宿主原生LSP可见。48026Token/7请求、所需身份8/8、严格2/2；KV自动内部续查后直接答，MT显式follow:[]关闭续查后整文件补读。未出现读后导航确认，但自动续查和目标阅读替代尚未稳定采用；没有同步对照，不从跨轮成本推断单独代码或提示收益。

较早四格同题原生对照中，插件/原生分别69704/39733Token、9/8请求，所需实际绑定及身份均8/8，严格1/2、2/2。插件贵75.4%：KV仍先读齐后batch，返回68行全已读；MT避免目标普通read却手动三批导航，所有follow均[]，内部续查0。原生两题都在读齐后同一轮提交四定义查询。插件MT将箭头目标40:12/69:12误当字段名起点（实际均第3列）。原生组完全无插件，插件默认AST虽未采用仍增加协议；各格一次、自然采用和路径不同，只证明本轮整套接入未优于原生，不作纯后端或稳定收益结论。

2026-10-13，上一轮冻结的证据密度版与旧输出版、文本+AST进行同轮对照：两个已见题、每组各一次，Flash/high。以下结果对应上一轮冻结版本。

| 组别 | 所需目标身份 | 严格完整答案 | 总 Token | 请求数 |
| --- | --- | --- | --- | --- |
| BASE 文本工具 + AST | 8/8 | 2/2 | 38,109 | 6 |
| OLD 旧批量输出 + 原生 LSP | 8/8 | 1/2 | 64,571 | 8 |
| NEW 新证据输出 + 原生 LSP | 8/8 | 2/2 | 60,945 | 9 |

NEW相对OLD少5.6%，但比BASE多59.9%。NEW在KS题未调用批量工具，MB的读取顺序和光标选择在工具返回前已与OLD分化，不能把总差值归因为输出优化。NEW/MB返回69行，其中65行此前read已展示；调用内去重不能解决跨调用重复。OLD严格失分是附加工具表述错误，所需身份仍正确。

六格共23请求/163,625 Token。固定同光标本地比较证明重复源码减少，但新增映射/缺口说明令渲染字节略增，尚不证明稳定Agent成本或严格正确率提升。小样本、有候选路径、已见题且基线含AST，不能称纯rg或外推其他语言。可选功能继续默认关闭；总Token包含缓存读取，不等于现金费用。

同日后续绑定证据协议对照六格完成，共20请求/137,585 Token：文本+AST／修改前／修改后分别32,527／49,598／55,460 Token，请求6／7／7，所需身份均8/8，严格答案1/2、2/2、2/2。该轮新版较修改前贵11.8%、较文本+AST贵70.5%。MB从8个查询降到4个，少先读一个目标文件，Token下降6.3%；KS仍先读四文件再确认，Token增加32.0%，返回74行中73行已读。BASE严格失分为附加源列落在new关键字，所需身份正确；该轮未证明减少“读齐后确认”或整体成本收益，不据此称服务正确率提升，默认关闭。

六题十二格扩大对照（2026-10-14，当前前置LSP/原生四工具各一次）全部完成196340Token/42请求：插件83226/18 vs原生113114/24，合计少26.4%，六题都更低；必要身份均24/24，插件严格6/6、原生3/6（宽口径5/6）。五插件题只read入口后一batch作答；MT插件格未采用LSP，读两文件后直接答，不能把它的费用下降归因内部续查。所需真实映射20/23、后端查询21/23（MA多一无关外部Error续查）；跨入口目标先read后查0/14 vs11/18，同入口声明天然已见单列。grep/glob均未采用；两公开TS仓库、已见题各一次、声明AST关闭，无阅读硬守卫/强迫调用，仍不称通用稳定收益或据此默认启用。详细口径见本地 `docs/evaluation/lsp-entry-native-expanded/report.md`；主源码/构建本轮未改。

## 开发资料

- [AGENTS.md](AGENTS.md)：工作范围、验证与版本管理约定。
- [src/index.ts](src/index.ts)：唯一插件入口，只导出 `name`、`inject`、`apply`。
- `src/tools/`：模型可见参数、输出、渲染和提示。
- `src/search/`：候选发现、词法检索及结果整理。
- `src/ast/`：独立的 TypeScript 语法解析。
- `src/lsp/`：宿主文件/LSP 服务适配及有界查询。

本地 `docs/design/redevelopment-plan.md` 为总体设计入口；评测资料按实验存于 `docs/evaluation/`，新入口锚点合入验证为 `lsp-entry-anchor-integration/`，最新插件/原生六题对照为 `lsp-entry-native-expanded/`，入口指导模型对照为 `lsp-entry-anchor-small/`，前一插件/原生预算分离对照为 `lsp-continuation-budget-small/`，产品单组测试为 `lsp-plugin-agent-postmerge/`，前置方法对照为 `lsp-preceding-methods/`，合入验证为 `lsp-preceding-integration/`（初版运行时验证见 `lsp-preceding-plugin/`）。这些资料以及 `HANDOFF.md`、旧归档、上游检出和生成物均不跟踪到 Git，干净检出不保证包含它们。

文档改动只需内容、链接和差异检查；行为改动先做最小相关静态检查，再按风险使用现有命令或实际运行。默认不新增测试文件。

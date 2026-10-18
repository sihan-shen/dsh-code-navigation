import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchSemanticContext } from '../search/semantic-context-search.js'
import type { SemanticContextResult } from '../search/semantic-context-search.js'
import { encoder, resolveConfig } from '../semantic/types.js'
import type { SemanticIndexConfig } from '../semantic/types.js'

export function renderSemanticContext(value: SemanticContextResult): string {
  const parts = [`Semantic candidates from fixed snapshot ${value.indexCreatedAt}; ${value.candidateChunks} scoped chunks, ${value.hits.length} ranked hits. Similarity is not a binding, call relation or completeness proof. AST metadata is syntactic; source ranges can omit surrounding behavior. Document embeddings: 0; query embeddings: ${value.queryEmbeddings}.`]
  let bytes = encoder.encode(parts[0]).byteLength, omitted = 0
  function append(text: string): void {
    const size = encoder.encode(text).byteLength + 1
    if (bytes + size + 256 > 10 * 1024) { omitted++; return }
    parts.push(text); bytes += size
  }
  // 先保留全部有界命中映射，源码及 AST 细节可按渲染余量明确省略。
  for (const hit of value.hits) {
    append(`Hit ${hit.path}:${hit.startLine}-${hit.endLine}; cosine=${hit.score.toFixed(4)}; source in deduplicated blocks below, subject to omissions.`)
  }
  for (const ref of value.relations) append(`Reference ${ref.path}:${ref.line}:${ref.character}-${ref.endCharacter} -> ${ref.targetId}; syntax=${ref.role}; container=${ref.containerId || '(file)'}; binding from prepared LSP findReferences, not runtime execution or unique overload implementation.`)
  for (const fragment of value.fragments) append(`\n${fragment.path}:${fragment.startLine}-${fragment.endLine}\n${fragment.text.split('\n')
    .map((line, i) => `${fragment.startLine + i} | ${line}`).join('\n')}`)
  for (const hit of value.hits) {
    for (const node of hit.declarations) append(`AST ${node.kind} ${node.name} at ${hit.path}:${node.line}:${node.character}; declaration lines ${node.startLine}-${node.endLine}; nearest supported parent=${node.parentId || '(file)'}.`)
  }
  for (const reason of value.limits) append(`Partial: ${reason}`)
  if (omitted) parts.push(`Rendering budget: ${omitted} source blocks, hit mappings, AST entries or limitation details omitted; only displayed source is available.`)
  return parts.join('\n')
}

export function registerSemanticContextTool(ctx: Context, input: SemanticIndexConfig): void {
  const config = resolveConfig(input)
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({ name: 'tool:nav_search_semantic_context',
      order: scoped.systemPrompt.getSectionOrder('TOOL_GREP') + 2,
      text: ({ scope }) => scoped.tools.get('nav_search_semantic_context', scope) === undefined ? ''
        : 'Use nav_search_semantic_context for conceptual TS/JS implementation questions within the operator-prepared fixed file set, especially when literal terms are unknown. Reuse its numbered source; read only missing facts. Configured prepared one-hop references carry LSP binding and AST roles; argument is not a call, callee is not runtime execution. Similarity and AST containment do not prove calls or bindings; use visible LSP tools only for remaining semantic claims. An absent or stale index requires operator preparation, not repeated identical queries. Stop when the required facts are covered.',
    })
  })
  const position = { path: { type: 'string', required: true }, startLine: { type: 'integer', required: true },
    endLine: { type: 'integer', required: true } } as const
  ctx.tools.register(defineTool({
    name: 'nav_search_semantic_context',
    description: 'Retrieve bounded numbered TS/JS source for a natural-language concept from an explicitly prepared fixed-file semantic snapshot. Computes only the query embedding; never builds or updates document vectors. Optional path narrows this fixed set. Reuse returned source instead of reading it again; similarity ranks candidates and does not prove semantic relations or completeness. AST names/ranges/parent identities are syntax metadata only. Missing/stale/incompatible index requires the operator to run prepareSemanticIndex, with rebuild:true for changes; do not repeat unchanged calls. When relations are configured, also reads prepared one-hop incoming references whose declaration names occur in ranked chunks, within the same path and source budget. No query-time LSP. expand_relations:false keeps the candidate-only baseline; missing/stale relations require prepareSemanticRelations. Lexical search remains available separately.',
    parameters: {
      query: { type: 'string', required: true, description: 'Concept or behavior to locate, 1–1000 characters; the local embedding backend handles query instructions.' },
      path: { type: 'string', description: 'Workspace-relative file/directory within the fixed prepared set; default all prepared files.' },
      expand_relations: { type: 'boolean', description: 'Default true when operator configured prepared relations; false returns the same vector seeds without reference expansion. One hop only; path also bounds reference source.' },
      limit: { type: 'integer', description: 'Ranked chunk count, 1–6, default 4. Each chunk <=40 lines / 2 KiB; deduplicated source <=8 KiB.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      indexCreatedAt: { type: 'string', required: true }, embeddingId: { type: 'string', required: true },
      candidateChunks: { type: 'integer', required: true }, documentEmbeddings: { type: 'integer', required: true },
      queryEmbeddings: { type: 'integer', required: true }, elapsedMs: { type: 'number', required: true },
      embeddingMs: { type: 'number', required: true }, indexBytes: { type: 'integer', required: true },
      relationIndexCreatedAt: { type: 'string', required: true }, relationIndexBytes: { type: 'integer', required: true },
      lspQueries: { type: 'integer', required: true },
      relations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, sourceVersion: { type: 'string', required: true },
        targetId: { type: 'string', required: true }, targetVersion: { type: 'string', required: true },
        line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
        endCharacter: { type: 'integer', required: true }, role: { type: 'string', enum: ['callee', 'argument', 'other'], required: true },
        containerId: { type: 'string', required: true },
      } } },
      truncated: { type: 'boolean', required: true }, limits: { type: 'array', required: true, items: { type: 'string' } },
      fragments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
        properties: { ...position, text: { type: 'string', required: true } } } },
      hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        ...position, score: { type: 'number', required: true }, declarations: { type: 'array', required: true,
          items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true }, parentId: { type: 'string', required: true },
            name: { type: 'string', required: true }, kind: { type: 'string', required: true },
            line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
            startLine: { type: 'integer', required: true }, endLine: { type: 'integer', required: true },
          } } },
      } } },
    } }, render: (_args, value) => [{ type: 'text', text: renderSemanticContext(value) }] },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => searchSemanticContext(ctx.fs, config, args,
      { cwd: exec.agent?.session.header.cwd ?? '', signal: exec.signal }, config),
  }))
}

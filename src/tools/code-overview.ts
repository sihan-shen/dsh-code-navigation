import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getCodeOverview, overviewNodeHint } from '../search/code-overview.js'
import type { CodeOverviewResult } from '../search/code-overview.js'
import { resolveOverviewSetup } from '../semantic/overview-types.js'
import { encoder } from '../semantic/types.js'
import type { SemanticIndexConfig } from '../semantic/types.js'

export function renderCodeOverview(value: CodeOverviewResult): string {
  const parts = [`Overview ${value.nodeId}: ${value.label}; view=${value.view}; ${value.sourceFiles} fixed files. Base snapshot ${value.snapshotCreatedAt}. Generated summaries are navigation aids, not verified behavior or completeness proofs. Query generation/embedding/LSP calls: 0. Exact conditions and exceptions require cited source.`]
  let bytes = encoder.encode(parts[0]).byteLength, omitted = 0
  function append(text: string): void {
    const size = encoder.encode(text).byteLength + 1
    if (bytes + size + 160 > 10 * 1024) { omitted++; return }
    parts.push(text); bytes += size
  }
  for (const node of value.catalog) append(`Node ${node.id}: ${node.label}; ${node.sourceFiles} files; children=${node.children.join(',') || '(leaf)'}.`)
  if (value.view === 'summary') {
    const c = value.storedCosts
    append(`Prepared ${value.overviewCreatedAt}; generator=${value.generatorId}. Stored preparation cost for all nodes: reportedTokens=${c.reportedTokens}, requests=${c.reportedRequests}; unknownTokenCalls=${c.unknownTokenCalls}, unknownRequestCalls=${c.unknownRequestCalls}; callback JSON input/output bytes=${c.inputBytes}/${c.outputBytes}. Unknown usage is not zero. Adapter prompt/transport overhead is separate.`)
    // 声明与全部引文一起保留/省略，不留下无出处的半条生成结论。
    for (const claim of value.claims) append(`Generated claim: ${JSON.stringify(claim.text)}\nCitations (coordinate validity only): ${claim.evidence.map(ref => `${ref.path}:${ref.startLine}-${ref.endLine}`).join('; ')}`)
  }
  for (const fragment of value.fragments) append(`${fragment.path}:${fragment.startLine}-${fragment.endLine}\n${fragment.text.split('\n').map((line, i) => `${fragment.startLine + i} | ${line}`).join('\n')}`)
  for (const limit of value.limits) append(`Partial: ${limit}`)
  if (omitted) parts.push(`Rendering budget: ${omitted} catalog rows, complete claims, source blocks or limitations omitted; only displayed content is available.`)
  return parts.join('\n')
}

export function registerCodeOverviewTool(ctx: Context, input: SemanticIndexConfig): void {
  const setup = resolveOverviewSetup(input)
  const nodes = setup.nodes.map(node => Object.freeze({ id: node.id, label: node.label,
    ...(node.children.length ? { children: node.children } : { files: node.files }) }))
  const config = { ...setup.semantic, overviews: Object.freeze({ generator: setup.generator, nodes: Object.freeze(nodes) }) }
  const nodeIds = setup.nodes.map(node => node.id), nodeHint = overviewNodeHint(setup)
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({ name: 'tool:ci_get_code_overview', order: scoped.systemPrompt.getSectionOrder('TOOL_GREP') + 3,
      text: ({ scope }) => scoped.tools.get('ci_get_code_overview', scope) === undefined ? ''
        : 'Use ci_get_code_overview for an operator-prepared subsystem map when an overall responsibilities/region overview is needed. Omit node for the root/catalog, then select an explicit node if useful. Generated claims carry source pointers, not semantic proof; read cited missing conditions for exact behavior. Source view is bounded file-start sampling. Missing/stale summaries require operator preparation, not repeated identical calls. Reuse sufficient evidence and stop.',
    })
  })
  const string = { type: 'string' } as const, integer = { type: 'integer' } as const
  const range = { path: { ...string, required: true }, startLine: { ...integer, required: true }, endLine: { ...integer, required: true } } as const
  const uint = { ...integer, required: true } as const, text = { ...string, required: true } as const
  const costs = { generationCalls: uint, inputBytes: uint, outputBytes: uint, reportedTokens: uint,
    reportedRequests: uint, unknownTokenCalls: uint, unknownRequestCalls: uint }
  ctx.tools.register(defineTool({ name: 'ci_get_code_overview',
    description: 'Read an explicitly prepared subsystem overview and source citations. Use for overall responsibilities and where to inspect, not exact conditions or binding claims. No query-time model, embedding or LSP calls. Omit node for root and catalog. view:source reads bounded raw source without requiring summaries; it samples from file starts and can omit behavior. Missing/stale summary requires operator prepareSemanticOverviews (rebuild:true after changes); do not retry unchanged calls.',
    parameters: { node: { ...string, enum: nodeIds, description: `Exact configured node id. ${nodeHint}` },
      view: { ...string, enum: ['summary', 'source'], description: 'Default summary; source returns a bounded raw view of the same node file set.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      nodeId: text, label: text, view: { ...text, enum: ['summary', 'source'] }, snapshotCreatedAt: text,
      overviewCreatedAt: text, generatorId: text,
      sourceFiles: { ...integer, required: true }, generationCalls: { ...integer, required: true },
      storedCosts: { type: 'object', required: true, additionalProperties: false, properties: costs },
      catalog: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: { ...string, required: true }, label: { ...string, required: true }, sourceFiles: { ...integer, required: true },
        children: { type: 'array', required: true, items: string },
      } } },
      claims: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        text: { ...string, required: true }, evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: range } },
      } } },
      fragments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
        properties: { ...range, text: { ...string, required: true } } } },
      limits: { type: 'array', required: true, items: string },
    } }, render: (_args, value) => [{ type: 'text', text: renderCodeOverview(value) }] },
    timeoutMs: 30000, isConcurrencySafe: () => true,
    execute: (args, exec) => getCodeOverview(ctx.fs, config, args,
      { cwd: exec.agent?.session.header.cwd ?? '', signal: exec.signal }),
  }))
}

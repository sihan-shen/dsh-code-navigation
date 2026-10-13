import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-lsp'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DEFINITION_LIMITS, findBatchDefinitions } from '../lsp/batch-definitions.js'
import type { BatchDefinitions } from '../lsp/batch-definitions.js'

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength

function renderBatch(value: BatchDefinitions): string {
  const footer = (shown: number): string => `\nSource rows shown ${shown}/${value.sourceRows}; repeated target windows shared; omitted targets ${value.omittedTargets}. Context is a bounded current-text window, not full declaration body or an atomic LSP snapshot. Variables with function types are not function/arrow declarations. Query indices label inputs, not task/question roles. Unknown metadata needs source verification; a window may omit its enclosing declaration. Read only missing/truncated evidence.`
  // Reserve the entire footer before source rows; count UTF-8 bytes, not JS characters.
  const contentLimit = DEFINITION_LIMITS.renderBytes - utf8Bytes(footer(value.sourceRows))
  const headers = [`Batch definitions: ${value.items.length} inputs, ${value.lspQueries} LSP queries. Names/kinds are syntax metadata at exact LSP targets; unknown means no matching supported declaration.`]
  for (const item of value.items) {
    headers.push(`[Query ${item.index + 1}] ${item.path}:${item.line}:${item.character} ${item.status}${item.duplicateOf >= 0 ? ` of query ${item.duplicateOf + 1}` : ''}${item.error ? ' ' + item.error : ''}; omitted targets ${item.omitted}`)
    for (const target of item.targets) {
      headers.push(` -> ${target.path}:${target.line}:${target.character} name=${target.name || 'unknown'} kind=${target.kind}${target.container ? ' in ' + target.container : ''}`)
    }
  }
  let text = headers.join('\n'), shown = 0
  if (utf8Bytes(text) > contentLimit) throw new Error('Metadata render budget exceeded')
  const contexts = new Set<string>()
  for (const item of value.items) for (const target of item.targets) {
    const key = `${target.path}:${target.line}`
    if (contexts.has(key)) continue
    const label = `\nContext ${target.path}:${target.line}; hash ${target.sha256}; ${target.contextComplete ? 'window complete' : 'source row budget truncated'}`
    if (utf8Bytes(text + label) > contentLimit) continue
    contexts.add(key); text += label
    for (const line of target.lines) {
      const row = `\n${line.line}: ${line.text}${line.truncated ? ' [line truncated]' : ''}`
      if (utf8Bytes(text + row) > contentLimit) continue
      text += row; shown++
    }
  }
  text += footer(shown)
  if (utf8Bytes(text) > DEFINITION_LIMITS.renderBytes) throw new Error('Render limit exceeded')
  return text
}
const cursorSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    file_path: { type: 'string', required: true },
    line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
  },
} as const
const rowSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true }, text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
  },
} as const
const targetSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    path: { type: 'string', required: true }, uri: { type: 'string', required: true },
    line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
    name: { type: 'string', required: true }, kind: { type: 'string', required: true },
    container: { type: 'string', required: true }, sha256: { type: 'string', required: true },
    lines: { type: 'array', required: true, items: rowSchema },
    contextComplete: { type: 'boolean', required: true },
  },
} as const
const itemSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true }, path: { type: 'string', required: true },
    line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
    status: { type: 'string', required: true, enum: ['ok', 'empty', 'duplicate', 'error', 'partial', 'unavailable'] },
    duplicateOf: { type: 'integer', required: true },
    targets: { type: 'array', required: true, items: targetSchema },
    omitted: { type: 'integer', required: true }, error: { type: 'string', required: true },
  },
} as const

export function registerBatchDefinitionsTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ci_batch_definitions',
    description: 'Resolve 1–8 already-visible .ts use-site cursors together when actual symbol bindings remain uncertain. Put independent ready references in one queries array. Returns source-to-definition coordinates, exact supported syntax metadata and bounded current source in ONE result. Same exact cursors are deduplicated. Query indices label inputs, not question roles. If evidence is sufficient, answer without redundant navigation or hover; read only missing/truncated context or an omitted enclosing declaration. Empty, errors, external/omitted targets and unknown metadata stay explicit; unknown is not a declaration kind or proof of no target. One-based UTF-16 coordinates. Max 3 targets per cursor, 96 source rows/12000 rendered bytes overall; not full behavior or call hierarchy.',
    parameters: {
      queries: { type: 'array', required: true, description: '1–8 already-visible .ts reference cursors within the Session workspace; file_path may be relative or absolute, coordinates one-based UTF-16.', items: cursorSchema },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        items: { type: 'array', required: true, items: itemSchema },
        lspQueries: { type: 'integer', required: true }, bytesRead: { type: 'integer', required: true },
        sourceRows: { type: 'integer', required: true }, omittedTargets: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: renderBatch(value) }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => findBatchDefinitions(ctx.fs, ctx.lsp, args, exec),
  }))
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({
      name: 'tool:ci_preceding_lsp', order: scoped.systemPrompt.getSectionOrder('TOOL_LSP') + 1,
      text: ({ scope }) => {
        if (scoped.tools.get('ci_batch_definitions', scope) === undefined) return ''
        const parts = ['For read-only symbol-binding investigations, prefer early ci_batch_definitions after small locating reads. Prepare exact visible import/call/extends cursors in at most two small locating windows before the first needed navigation; avoid reading whole target files merely to prepare queries. Batch independent ready cursors together. Reuse resolved metadata and numbered source; read only missing kinds, truncated windows or enclosing declarations. Do not use fragment starts as cursors or query indices as question labels.']
        if (scoped.tools.get('lsp', scope) !== undefined) parts.push('Preserve native lsp for references, implementation or an actually unresolved type.')
        parts.push('If existing evidence already proves the requested claims, answer directly; do not force a navigation sequence or repeat successful bindings.')
        return parts.join(' ')
      },
    })
  })
}

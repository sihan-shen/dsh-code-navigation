import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-lsp'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DEFINITION_LIMITS, findBatchDefinitions } from '../lsp/batch-definitions.js'
import type { BatchDefinitions } from '../lsp/batch-definitions.js'

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength

function renderBatch(value: BatchDefinitions): string {
  const groups = new Map<string, { id: string; path: string; hash: string; essential: Set<number>; rows: Map<number, { line: number; text: string; truncated: boolean }> }>()
  const evidenceFor = (target: BatchDefinitions['items'][number]['targets'][number]): string => {
    const key = JSON.stringify([target.path, target.sha256])
    let group = groups.get(key)
    if (!group) {
      group = { id: `E${groups.size + 1}`, path: target.path, hash: target.sha256, essential: new Set(), rows: new Map() }
      groups.set(key, group)
    }
    for (const n of target.evidenceRows) group.essential.add(n)
    for (const row of target.lines) group.rows.set(row.line, row)
    return group.id
  }
  const blocks = value.items.map(item => {
    const role = item.sourceRole === 'declaration' ? 'DECLARATION' : item.sourceRole === 'reference' ? 'USE' : 'CURSOR'
    const symbol = item.sourceSymbol.length > 120 ? item.sourceSymbol.slice(0, 117) + '...' : item.sourceSymbol || 'unknown'
    const origin = item.depth ? ` INTERNAL depth=${item.depth} from query ${item.parentQuery + 1} target=${item.parentTarget}` : ''
    const headers = [`[Query ${item.index + 1}] ${role} ${item.path}:${item.line}:${item.character} symbol=${symbol} ${item.status}${origin}${item.duplicateOf >= 0 ? ` of query ${item.duplicateOf + 1}` : ''}${item.error ? ' ' + item.error : ''}${item.omitted ? '; omitted targets ' + item.omitted : ''}`]
    if (item.routeNote) headers.push(`Route root ${item.rootIndex + 1}: ${item.routeStatus}; ${item.routeNote}`)
    if (item.status === 'mismatch') headers.push(`Actual source ${item.path}:${item.line}: ${item.sourceText}`)
    if (item.candidates.length && item.routeStatus === 'stopped') headers.push('Unresolved syntax candidates: ' + item.candidates.map(c => `${c.file_path}:${c.line}:${c.character} ${c.name}`).join('; '))
    if (item.sourceRole === 'declaration') headers.push('Evidence: queried a declaration; this does not verify a separate use-site binding.')
    else if (item.sourceRole === 'unknown') headers.push('Evidence: reference role unclassified at this cursor; do not treat a result as proof for another use site.')
    const ids: string[] = []
    for (const target of item.targets) {
      const id = evidenceFor(target)
      ids.push(id)
      headers.push(` -> ${target.name || 'unknown'} (${target.kind}) DECLARATION ${target.path}:${target.declarationLine}:${target.declarationCharacter}${target.container ? ' in ' + target.container : ''}; ${target.relation}; ${id}${target.line !== target.declarationLine || target.character !== target.declarationCharacter ? '; LSP location ' + target.line + ':' + target.character + ' (raw server coordinate; not a name-start claim)' : ''}${target.contextComplete ? '' : '; source row budget truncated'}${target.evidenceNotes.length ? '; ' + target.evidenceNotes.join('; ') : ''}`)
    }
    return { headers, ids: [...new Set(ids)] }
  })
  const intro = `Definitions: ${value.items.filter(i => i.depth === 0).length} roots, ${value.items.filter(i => i.depth > 0).length} internal cursors, ${value.lspQueries} LSP queries. Coordinates one-based; DECLARATION means syntax start, not necessarily identifier start. Unknown kind is a syntax gap.`
  const labels = new Map([...groups.values()].map(g => [g.id, `Evidence ${g.id}: ${g.path}; rows shared in this call; gaps omitted; rendered 96/96; render budget truncated`]))
  const footer = (shown: number): string => `\nSource rows ${shown}/${value.sourceRows}; omitted targets ${value.omittedTargets}. Bounded text, not full behavior or atomic LSP snapshot. Static mappings do not prove runtime dispatch; query numbers are not task roles. Use sufficient evidence directly; read only requested gaps. Arrow fields differ from methods; function-typed class fields are properties, not interface signatures.`
  // Reserve ALL mappings, notes, evidence labels and footer before nearby source.
  const reserved = utf8Bytes([intro, ...blocks.flatMap(b => b.headers), ...labels.values()].join('\n') + footer(value.sourceRows))
  if (reserved > DEFINITION_LIMITS.renderBytes) throw new Error('Metadata render budget exceeded')
  let remaining = DEFINITION_LIMITS.renderBytes - reserved, text = intro, shown = 0
  const planned = new Map<string, { line: number; row: string }[]>()
  // All targets' exact/member/container evidence precedes any ordinary window rows.
  for (const essential of [true, false]) for (const group of groups.values()) {
    const rendered = planned.get(group.id) ?? []
    planned.set(group.id, rendered)
    for (const line of [...group.rows.values()].sort((a, b) => a.line - b.line)) {
      if (group.essential.has(line.line) !== essential) continue
      const row = `\n${line.line}: ${line.text}${line.truncated ? ' [line truncated]' : ''}`
      const bytes = utf8Bytes(row)
      if (bytes > remaining) continue
      remaining -= bytes; rendered.push({ line: line.line, row }); shown++
    }
  }
  const emitted = new Set<string>()
  for (const block of blocks) {
    text += '\n' + block.headers.join('\n')
    for (const id of block.ids) {
      if (emitted.has(id)) continue
      emitted.add(id)
      const group = [...groups.values()].find(g => g.id === id)!
      const rendered = planned.get(id)!
      const rows = [...group.rows.values()]
      text += '\n' + labels.get(id)!.replace('rendered 96/96; render budget truncated',
        `rendered ${rendered.length}/${rows.length}; ${rendered.length === rows.length ? 'render complete' : 'render budget truncated'}`)
      text += rendered.sort((a, b) => a.line - b.line).map(r => r.row).join('')
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
    expected_symbol: { type: 'string', description: 'Optional actual identifier name from visible source; mismatch skips only this cursor without moving it.' },
    definition_only: { type: 'boolean', description: 'Set true only when the task needs this immediate definition and no linked internal binding. Omit for questions asking a constructor assignment, callback construction, returned call or array-initializer call: bounded continuation is automatic.' },
    symbol: { type: 'string', description: 'Preferred: exact visible identifier text on the specified line; AST selects only one match. Omit character. Comments/strings are not identifier matches; zero/multiple matches skip this query. No automatic correction of cursor mode.' },
    line: { type: 'integer', required: true }, character: { type: 'integer', description: 'Exact one-based UTF-16 cursor mode; omit symbol. Never shifted to match expected_symbol.' },
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
    declarationLine: { type: 'integer', required: true }, declarationCharacter: { type: 'integer', required: true },
    path: { type: 'string', required: true }, uri: { type: 'string', required: true },
    line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
    name: { type: 'string', required: true }, kind: { type: 'string', required: true },
    container: { type: 'string', required: true }, sha256: { type: 'string', required: true },
    lines: { type: 'array', required: true, items: rowSchema },
    contextComplete: { type: 'boolean', required: true },
    evidenceRows: { type: 'array', required: true, items: { type: 'integer' } },
    evidenceNotes: { type: 'array', required: true, items: { type: 'string' } },
    relation: { type: 'string', required: true, enum: ['self', 'definition'] },
  },
} as const
const itemSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    rootIndex: { type: 'integer', required: true }, routeStatus: { type: 'string', required: true }, routeNote: { type: 'string', required: true }, sourceText: { type: 'string', required: true },
    candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { file_path: { type: 'string', required: true }, line: { type: 'integer', required: true }, character: { type: 'integer', required: true }, name: { type: 'string', required: true } } } },
    depth: { type: 'integer', required: true }, parentQuery: { type: 'integer', required: true }, parentTarget: { type: 'string', required: true },
    index: { type: 'integer', required: true }, path: { type: 'string', required: true },
    line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
    sourceSymbol: { type: 'string', required: true },
    sourceRole: { type: 'string', required: true, enum: ['declaration', 'reference', 'unknown'] },
    status: { type: 'string', required: true, enum: ['ok', 'empty', 'duplicate', 'error', 'partial', 'unavailable', 'mismatch', 'ambiguous', 'not-found'] },
    duplicateOf: { type: 'integer', required: true },
    targets: { type: 'array', required: true, items: targetSchema },
    omitted: { type: 'integer', required: true }, error: { type: 'string', required: true },
  },
} as const

export function registerBatchDefinitionsTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ci_batch_definitions',
    description: "Replace target-file read ONLY when a requested static binding or supported short linked fact remains unresolved. If visible source already proves the requested identity, kind and location, answer directly; do not navigate just to confirm it. For a missing binding, submit an available .ts outer use with line+symbol; downstream names/files/anchors may remain unknown. Do not read targets to collect every role first; 1–8 is capacity. Unique callback new, returned this call, constructor assignment call or array-initializer call can continue up to two layers/four internal cursors. Set definition_only=true for immediate definitions; omit for linked facts. Reuse mappings and numbered source; grep/read only missing facts. Report requested facts and verified coordinates, without extra audit. Exact one-based UTF-16 character is an alternative to symbol; expected_symbol never shifts it. Sources must be workspace .ts files <=64 KiB, total read <=384 KiB; at most 3 targets/cursor, 96 unique rows/12000 UTF-8 bytes. file_too_large is not fixed by path/cursor changes: reuse evidence or use native lsp if available/focused read for the remaining claim. Static definitions do not prove runtime dispatch.",
    parameters: {
      queries: { type: 'array', required: true, description: '1–8 visible .ts outer uses for still-unresolved requested bindings; one root is valid. Downstream anchors need not be known. Session workspace paths may be relative or absolute; one-based UTF-16.', items: cursorSchema },
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
    execute: (args, exec) => findBatchDefinitions(ctx.fs, ctx.lsp, { queries: args.queries.map(({ definition_only, ...q }) => ({ ...q, follow: definition_only ? [] : undefined })) }, exec),
  }))
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({
      name: 'tool:ci_preceding_lsp', order: scoped.systemPrompt.getSectionOrder('TOOL_LSP') + 1,
      text: ({ scope }) => {
        if (scoped.tools.get('ci_batch_definitions', scope) === undefined) return ''
        const parts = ["Before each tool call, identify the requested fact still missing. If visible source already proves the requested identities, kinds and locations, answer now, including simple same-file declarations; no navigation or hover is required for reassurance. Otherwise ci_batch_definitions replaces target-file read for unresolved .ts bindings or supported short linked facts. Send available entry outer uses without first reading targets to find all roles; one root is valid and downstream anchors may be unknown. Omit definition_only for linked facts. Reuse returned mappings/source; another import, alternate use or target read is justified only by a still-unresolved requested binding. Unsupported/omitted facts may need focused grep/read. On file_too_large, changing path/cursor cannot help; keep existing evidence and switch method only for a remaining claim. Stop once the requested facts are supported; report only those facts and verified coordinates. Declaration/self is not another use, query numbers are not task roles, and static definitions do not prove runtime dispatch."]
        if (scoped.tools.get('lsp', scope) !== undefined) parts.push('Native lsp remains available for an unresolved binding when batch cannot process the source, or for requested references/implementation/type; use an exact visible identifier position, not a fragment start.')
        return parts.join(' ')
      },
    })
  })
}

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchCodeContext } from '../search/code-context-search.js'
import type { ContextResult } from '../search/code-context-search.js'

export function renderCodeContext(value: ContextResult): string {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength
  const parts = [`Lexical candidates only; ${value.matchesFound} matched lines in ${value.candidateFiles} files; read ${value.filesRead} files / ${value.bytesRead} bytes. Selected ${value.fragments.length} source fragments; only displayed fragments below are available. Declaration-context pieces jointly cover their stated context range; lexical windows may omit enclosing behavior. ${value.truncated ? `Partial coverage: ${value.limits.join('; ')}.` : 'All search candidates processed.'}`]
  let omitted = 0
  const groups = new Map<string, ContextResult['fragments']>()
  for (const fragment of value.fragments) {
    const key = `${fragment.path}:${fragment.contextStartLine}:${fragment.contextEndLine}`
    const group = groups.get(key) ?? []
    group.push(fragment); groups.set(key, group)
  }
  for (const group of groups.values()) {
    const text = group.map(fragment => `\n${fragment.path}:${fragment.startLine}-${fragment.endLine} [${fragment.source}; associated context ${fragment.contextStartLine}-${fragment.contextEndLine}; terms: ${fragment.matchedTerms.join(', ')}]\n${fragment.text.split('\n').map((line, i) => `${fragment.startLine + i} | ${line}`).join('\n')}`).join('\n')
    // Rendering must not separate a declaration's associated pieces either.
    if (bytes(parts.join('\n')) + bytes(text) + 256 > 10 * 1024) { omitted += group.length; continue }
    parts.push(text)
  }
  let skippedShown = 0
  for (const item of value.skipped) {
    const text = `Skipped ${item.path}: ${item.reason}`
    if (bytes(parts.join('\n')) + bytes(text) + 256 > 10 * 1024) break
    parts.push(text)
    skippedShown++
  }
  if (omitted || skippedShown < value.skipped.length) parts.push(`Rendering budget: ${omitted} source fragments and ${value.skipped.length - skippedShown} skipped-file details omitted.`)
  return parts.join('\n')
}

export function registerSearchContextTool(ctx: Context): void {
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({
      name: 'tool:ci_search_context', order: scoped.systemPrompt.getSectionOrder('TOOL_GREP') + 1,
      text: ({ scope }) => scoped.tools.get('ci_search_context', scope) === undefined ? ''
        : 'When literal TS/JS search needs surrounding implementation source, use ci_search_context instead of separate grep plus ordinary read of matching files. Returned numbered source replaces those reads; use grep alone for match lists. Supply literal code terms and narrow path when known. Reuse numbered fragments, reading only missing branches or dependencies. Use available declaration or native LSP tools only for unresolved identity, type or relationship questions. Lexical candidates are not semantic proof. An unchanged empty query adds no evidence; refine it or stop when the required facts are covered.',
    })
  })
  ctx.tools.register(defineTool({
    name: 'ci_search_context',
    description: 'Replace separate grep plus ordinary read of matching TS/JS files when literal code terms and bounded surrounding implementation can answer the question. Returns numbered source in one call; use it directly and stop when sufficient, rather than reading those files again. Use 1–6 case-sensitive code terms; natural-language concepts are not translated. Prefer this for matching code with surrounding implementation; use grep for match lists alone. Keeps bounded function/method declarations and single named variable bindings with direct arrow/function expressions or immediate factory callbacks together. Syntax errors, unsupported bindings and oversized contexts fall back to lexical windows or are omitted. Reuse source already shown; read only missing ranges or dependencies. If declaration identity or coordinates are needed, pass confirmed fragment paths as files to ci_find_declarations when available; do not restart unscoped discovery. For unresolved cross-file targets, references or types, use native lsp when available at exact surviving symbol coordinates, not fragment start lines. Use selected declaration coordinates for references and call/import/extends coordinates for definition or hover. Partial coverage and lexical matches do not prove semantic completeness.',
    parameters: {
      terms: { type: 'array', required: true, items: { type: 'string' }, description: '1–6 literal code terms, each 2–64 characters with a letter or number; not regexes, case-sensitive; e.g. ["createSession", "signal"]. Chinese descriptions are not translated.' },
      path: { type: 'string', description: 'Optional workspace-relative path or absolute path within the Session workspace; omit to search the workspace. Outside paths are rejected.' },
      limit: { type: 'integer', description: 'Maximum fragments, 1–6; default 4. Each is at most 40 lines and 2 KiB; total source at most 8 KiB.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      matchesFound: { type: 'integer', required: true }, candidateFiles: { type: 'integer', required: true },
      filesRead: { type: 'integer', required: true }, bytesRead: { type: 'integer', required: true },
      truncated: { type: 'boolean', required: true }, limits: { type: 'array', required: true, items: { type: 'string' } },
      skipped: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, reason: { type: 'string', required: true },
      } } },
      fragments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, startLine: { type: 'integer', required: true }, endLine: { type: 'integer', required: true },
        text: { type: 'string', required: true }, source: { type: 'string', required: true, enum: ['lexical-window', 'declaration-context'] as const },
        contextStartLine: { type: 'integer', required: true }, contextEndLine: { type: 'integer', required: true },
        matchedTerms: { type: 'array', required: true, items: { type: 'string' } },
      } } },
    } }, render: (_args, value) => [{ type: 'text', text: renderCodeContext(value) }] },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => searchCodeContext(ctx.fs, ctx.tools, args, exec),
  }))
}

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchCodeContext } from '../search/code-context-search.js'
import type { ContextResult } from '../search/code-context-search.js'

export function renderCodeContext(value: ContextResult): string {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength
  const parts = [`Lexical candidates only; ${value.matchesFound} matched lines in ${value.candidateFiles} files; read ${value.filesRead} files / ${value.bytesRead} bytes. Returned ${value.fragments.length} source fragments. ${value.truncated ? `Partial coverage: ${value.limits.join('; ')}.` : 'All search candidates processed.'}`]
  let omitted = 0
  for (const fragment of value.fragments) {
    const text = `\n${fragment.path}:${fragment.startLine}-${fragment.endLine} [${fragment.source}; terms: ${fragment.matchedTerms.join(', ')}]\n${fragment.text}`
    if (bytes(parts.join('\n')) + bytes(text) + 256 > 10 * 1024) { omitted++; continue }
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
  ctx.tools.register(defineTool({
    name: 'ci_search_context',
    description: 'Find relevant TS/JS source context from literal terms when names or paths are unknown. Runs host grep once, then returns ranked, merged bounded source windows with file/line ranges. Use terms found in code (2–64 characters); Chinese descriptions are not translated. For exact declarations use ci_find_declarations; for literal text only use grep. Fragments are lexical candidates, not semantic relations. Check partial coverage and read only missing context. Does not index or generate an answer.',
    parameters: {
      terms: { type: 'array', required: true, items: { type: 'string' }, description: '1–6 literal code terms, not regexes; case-sensitive.' },
      path: { type: 'string', description: 'Optional workspace-relative file or directory; omit to search the Session workspace.' },
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
        text: { type: 'string', required: true }, source: { type: 'string', required: true, enum: ['lexical-window'] as const },
        matchedTerms: { type: 'array', required: true, items: { type: 'string' } },
      } } },
    } }, render: (_args, value) => [{ type: 'text', text: renderCodeContext(value) }] },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => searchCodeContext(ctx.fs, ctx.tools, args, exec),
  }))
}

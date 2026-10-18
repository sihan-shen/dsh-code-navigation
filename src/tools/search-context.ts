import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchCodeContext } from '../search/code-context-search.js'
import type { ContextResult } from '../search/code-context-search.js'
import type { SemanticIndexConfig } from '../semantic/types.js'

export function renderCodeContext(value: ContextResult): string {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength
  const parts = [`${value.usedVector ? 'Lexical + vector-seeded candidates' : 'Lexical candidates only'}; ${value.matchesFound} matched lines in ${value.candidateFiles} files; ${value.usedVector ? `${value.vectorHits} vector hits, ${value.queryEmbeddings} query embedding(s); ` : ''}read ${value.filesRead} files / ${value.bytesRead} bytes. Selected ${value.fragments.length} source fragments; only displayed fragments below are available. Declaration-context pieces jointly cover their stated context range; declaration-partial pieces keep a declaration head, hit neighborhood and omitted range, not the full body. Anchors use 1-based UTF-16 columns. Vector-seeded fragments remain lexical source reads, not semantic proof. ${value.truncated ? `Partial coverage: ${value.limits.join('; ')}.` : 'All search candidates processed.'}`]
  let used = bytes(parts[0])
  const coverage = value.terms.map(term => `${term.term}: ${term.selectedFragments} fragment(s)/${term.anchorFragments} anchor(s), ${term.matchedLines} line(s)/${term.matchedFiles} file(s)${term.omittedReason ? ` — ${term.omittedReason}` : ''}`).join('; ')
  if (coverage) {
    const text = `Term coverage: ${coverage}`
    if (used + bytes(text) + 1 <= 10 * 1024) { parts.push(text); used += bytes(text) + 1 }
  }
  let omitted = 0
  const groups = new Map<string, ContextResult['fragments']>()
  for (const fragment of value.fragments) {
    const key = `${fragment.path}:${fragment.contextStartLine}:${fragment.contextEndLine}`
    const group = groups.get(key) ?? []
    group.push(fragment); groups.set(key, group)
  }
  for (const group of groups.values()) {
    const text = group.map(fragment => {
      const anchors = fragment.anchors.length
        ? `; anchors ${fragment.anchors.map(anchor => `${anchor.kind}:${anchor.name}@${anchor.line}:${anchor.character}`).join(', ')}`
        : ''
      return `\n${fragment.path}:${fragment.startLine}-${fragment.endLine} [${fragment.source}${fragment.seededByVector ? '; vector-seeded' : ''}; associated context ${fragment.contextStartLine}-${fragment.contextEndLine}; terms: ${fragment.matchedTerms.join(', ')}${anchors}]\n${fragment.text.split('\n').map((line, i) => `${fragment.startLine + i} | ${line}`).join('\n')}`
    }).join('\n')
    // Rendering must not separate a declaration's associated pieces either.
    if (used + bytes(text) + 256 > 10 * 1024) { omitted += group.length; continue }
    parts.push(text); used += bytes(text) + 1
  }
  let skippedShown = 0
  for (const item of value.skipped) {
    const text = `Skipped ${item.path}: ${item.reason}`
    if (used + bytes(text) + 1 > 10 * 1024) break
    parts.push(text); used += bytes(text) + 1
    skippedShown++
  }
  if (omitted || skippedShown < value.skipped.length) {
    const note = `Rendering budget: ${omitted} source fragments and ${value.skipped.length - skippedShown} skipped-file details omitted.`
    if (used + bytes(note) + 1 <= 10 * 1024) parts.push(note)
  }
  return parts.join('\n')
}

export function registerSearchContextTool(ctx: Context, semantic?: SemanticIndexConfig): void {
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({
      name: 'tool:ci_search_context', order: scoped.systemPrompt.getSectionOrder('TOOL_GREP') + 1,
      text: ({ scope }) => scoped.tools.get('ci_search_context', scope) === undefined ? ''
        : 'When TS/JS search needs surrounding implementation source, use ci_search_context instead of separate grep plus ordinary read of matching files. Supply literal terms when known; when a semanticIndex is configured, also pass a natural-language query with mode hybrid for concept recall. The tool keeps lexical declarations/anchors first and may add vector-seeded files; vector-seeded source is still read from the current workspace and is not semantic proof. Reuse numbered fragments and anchors; read only missing branches or dependencies. Check term coverage for terms without selected fragments before refining. Use available declaration or native LSP tools only for unresolved identity, type or relationship questions. An unchanged empty query adds no evidence; refine it or stop when the required facts are covered.',
    })
  })
  ctx.tools.register(defineTool({
    name: 'ci_search_context',
    description: 'Replace separate grep plus ordinary read of matching TS/JS files when literal terms and bounded surrounding implementation can answer the question. Use 1–6 case-sensitive literal terms, and/or a natural-language query when a prepared semanticIndex is configured. mode=hybrid unions lexical candidates with vector-seeded files; lexical declarations and anchors stay first, and vector-seeded source is re-read from the current workspace, not treated as semantic proof. mode=auto uses vector only when lexical candidates are all missing; mode=lexical never calls the semantic index. Oversized declarations return a bounded declaration-partial view: declaration head, hit neighborhood and omitted range. Syntax errors and unsupported bindings fall back to lexical windows or are omitted. Each fragment carries up to three 1-based UTF-16 anchors; term coverage reports matched/selected/omitted status. Reuse source already shown; read only missing ranges or dependencies. If declaration identity or coordinates are needed, pass confirmed fragment paths as files to ci_find_declarations when available. For unresolved cross-file targets, references or types, use native lsp at exact surviving symbol coordinates. Partial coverage, vector similarity and lexical matches do not prove semantic completeness.',
    parameters: {
      terms: { type: 'array', items: { type: 'string' }, description: '1–6 literal code terms, each 2–64 characters with a letter or number; not regexes, case-sensitive; e.g. ["createSession", "signal"]. Optional when query is present.' },
      query: { type: 'string', description: 'Optional natural-language concept/behavior, 1–1000 characters. Requires semanticIndex; use mode hybrid to force vector candidates, auto to use them only when lexical candidates are empty.' },
      mode: { type: 'string', enum: ['auto', 'lexical', 'hybrid'] as const, description: 'auto (default), lexical, or hybrid; hybrid requires query and semanticIndex.' },
      path: { type: 'string', description: 'Optional workspace-relative path or absolute path within the Session workspace; omit to search the workspace. Outside paths are rejected.' },
      limit: { type: 'integer', description: 'Maximum fragments, 1–6; default 4. Each is at most 40 lines and 2 KiB; total source at most 8 KiB. Oversized declarations use a partial view rather than losing their identity.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      matchesFound: { type: 'integer', required: true }, candidateFiles: { type: 'integer', required: true },
      filesRead: { type: 'integer', required: true }, bytesRead: { type: 'integer', required: true },
      truncated: { type: 'boolean', required: true }, usedVector: { type: 'boolean', required: true },
      vectorHits: { type: 'integer', required: true }, queryEmbeddings: { type: 'integer', required: true },
      limits: { type: 'array', required: true, items: { type: 'string' } },
      skipped: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, reason: { type: 'string', required: true },
      } } },
      terms: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        term: { type: 'string', required: true }, matchedFiles: { type: 'integer', required: true },
        matchedLines: { type: 'integer', required: true }, selectedFragments: { type: 'integer', required: true },
        anchorFragments: { type: 'integer', required: true },
        omittedReason: { type: 'string' },
      } } },
      fragments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, startLine: { type: 'integer', required: true }, endLine: { type: 'integer', required: true },
        text: { type: 'string', required: true }, source: { type: 'string', required: true, enum: ['lexical-window', 'declaration-context', 'declaration-partial'] as const },
        contextStartLine: { type: 'integer', required: true }, contextEndLine: { type: 'integer', required: true },
        matchedTerms: { type: 'array', required: true, items: { type: 'string' } },
        seededByVector: { type: 'boolean' },
        anchors: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, enum: ['match', 'declaration'] as const },
          name: { type: 'string', required: true }, line: { type: 'integer', required: true },
          character: { type: 'integer', required: true },
        } } },
      } } },
    } }, render: (_args, value) => [{ type: 'text', text: renderCodeContext(value) }] },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => searchCodeContext(ctx.fs, ctx.tools, args, exec, semantic),
  }))
}

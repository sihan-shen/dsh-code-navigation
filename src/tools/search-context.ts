import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchCodeContext, type SemanticQueryCache } from '../search/code-context-search.js'
import type { ContextResult } from '../search/code-context-search.js'
import { resolveConfig } from '../semantic/types.js'
import type { SemanticIndexConfig } from '../semantic/types.js'

function renderLocationsView(value: ContextResult): string {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength
  const renderLimit = 4 * 1024
  const limitText = value.limits.join('; ')
  const boundedLimits = bytes(limitText) > 900 ? `${limitText.slice(0, 450)} …` : limitText
  const limitNote = value.truncated
    ? ` Partial: ${boundedLimits}.`
    : value.limits.length ? ` Notes: ${boundedLimits}.` : ''
  const parts: string[] = [
    `Locations: ${value.matchesFound} matched line(s) across ${value.candidateFiles} file(s); inspected ${value.filesRead} file(s).${limitNote}`,
  ]
  if (value.interpretations.length) {
    parts.push(`Query interpretation: ${value.interpretations.join('; ')}`)
  }
  if (value.declarationCoords.length) {
    parts.push('Declaration coordinates: ' + value.declarationCoords.map(d =>
      `${d.name} -> ${d.path}:${d.line}:${d.character} (${d.kind}${d.container ? ` in ${d.container}` : ''})`).join('; '))
  }
  if (value.terms.length) {
    parts.push('Terms: ' + value.terms.map(t => `${t.term} (${t.matchedLines} lines/${t.matchedFiles} files${t.omittedReason ? `; ${t.omittedReason}` : ''})`).join('; '))
  }
  let used = bytes(parts.join('\n')) + 256
  let omittedFiles = 0
  for (const loc of value.locations) {
    const lines = [
      `${loc.path} (${loc.totalMatches} match(es)):`,
      ...loc.hits.map(hit => {
        const decl = hit.declarationName
          ? ` [${hit.declarationKind ? `${hit.declarationKind} ` : ''}${hit.declarationName}@${hit.declarationLine}:${hit.declarationCharacter}]`
          : ''
        return `  L${hit.line}:${hit.character}${decl}: ${hit.preview}`
      }),
    ].join('\n')
    if (used + bytes(lines) + 1 > renderLimit) { omittedFiles++; continue }
    parts.push(lines)
    used += bytes(lines) + 1
  }
  for (const item of value.skipped) {
    const text = `Skipped ${item.path}: ${item.reason}`
    if (used + bytes(text) + 1 > renderLimit) break
    parts.push(text)
    used += bytes(text) + 1
  }
  if (value.extraMatchedFiles.length) {
    const extra = 'More matched files (not AST-inspected): ' + value.extraMatchedFiles.map(f =>
      `${f.path} (${f.matches}: L${f.lines.join(',')})`).join('; ')
    if (used + bytes(extra) + 1 <= renderLimit) {
      parts.push(extra)
      used += bytes(extra) + 1
    }
  }
  if (omittedFiles) parts.push(`Render omitted ${omittedFiles} matched file(s) due to compact 4 KiB locations cap.`)
  parts.push('Next: call nav_search_context with view="fragments" and path="<file>" (or read with offset/limit) for full source.')
  return parts.join('\n')
}

export function renderCodeContext(value: ContextResult, caseSensitive = false): string {
  if (value.view === 'locations') return renderLocationsView(value)
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength
  const renderLimit = 10 * 1024
  const limitText = value.limits.join('; ')
  const boundedLimits = bytes(limitText) > 1800 ? `${limitText.slice(0, 900)} …` : limitText
  const vectorInfo = value.vectorStatus !== 'off'
    ? ` Vector ${value.vectorStatus}/${value.vectorTrigger}: ${value.vectorHits} hits, ${value.queryEmbeddings} query embedding(s); selected ${value.vectorSeededFragments} vector fragment(s), ${value.seedCoveredFragments} internally seed-covered (not visible-body coverage).`
    : ''
  const sourceNote = value.usedVector
    ? 'Numbered body lines are visible source; pointer previews/anchors only locate source. Seed coverage describes selected ranges, not displayed text or answer completeness. Reuse shown source; read only a requested gap.'
    : 'Numbered lines are verbatim current workspace source (1-based UTF-16). Do not re-read displayed line ranges; use read only for unshown offset/limit ranges or full un-truncated long lines.'
  const coverageNote = value.truncated
    ? `Partial search coverage: ${boundedLimits}.`
    : value.limits.length ? `All search candidates processed. Notes: ${boundedLimits}.` : 'All search candidates processed.'
  const intro = `${value.usedVector ? 'Lexical + vector candidates' : 'Lexical candidates'}; ${value.matchesFound} matched lines in ${value.candidateFiles} files; read ${value.filesRead} files / ${value.bytesRead} bytes. Selected ${value.fragments.length} fragment(s).${vectorInfo} ${sourceNote} ${coverageNote}`
  type VisibleFragment = { fragment: ContextResult['fragments'][number]; body: string; bodyLines: number }
  const visible: VisibleFragment[] = []
  const coverageText = (planned: boolean): string => value.terms.map(term => {
    const bodies = planned ? value.fragments.length : visible.filter(item => item.bodyLines > 0
      && (caseSensitive ? item.body.includes(term.term) : (item.fragment.matchedTerms.includes(term.term)
        || item.body.toLowerCase().includes(term.term.toLowerCase())))).length
    const anchors = planned ? value.fragments.length : visible.filter(item => item.fragment.anchors.some(anchor =>
      caseSensitive ? anchor.name === term.term : anchor.name.toLowerCase() === term.term.toLowerCase())).length
    return `${term.term}: matched ${term.matchedLines} lines/${term.matchedFiles} files; selected ${term.selectedFragments} fragments; visible body ${bodies} fragments/locator anchors ${anchors}${term.omittedReason ? `; ${term.omittedReason}` : ''}`
  }).join('; ')
  const extraHeaders: string[] = []
  if (value.interpretations.length) {
    extraHeaders.push(`Query interpretation: ${value.interpretations.join('; ')}`)
  }
  if (value.declarationCoords.length) {
    extraHeaders.push('Declaration coordinates: ' + value.declarationCoords.map(d =>
      `${d.name} -> ${d.path}:${d.line}:${d.character} (${d.kind}${d.container ? ` in ${d.container}` : ''})`).join('; '))
  }
  const extraReserve = extraHeaders.reduce((n, line) => n + bytes(line) + 1, 0)
  const coverageReserve = value.terms.length ? bytes('Term coverage: ' + coverageText(true)) + 1 : 0
  let used = bytes(intro) + extraReserve + coverageReserve + 512
  const parts = [intro, ...extraHeaders]
  let omitted = 0, vectorCards = 0
  const groups = new Map<string, ContextResult['fragments']>()
  for (const fragment of value.fragments) {
    const key = `${fragment.path}:${fragment.contextStartLine}:${fragment.contextEndLine}`
    const group = groups.get(key) ?? []
    group.push(fragment); groups.set(key, group)
  }
  for (const group of groups.values()) {
    let plannedCards = vectorCards
    const planned: VisibleFragment[] = []
    let text = group.map(fragment => {
      const seed = fragment.seedStartLine !== undefined ? `; selected seed ${fragment.seedStartLine}-${fragment.seedEndLine} (${fragment.seedCoverage})` : ''
      const anchors = fragment.anchors.length
        ? `; locator anchors ${fragment.anchors.map(anchor => `${anchor.kind}:${anchor.name}@${anchor.line}:${anchor.character}`).join(', ')}`
        : ''
      const lines = fragment.text.split('\n')
      const numbered = (list: string[], from: number) => list.map((line, i) => `${from + i} | ${line}`).join('\n')
      if (value.usedVector && fragment.seededByVector) {
        const body: string[] = []
        const primary = plannedCards === 0
        if (primary) {
          let usedBytes = 0
          for (const line of lines) {
            const size = bytes(line) + 1
            if (usedBytes + size > 2000) break
            body.push(line); usedBytes += size
          }
        }
        plannedCards++
        planned.push({ fragment, body: body.join('\n'), bodyLines: body.length })
        const signatures = fragment.anchors.filter(anchor => anchor.kind === 'declaration').map(anchor => {
          const line = lines[anchor.line - fragment.startLine]?.trim() ?? ''
          return `${anchor.name}@${anchor.line} | ${line.slice(0, 240)}`
        })
        const bodyEnd = fragment.startLine + body.length - 1
        const bodyRange = body.length ? `${fragment.startLine}-${bodyEnd}` : 'none'
        const missingStart = fragment.startLine + body.length
        const missing = missingStart <= fragment.endLine
          ? `\n  Unshown body ${missingStart}-${fragment.endLine}; only if needed for a requested fact: read ${fragment.path} offset=${missingStart} limit=${fragment.endLine - missingStart + 1}.`
          : ''
        let evidence = body.length ? `\n${numbered(body, fragment.startLine)}` : ''
        if (!primary) {
          const first = lines.findIndex(line => line.trim())
          if (first >= 0) evidence = `\n  preview ${fragment.startLine + first} | ${lines[first].trim().slice(0, 240)}`
        }
        return `\n${fragment.path}:${fragment.startLine}-${fragment.endLine} [${primary ? 'primary navigation' : 'supporting pointer'}${seed}; visible body ${bodyRange}; associated context ${fragment.contextStartLine}-${fragment.contextEndLine}${anchors}]${signatures.length ? `\n  declaration preview: ${signatures.join(' / ')}` : ''}${evidence}${missing}`
      }
      planned.push({ fragment, body: fragment.text, bodyLines: lines.length })
      const bodyBlock = fragment.isLongLineExcerpt
        ? `${fragment.startLine} [long-line excerpt] | ${fragment.text}`
        : numbered(lines, fragment.startLine)
      return `\n${fragment.path}:${fragment.startLine}-${fragment.endLine} [${fragment.source}; visible body ${fragment.startLine}-${fragment.endLine}${seed}; associated context ${fragment.contextStartLine}-${fragment.contextEndLine}; terms: ${fragment.matchedTerms.join(', ')}${anchors}]\n${bodyBlock}`
    }).join('\n')
    const context = group[0], gaps: [number, number][] = []
    let cursor = context.contextStartLine
    for (const fragment of [...group].sort((a, b) => a.startLine - b.startLine)) {
      if (fragment.startLine > cursor) gaps.push([cursor, fragment.startLine - 1])
      cursor = Math.max(cursor, fragment.endLine + 1)
    }
    if (cursor <= context.contextEndLine) gaps.push([cursor, context.contextEndLine])
    if (gaps.length) text += '\n  Unselected associated context in this group: ' + gaps.map(([start, end]) =>
      `${start}-${end}; only if needed: read ${context.path} offset=${start} limit=${Math.min(80, end - start + 1)}`
    ).join('; ') + '.'
    if (used + bytes(text) + 1 > renderLimit) { omitted += group.length; continue }
    vectorCards = plannedCards
    visible.push(...planned)
    parts.push(text); used += bytes(text) + 1
  }
  if (value.omittedRanges.length) {
    const hints = value.omittedRanges.map(r => `${r.name} (${r.path}:${r.startLine}-${r.endLine}): read ${r.path} offset=${r.startLine} limit=${Math.min(120, r.endLine - r.startLine + 1)}`).join('; ')
    const text = `Omitted matched context: ${hints}`
    if (used + bytes(text) + 1 <= renderLimit) { parts.push(text); used += bytes(text) + 1 }
  }
  let skippedShown = 0
  for (const item of value.skipped) {
    const text = `Skipped ${item.path}: ${item.reason}`
    if (used + bytes(text) + 1 > renderLimit) break
    parts.push(text); used += bytes(text) + 1; skippedShown++
  }
  const insertAt = 1 + extraHeaders.length
  if (value.terms.length) parts.splice(insertAt, 0, 'Term coverage: ' + coverageText(false))
  const pointerCount = visible.length - visible.filter(item => item.bodyLines > 0).length
  const visibleSummary = value.usedVector
    ? `Visible: ${visible.length - pointerCount} body fragment(s), ${pointerCount} pointer-only fragment(s); render omitted ${omitted} selected fragment(s), ${value.skipped.length - skippedShown} skipped-file details.`
    : `Visible: ${visible.length} fragment(s)${omitted ? `; render omitted ${omitted} selected fragment(s)` : ''}${value.skipped.length - skippedShown ? `; ${value.skipped.length - skippedShown} skipped-file details omitted` : ''}.`
  parts.splice(value.terms.length ? insertAt + 1 : insertAt, 0, visibleSummary)
  return parts.join('\n')
}

// Session-scoped, bounded seed reuse; an index rebuild is expected to start a new session.
const semanticCaches = new WeakMap<object, SemanticQueryCache>()

export function registerSearchContextTool(ctx: Context, input?: SemanticIndexConfig): void {
  const semantic = input ? resolveConfig(input) : undefined
  const hybrid = semantic !== undefined
  const baseDescription = 'Search TS/JS files using literal terms, "A|B|C" alternations, escaped literals ("hsl\\("), "A.*B" same-line co-occurrence, or ripgrep regexes (pattern). Case-insensitive by default. Use view="locations" for compact file-grouped lines and enclosing declaration names (~hundreds of bytes); default view="fragments" returns verbatim enclosing declarations/code bodies, declaration coordinates, and offset/limit hints for omitted ranges. Lines over 2 KiB (minified/raw data) return a bounded match excerpt. Reuse displayed source; read only unshown ranges.'
  const hybridDescription = 'Use mode=hybrid to union lexical candidates with vector-seeded files; lexical declarations and anchors stay first, and vector-seeded source is re-read from the current workspace, not treated as semantic proof. The first navigation card carries the primary body; supporting cards only point to ranges. Read only the body ranges or gaps the question still needs. mode=auto uses vector only when lexical coverage is weak; mode=lexical never calls the semantic index.'
  ctx.inject(['systemPrompt'], scoped => {
    scoped.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (scoped.tools.get('nav_search_context', context.scope) === undefined) return result
      return {
        ...result,
        sections: result.sections.map(section => section.name === 'tool:grep'
          ? {
              ...section,
              text: section.text.replace(
                ' Use read on a matched file when you need surrounding context.',
                ' For TS/JS files (literals, "A|B|C", "A.*B", or regexes), prefer nav_search_context (view="locations" for quick discovery or view="fragments" for enclosing declarations/context); reserve grep for non-TS/JS files.',
              ),
            }
          : section),
      }
    })
    scoped.systemPrompt.section({
      name: 'tool:nav_search_context', order: scoped.systemPrompt.getSectionOrder('TOOL_GREP') + 1,
      text: ({ scope }) => {
        if (scoped.tools.get('nav_search_context', scope) === undefined) return ''
        const has = (name: string) => scoped.tools.get(name, scope) !== undefined
        const hasAst = has('nav_find_declarations'), hasBash = has('bash')
        const hasLsp = has('lsp') || has('nav_batch_definitions') || has('nav_find_references')
        const parts = [
          `For TS/JS code search, call nav_search_context instead of grep${hasBash ? ' or shell grep/sed/cat' : ''}: use view="locations" for compact file/line/declaration discovery, or default view="fragments" for enclosing declarations and verbatim code (case-insensitive by default; supports terms, pattern regex, path, and include glob). On a single file, it returns complete enclosing declarations when within budget; do not re-read displayed line ranges—read only unshown offset/limit ranges.`,
        ]
        if (hybrid) {
          parts.push('When a prepared semanticIndex is configured, also pass a natural-language query with mode=hybrid (or mode=auto) for concept recall; vector-seeded source is re-read from the current workspace and is not semantic proof. The first vector card is the primary evidence card; later cards are supporting pointers. Use the primary card first, and open a supporting card only for a specific missing fact.')
        }
        if (hasAst && hasLsp) parts.push('Use available declaration or LSP tools only for unresolved identity, type or relationship questions.')
        else if (hasAst) parts.push('Use nav_find_declarations only when exhaustive per-name AST counts or coordinates are still needed.')
        else if (hasLsp) parts.push('Use available LSP tools only for unresolved symbol target, reference or type questions.')
        parts.push(`An unchanged${hybrid ? ' or empty' : ''} query adds no evidence; refine it or stop when the required facts are covered.`)
        return parts.join(' ')
      },
    })
  })
  const tool = defineTool({
    name: 'nav_search_context',
    description: baseDescription,
    parameters: {
      terms: { type: 'array', items: { type: 'string' }, description: '1–12 search terms (literals, "A|B|C" alternations, escaped literals like "hsl\\(", "A.*B" same-line co-occurrence, or regexes; case-insensitive by default). Optional if pattern or query is given.' },
      pattern: { type: 'string', description: 'Optional ripgrep regular expression (e.g. "disabled=\\{[^}]*0" or "dynamic.*(attribute|type)"). Use alongside or instead of terms.' },
      include: { type: 'string', description: 'Optional glob filter (e.g. "*.ts", "*.{ts,tsx}", "*.test.js"). Positive single glob only.' },
      view: { type: 'string', enum: ['fragments', 'locations'] as const, description: 'fragments (default) returns enclosing declarations/code bodies; locations returns compact file-grouped lines and declaration names.' },
      caseSensitive: { type: 'boolean', description: 'Match case-sensitively when true. Defaults to false.' },
      ...(hybrid ? {
        query: { type: 'string', description: 'Optional natural-language concept/behavior, 1–1000 characters. Requires semanticIndex; use mode hybrid to force vector candidates, auto to use them only when lexical coverage is weak.' },
        mode: { type: 'string', enum: ['auto', 'lexical', 'hybrid'] as const, description: 'auto (default), lexical, or hybrid; hybrid requires query and semanticIndex.' },
      } : {}),
      path: { type: 'string', description: 'Optional workspace-relative or workspace-contained file/directory path; omit to search the workspace.' },
      limit: { type: 'integer', description: 'Max fragments (1–6, default 4) in fragments view, or max files (1–20, default 12) in locations view; values above the cap are clamped cleanly.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      view: { type: 'string', required: true, enum: ['fragments', 'locations'] as const },
      matchesFound: { type: 'integer', required: true }, candidateFiles: { type: 'integer', required: true },
      filesRead: { type: 'integer', required: true }, bytesRead: { type: 'integer', required: true },
      truncated: { type: 'boolean', required: true }, usedVector: { type: 'boolean', required: true },
      vectorHits: { type: 'integer', required: true }, queryEmbeddings: { type: 'integer', required: true },
      vectorOnlyFiles: { type: 'integer', required: true }, vectorSeededFragments: { type: 'integer', required: true },
      seedCoveredFragments: { type: 'integer', required: true },
      vectorStatus: { type: 'string', required: true, enum: ['off', 'ok', 'empty', 'reused', 'unavailable', 'stale', 'invalid', 'error'] as const },
      vectorTrigger: { type: 'string', required: true, enum: ['none', 'hybrid', 'query-only', 'lexical-empty', 'lexical-weak'] as const },
      limits: { type: 'array', required: true, items: { type: 'string' } },
      interpretations: { type: 'array', required: true, items: { type: 'string' } },
      declarationCoords: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', required: true }, path: { type: 'string', required: true },
        line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
        kind: { type: 'string', required: true }, container: { type: 'string', required: true },
      } } },
      omittedRanges: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, name: { type: 'string', required: true },
        startLine: { type: 'integer', required: true }, endLine: { type: 'integer', required: true },
      } } },
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
        isLongLineExcerpt: { type: 'boolean' },
        seededByVector: { type: 'boolean' },
        seedStartLine: { type: 'integer' }, seedEndLine: { type: 'integer' },
        seedCoverage: { type: 'string', enum: ['full', 'partial'] as const },
        anchors: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, enum: ['match', 'declaration'] as const },
          name: { type: 'string', required: true }, line: { type: 'integer', required: true },
          character: { type: 'integer', required: true },
        } } },
      } } },
      locations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, totalMatches: { type: 'integer', required: true },
        hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
          preview: { type: 'string', required: true },
          matchedTerms: { type: 'array', required: true, items: { type: 'string' } },
          declarationName: { type: 'string' }, declarationKind: { type: 'string' },
          declarationLine: { type: 'integer' }, declarationCharacter: { type: 'integer' },
        } } },
      } } },
      extraMatchedFiles: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, matches: { type: 'integer', required: true },
        lines: { type: 'array', required: true, items: { type: 'integer' } },
      } } },
    } }, render: (args, value) => [{ type: 'text', text: renderCodeContext(value, args.caseSensitive ?? false) }] },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => {
      const session = exec.agent?.session as object | undefined
      let cache: SemanticQueryCache | undefined
      if (semantic && session) {
        cache = semanticCaches.get(session)
        if (!cache) { cache = { entries: new Map() }; semanticCaches.set(session, cache) }
      }
      return searchCodeContext(ctx.fs, ctx.tools, args, exec, semantic, cache)
    },
  })
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: () => {
      const has = (name: string) => ctx.tools.get(name) !== undefined
      const parts = [baseDescription]
      if (has('nav_find_declarations')) {
        parts.push('If exhaustive per-name AST counts or coordinates are needed, pass confirmed fragment paths as files to nav_find_declarations.')
      }
      if (has('lsp')) {
        parts.push('For unresolved cross-file targets, references or types, use native lsp at exact surviving symbol coordinates.')
      } else {
        const lspTools = [has('nav_batch_definitions') ? 'nav_batch_definitions' : '', has('nav_find_references') ? 'nav_find_references' : ''].filter(Boolean)
        if (lspTools.length) parts.push(`For unresolved cross-file targets, references or types, use ${lspTools.join(' or ')}.`)
      }
      parts.push('Partial coverage and lexical matches do not prove semantic completeness.')
      if (hybrid) parts.push(hybridDescription)
      return parts.join(' ')
    },
  })
  ctx.tools.register(tool)
}

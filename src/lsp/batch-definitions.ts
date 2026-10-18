import type { FileSystem, FsTarget, FsInfo } from '@deepseek-ai/dsh-fs'
import type { LspService, LspLocation } from '@deepseek-ai/dsh-lsp'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { definitionCursorEvidence, definitionSyntaxEvidence } from '../ast/typescript-definition-evidence.js'
import type { DefinitionCursorEvidence } from '../ast/typescript-definition-evidence.js'
import { lineSymbolCandidates } from '../ast/typescript-line-symbol.js'
import { CONTINUATION_SELECTORS, parseDefinitionSource, definitionIdentity, selectContinuation } from '../ast/typescript-continuation.js'
import type { ContinuationSelector } from '../ast/typescript-continuation.js'
import { extractDeclarations } from '../ast/typescript-declarations.js'
import { isWorkspaceRelativePath } from '../workspace-path.js'

export const DEFINITION_LIMITS = {
  queries: 8, targets: 3, fileBytes: 65536, totalBytes: 393216,
  sourceRows: 96, renderBytes: 12000,
} as const

export interface DefinitionCursor {
  file_path: string
  line: number
  character?: number
  symbol?: string
  expected_symbol?: string
  follow?: ContinuationSelector[]
}
export interface DefinitionTarget {
  path: string
  uri: string
  line: number
  character: number
  name: string
  kind: string
  container: string
  sha256: string
  lines: { line: number; text: string; truncated: boolean }[]
  contextComplete: boolean
  evidenceRows: number[]
  evidenceNotes: string[]
  declarationLine: number
  declarationCharacter: number
  relation: 'self' | 'definition'
}
export interface DefinitionItem extends DefinitionCursorEvidence {
  index: number
  depth: number
  parentQuery: number
  parentTarget: string
  rootIndex: number
  routeStatus: string
  routeNote: string
  sourceText: string
  candidates: { file_path: string; line: number; character: number; name: string }[]
  path: string
  line: number
  character: number
  status: 'ok' | 'empty' | 'duplicate' | 'error' | 'partial' | 'unavailable' | 'mismatch' | 'ambiguous' | 'not-found'
  duplicateOf: number
  targets: DefinitionTarget[]
  omitted: number
  error: string
}
export interface BatchDefinitions {
  items: DefinitionItem[]
  lspQueries: number
  bytesRead: number
  sourceRows: number
  omittedTargets: number
}
interface Source {
  syntax?: ReturnType<typeof parseDefinitionSource>
  version: FsInfo['version']
  text: string
  lines: string[]
  sha256: string
}

// Decode only this filesystem's workspace URI namespace; resolve/contains checks follow.
function workspacePath(uri: string, rootUri: string): string | undefined {
  try {
    const root = new URL(rootUri), target = new URL(uri)
    const prefix = root.pathname.replace(/\/$/, '') + '/'
    if (root.protocol !== 'file:' || target.protocol !== 'file:' || target.host !== root.host
      || target.search || target.hash || !target.pathname.startsWith(prefix)) return undefined
    const path = decodeURIComponent(target.pathname.slice(prefix.length))
    return isWorkspaceRelativePath(path, /\.ts$/i) ? path : undefined
  } catch { return undefined }
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240)
}

export async function findBatchDefinitions(
  fs: FileSystem, lsp: LspService, args: { queries: DefinitionCursor[] }, exec: ToolExecution,
): Promise<BatchDefinitions> {
  if (args.queries.length < 1 || args.queries.length > DEFINITION_LIMITS.queries) {
    throw new Error('queries must contain 1–8 cursors')
  }
  for (const q of args.queries) {
    if (!isWorkspaceRelativePath(q.file_path, /\.ts$/i)
      || q.expected_symbol !== undefined && (!q.expected_symbol || q.expected_symbol.length > 120)
      || q.follow !== undefined && (q.follow.length > 2 || q.follow.some(step => !CONTINUATION_SELECTORS.includes(step)))
      || !Number.isSafeInteger(q.line) || q.line < 1
      || (q.symbol === undefined ? !Number.isSafeInteger(q.character) || q.character! < 1
        : !q.symbol || q.symbol.length > 120 || q.character !== undefined)) {
      throw new Error('Require a .ts path, positive line, and exactly one of positive UTF-16 character or symbol')
    }
  }
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  const signal = exec.signal
  signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd, signal })
  const rootUri = fs.fileUrl(root)
  const texts = new Map<FsTarget['targetKey'], Source>()
  const sourceTargets = new Map<FsTarget['targetKey'], FsTarget>()
  let remaining: number = DEFINITION_LIMITS.totalBytes, bytesRead = 0

  async function source(target: FsTarget): Promise<Source> {
    signal.throwIfAborted()
    const cached = texts.get(target.targetKey)
    if (cached) return cached
    const cap = Math.min(DEFINITION_LIMITS.fileBytes, remaining)
    if (cap <= 0) throw new Error('[source_budget_exhausted] remaining_bytes=0; retryable=false for this batch. Reuse collected evidence; use native lsp if available or focused read/grep only for remaining claims.')
    const before = await fs.stat(target, signal)
    if (before?.type !== 'file') throw new Error('[source_not_regular_file] The resolved source is not a regular file; source text not read. Select an existing workspace .ts file.')
    if (!Number.isSafeInteger(before.size) || before.size! < 0) throw new Error('[source_size_unavailable] No valid source byte size; source text not read. Use native lsp if available or focused read/grep only for remaining claims.')
    if (before.size! > DEFINITION_LIMITS.fileBytes) {
      throw new Error(`[file_too_large] actual_bytes=${before.size} max_bytes=${DEFINITION_LIMITS.fileBytes}; retryable=false; source text not read. Path/cursor changes cannot fix size. Reuse evidence; otherwise native lsp if available or focused read/grep for missing facts.`)
    }
    if (before.size! > remaining) {
      throw new Error(`[source_budget_exhausted] required_bytes=${before.size} remaining_bytes=${remaining}; retryable=false for this batch. Reuse collected evidence; use native lsp if available or focused read/grep only for remaining claims.`)
    }
    // Reserve before I/O, including failed reads; no mutable cross-call cache or budget.
    remaining -= cap
    const bytes = await fs.readBytes(target, signal, cap)
    bytesRead += bytes.byteLength
    const after = await fs.stat(target, signal)
    if (bytes.byteLength !== before.size || after?.version !== before.version) {
      throw new Error('Source changed while reading; retry with current coordinates')
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('Binary source')
    remaining += cap - bytes.byteLength
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))
    const sha256 = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
    const value = { version: before.version, text, lines: text.split(/\r\n|\n|\r/), sha256 }
    texts.set(target.targetKey, value)
    sourceTargets.set(target.targetKey, target)
    return value
  }

  // Validate the entire input before starting even the first LSP request.
  const cursors: (DefinitionCursor & DefinitionCursorEvidence & { character: number; selectionFailure?: 'ambiguous' | 'not-found'; selectionNote?: string; selectionCandidates?: { line: number; character: number; name: string }[]; path: string; target: FsTarget; depth?: number; parentQuery?: number; parentTarget?: string; rootIndex?: number })[] = []
  for (const q of args.queries) {
    const target = await fs.resolve(q.file_path, { cwd, signal })
    if (!fs.contains(root, target)) throw new Error('Source is outside the Session workspace')
    const path = workspacePath(fs.fileUrl(target), rootUri)
    if (path === undefined) throw new Error('Source is outside the workspace .ts URI namespace')
    const value = await source(target)
    if (q.line > value.lines.length) throw new Error('Source line is outside current text')
    let character = q.character
    if (q.symbol !== undefined) {
      const parsed = value.syntax ??= parseDefinitionSource(path, value.text)
      const selection = lineSymbolCandidates(parsed, q.line, q.symbol)
      if (selection.count !== 1) {
        cursors.push({ ...q, character: 0, path, target, sourceSymbol: q.symbol, sourceRole: 'unknown',
          selectionFailure: selection.count ? 'ambiguous' : 'not-found',
          selectionNote: `Line-symbol lookup matched ${selection.count} identifiers; no cursor selected; character=0 is unresolved`,
          selectionCandidates: selection.candidates })
        continue
      }
      character = selection.candidates[0].character
    }
    if (character! > value.lines[q.line - 1].length + 1) throw new Error('Source cursor is outside current text')
    cursors.push({ ...q, character: character!, path, target, ...definitionCursorEvidence(path, value.text, q.line, character!) })
  }
  signal.throwIfAborted()
  const seen = new Map<string, number>()
  let lspQueries = 0
  const responses: { item: DefinitionItem; locations: readonly LspLocation[] }[] = []
  let sourceRows = 0, waveStart = 0, internalQueries = 0
  const includedRows = new Set<string>()
  const scheduledRoutes = new Map<string, number>()
  const initialOmissions = new Map<number, number>()
  for (let depth = 0; depth <= 2; depth++) {
    const jobs = cursors.slice(waveStart).map(async (q, offset) => {
      const index = waveStart + offset
      const item: DefinitionItem = {
        index, rootIndex: q.rootIndex ?? index, routeStatus: 'not-requested', routeNote: '', sourceText: texts.get(q.target.targetKey)!.lines[q.line - 1].slice(0, 240), candidates: [], depth: q.depth ?? 0, parentQuery: q.parentQuery ?? -1, parentTarget: q.parentTarget ?? '', path: q.path, line: q.line, character: q.character,
        sourceSymbol: q.sourceSymbol, sourceRole: q.sourceRole,
        status: 'empty', duplicateOf: -1, targets: [], omitted: 0, error: '',
      }
      if (q.selectionFailure) { item.status = q.selectionFailure; item.routeStatus = 'stopped'; item.routeNote = q.selectionNote!; item.candidates = (q.selectionCandidates ?? []).map(c => ({ ...c, file_path: q.path })); return { item, locations: [] as readonly LspLocation[] } }
      if (q.expected_symbol !== undefined && q.expected_symbol !== q.sourceSymbol) {
        item.status = 'mismatch'; item.routeStatus = 'stopped'; item.routeNote = `Expected ${q.expected_symbol}, actual ${q.sourceSymbol || 'unknown'}; LSP skipped; correct only this cursor`; return { item, locations: [] as readonly LspLocation[] }
      }
      const key = JSON.stringify([fs.fileUrl(q.target), q.line, q.character])
      const prior = seen.get(key)
      if (prior !== undefined) {
        item.status = 'duplicate'; item.duplicateOf = prior
        return { item, locations: [] as readonly LspLocation[] }
      }
      seen.set(key, index); lspQueries++
      try {
        const result = await lsp.query({
          operation: 'goToDefinition', filePath: fs.processPath(q.target), workspaceRoot: fs.processPath(root),
          position: { line: q.line - 1, character: q.character - 1 },
        }, signal)
        signal.throwIfAborted()
        if (result.kind !== 'locations') throw new Error('Unexpected LSP result kind')
        if (result.resolvedWorkspaceUri !== rootUri) throw new Error('LSP and filesystem workspace URI differ')
        item.status = result.locations.length ? 'ok' : 'empty'
        item.omitted = Math.max(0, result.locations.length - DEFINITION_LIMITS.targets)
        return { item, locations: result.locations.slice(0, DEFINITION_LIMITS.targets) }
      } catch (error) {
        signal.throwIfAborted()
        item.status = 'error'; item.error = failureMessage(error)
        return { item, locations: [] as readonly LspLocation[] }
      }
    })
    const currentResponses = await Promise.all(jobs)
    responses.push(...currentResponses)
    for (const r of currentResponses) initialOmissions.set(r.item.index, r.item.omitted)
    waveStart = cursors.length
    for (const response of currentResponses) {
      const item = response.item
      if (item.status === 'mismatch' || item.status === 'ambiguous' || item.status === 'not-found') continue
      const locations = item.status === 'duplicate' ? responses.find(r => r.item.index === item.duplicateOf)!.locations : response.locations
      if (item.status === 'duplicate') item.omitted = initialOmissions.get(item.duplicateOf) ?? 0
      const q = cursors[item.index]
      const automatic = q.follow === undefined
      const selector = q.follow?.[0]
      let selectedSelector = selector
      const choices = new Map<string, { file_path: string; line: number; character: number; name: string; target: FsTarget; origin: string }>()
      const bodies = new Set<string>()
      const processed = new Set<string>()
      let unsupported = false
      if (item.status !== 'duplicate' && item.status !== 'error') {
        try {
          // The original use-site text must still match its pre-query snapshot.
          await source(cursors[item.index].target)
        } catch (error) {
          signal.throwIfAborted()
          item.status = 'error'; item.error = failureMessage(error)
          item.omitted += locations.length
          continue
        }
      }
      for (const loc of locations) {
        signal.throwIfAborted()
        const path = workspacePath(loc.uri, rootUri)
        if (path === undefined) { item.omitted++; continue }
        try {
          const target = await fs.resolve(path, { cwd, signal })
          if (!fs.contains(root, target)) throw new Error('Resolved definition is outside workspace')
          const canonicalPath = workspacePath(fs.fileUrl(target), rootUri)
          if (canonicalPath === undefined) throw new Error('Definition is outside workspace .ts URI namespace')
          const value = await source(target), start = loc.range.start, end = loc.range.end
          if (!Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character)
            || start.line < 0 || start.character < 0 || start.line >= value.lines.length
            || start.character > value.lines[start.line].length
            || !Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character)
            || end.line < start.line || end.line >= value.lines.length || end.character < 0
            || end.character > value.lines[end.line].length
            || (start.line === end.line && end.character < start.character)) throw new Error('Definition range does not match current source')
          const selected = start.line === end.line ? value.lines[start.line].slice(start.character, end.character) : ''
          const decl = selected ? extractDeclarations(canonicalPath, value.text, new Set([selected]), 31)
            .find(d => d.line === start.line + 1 && d.character === start.character + 1) : undefined
          const syntax = definitionSyntaxEvidence(canonicalPath, value.text, start.line + 1, start.character + 1)
          const parsed = value.syntax ??= parseDefinitionSource(canonicalPath, value.text)
          const identity = definitionIdentity(parsed, start.line + 1, start.character + 1)
          const identityRows = identity ? [identity.line] : []
          const cursor = cursors[item.index]
          const sourceLine = cursor.line - 1, sourceCharacter = cursor.character - 1
          const self = canonicalPath === cursor.path
            && (sourceLine > start.line || sourceLine === start.line && sourceCharacter >= start.character)
            && (sourceLine < end.line || sourceLine === end.line && sourceCharacter < end.character)
          const first = Math.max(1, start.line - 1), last = Math.min(value.lines.length, start.line + 15)
          // Prioritize exact member/container evidence, then its bounded ordinary window.
          // Repeated rows consume the call's row budget only once, including overlaps.
          const wanted = [...new Set([start.line + 1, ...(syntax?.rows ?? []), ...identityRows,
            ...Array.from({ length: last - first + 1 }, (_, i) => first + i)])]
          const lines: DefinitionTarget['lines'] = []
          for (const n of wanted) {
            const key = JSON.stringify([canonicalPath, value.sha256, n])
            if (!includedRows.has(key)) {
              if (sourceRows >= DEFINITION_LIMITS.sourceRows) continue
              includedRows.add(key); sourceRows++
            }
            lines.push({ line: n, text: value.lines[n - 1].slice(0, 240), truncated: value.lines[n - 1].length > 240 })
          }
          lines.sort((a, b) => a.line - b.line)
          item.targets.push({
            path: canonicalPath, uri: loc.uri, line: start.line + 1, character: start.character + 1,
            name: identity?.name ?? syntax?.name ?? decl?.name ?? '', kind: identity?.kind ?? syntax?.kind ?? decl?.kind ?? 'unknown', container: identity?.container ?? syntax?.container ?? decl?.container ?? '',
            declarationLine: identity?.line ?? start.line + 1, declarationCharacter: identity?.character ?? start.character + 1,
            sha256: value.sha256, lines, contextComplete: lines.length === wanted.length,
            evidenceRows: [start.line + 1, ...(syntax?.rows ?? []), ...identityRows],
            evidenceNotes: syntax?.notes ?? [],
            relation: self ? 'self' : 'definition',
          })
          if (q.follow?.length !== 0 && !self) {
            const selections = (selector ? [selector] : [...CONTINUATION_SELECTORS]).map(step => ({ step, result: selectContinuation(parsed, start.line + 1, start.character + 1, step) })).filter(s => s.result.supported)
            const bodiesHere = new Set(selections.map(s => s.result.bodyKey))
            for (const body of bodiesHere) bodies.add(`${canonicalPath}:${body}`)
            const matched = selections.filter(s => s.result.count > 0)
            if (matched.length === 0) { if (selections.length === 0) unsupported = true; continue }
            if (matched.length > 1) unsupported = true
            const { step, result: selection } = matched[0]
            if (selectedSelector && selectedSelector !== step) unsupported = true
            selectedSelector = step
            const body = `${canonicalPath}:${selection.bodyKey}`
            if (!processed.has(body)) {
              processed.add(body); bodies.add(body)
              for (const call of selection.candidates) {
                const key = JSON.stringify([canonicalPath, call.line, call.character])
                choices.set(key, { ...call, file_path: canonicalPath, target, origin: `${canonicalPath}:${start.line + 1}:${start.character + 1}` })
              }
              if (selection.count > selection.candidates.length) unsupported = true
            }
          } else if (selector && self) unsupported = true
        } catch (error) {
          signal.throwIfAborted()
          item.omitted++; item.error ||= failureMessage(error)
        }
      }
      if (item.omitted && item.status === 'ok') item.status = item.targets.length ? 'partial' : 'unavailable'
      if (!selector && !automatic) { item.routeStatus = item.targets.length && !item.omitted ? 'complete' : 'stopped'; continue }
      item.candidates = [...choices.values()].slice(0, 4).map(c => ({ file_path: c.file_path, line: c.line, character: c.character, name: c.name }))
      const validMapping = (item.status === 'ok' || item.status === 'duplicate') && item.targets.length > 0 && item.omitted === 0
      if (!validMapping || unsupported || bodies.size !== 1 || choices.size !== 1) {
        item.routeStatus = 'stopped'
        item.routeNote = !validMapping ? 'Binding unresolved or targets omitted' : unsupported ? `Unsupported or multiple structural patterns for ${selectedSelector || 'automatic'}` : bodies.size !== 1 ? (bodies.size ? 'Multiple target syntax bodies; no route guessed' : 'No callable target syntax body') : choices.size !== 1 ? `${selectedSelector || 'automatic'} matched ${choices.size} candidates; no cursor guessed` : 'Continuation depth/query/source budget exhausted'
        continue
      }
      const call = [...choices.values()][0]
      const routeKey = JSON.stringify([call.file_path, call.line, call.character, automatic ? undefined : q.follow!.slice(1)])
      const shared = scheduledRoutes.get(routeKey)
      if (shared !== undefined) { item.routeStatus = 'queued'; item.routeNote = `${selectedSelector} selected unique use; shared next query ${shared + 1}`; continue }
      if (internalQueries >= 4 || depth >= 2 || sourceRows >= DEFINITION_LIMITS.sourceRows) { item.routeStatus = 'stopped'; item.routeNote = 'Continuation depth/query/source budget exhausted'; continue }
      scheduledRoutes.set(routeKey, cursors.length)
      internalQueries++
      item.routeStatus = 'queued'; item.routeNote = `${selectedSelector} selected unique use; next query ${cursors.length + 1}`
      cursors.push({ file_path: call.file_path, path: call.file_path, target: call.target,
        line: call.line, character: call.character, sourceSymbol: call.name, sourceRole: 'reference', expected_symbol: call.name,
        follow: automatic ? undefined : q.follow!.slice(1), depth: depth + 1, parentQuery: item.index,
        parentTarget: [...item.targets.map(t => `${t.path}:${t.line}:${t.character}`)].join(', '), rootIndex: q.rootIndex ?? item.index })
    }
    if (waveStart === cursors.length) break
  }
  signal.throwIfAborted()
  // Check each read file once at the end instead of re-statting it on every cached access.
  for (const [key, value] of texts) {
    if ((await fs.stat(sourceTargets.get(key)!, signal))?.version !== value.version) {
      throw new Error('Source changed during navigation; retry with current coordinates')
    }
  }
  return { items: responses.map(r => r.item), lspQueries, bytesRead, sourceRows,
    omittedTargets: responses.reduce((n, r) => n + r.item.omitted, 0) }
}

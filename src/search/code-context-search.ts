import { scanContextAst, type ContextDeclarationInfo, type ContextRange } from '../ast/typescript-context-ranges.js'
import { searchSemanticSeeds, type SemanticSeed } from './semantic-context-search.js'
import type { SemanticIndexConfig } from '../semantic/types.js'
import {
  buildSearchPattern,
  findParsedTermIndex,
  hasParsedTerm,
  parseExplicitRegexPattern,
  parseSearchTerm,
  splitTopLevelAlternation,
  validateIncludeGlob,
  type ParsedSearchTerm,
} from './literal-pattern.js'
import { isWorkspaceRelativePath, normalizeWorkspacePath } from '../workspace-path.js'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ToolExecution, ToolRuntime } from '@deepseek-ai/dsh-tools'

const MAX_MATCHES = 2000
const MAX_TERMS = 12
const MAX_FILES = 12
const MAX_LOCATION_FILES = 20
const MAX_FILE_BYTES = 1024 * 1024
const MAX_READ_BYTES = 4 * MAX_FILE_BYTES
const MAX_WINDOWS = 120
const MAX_BLOCK_BYTES = 2048
const SINGLE_FILE_BLOCK_BYTES = 4096
const MAX_TEXT_BYTES = 8192
const GREP_TIMEOUT_MS = 15_000
const GREP_RETRY_TIMEOUT_MS = 8_000
const SOFT_DEADLINE_MS = 23_000
const LONG_LINE_EXCERPT_RADIUS = 300
const encoder = new TextEncoder()
const supported = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i
const identifierShape = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export type ContextMode = 'auto' | 'lexical' | 'hybrid'
export type ContextView = 'fragments' | 'locations'
export interface ContextQuery {
  terms?: string[]
  pattern?: string
  include?: string
  view?: ContextView
  query?: string
  mode?: ContextMode
  path?: string
  limit?: number
  caseSensitive?: boolean
}
export type FragmentSource = 'lexical-window' | 'declaration-context' | 'declaration-partial'
export interface SourceAnchor {
  kind: 'match' | 'declaration'
  name: string
  line: number
  /** 1-based UTF-16 column, the same unit as the host LSP tools. */
  character: number
}
export interface CodeFragment {
  path: string
  startLine: number
  endLine: number
  text: string
  source: FragmentSource
  matchedTerms: string[]
  contextStartLine: number
  contextEndLine: number
  anchors: SourceAnchor[]
  /** True when the line exceeded 2 KiB and only a bounded match excerpt is shown. */
  isLongLineExcerpt?: boolean
  /** True only when this fragment's range came from a vector seed. */
  seededByVector?: boolean
  seedStartLine?: number
  seedEndLine?: number
  /** How much of this fragment's seed range the fragment covers. */
  seedCoverage?: 'full' | 'partial'
}
export interface LocationHit {
  line: number
  character: number
  preview: string
  matchedTerms: string[]
  declarationName?: string
  declarationKind?: string
  declarationLine?: number
  declarationCharacter?: number
}
export interface FileLocations {
  path: string
  totalMatches: number
  hits: LocationHit[]
}
export interface ExtraMatchedFile {
  path: string
  matches: number
  lines: number[]
}
export interface DeclarationCoord {
  name: string
  path: string
  line: number
  character: number
  kind: string
  container: string
}
export interface OmittedRangeHint {
  path: string
  name: string
  startLine: number
  endLine: number
}
export interface TermCoverage {
  term: string
  matchedFiles: number
  matchedLines: number
  selectedFragments: number
  anchorFragments: number
  omittedReason?: string
}
export interface ContextResult {
  view: ContextView
  matchesFound: number
  candidateFiles: number
  filesRead: number
  bytesRead: number
  skipped: { path: string; reason: string }[]
  limits: string[]
  interpretations: string[]
  declarationCoords: DeclarationCoord[]
  omittedRanges: OmittedRangeHint[]
  truncated: boolean
  usedVector: boolean
  vectorHits: number
  queryEmbeddings: number
  vectorOnlyFiles: number
  vectorSeededFragments: number
  seedCoveredFragments: number
  vectorStatus: 'off' | 'ok' | 'empty' | 'reused' | 'unavailable' | 'stale' | 'invalid' | 'error'
  vectorTrigger: 'none' | 'hybrid' | 'query-only' | 'lexical-empty' | 'lexical-weak'
  terms: TermCoverage[]
  fragments: CodeFragment[]
  locations: FileLocations[]
  extraMatchedFiles: ExtraMatchedFile[]
}

function workspacePath(path: string): string {
  if (!isWorkspaceRelativePath(path)) {
    throw new Error('path must be a workspace-relative file or directory without parent traversal')
  }
  return normalizeWorkspacePath(path)
}

function validTermToken(term: string): boolean {
  if (term.length < 1 || term.length > 128 || /[\r\n\0]/.test(term)) return false
  return /\S/.test(term)
}

function safeSliceUtf16(text: string, start: number, end: number): [number, number, string] {
  let s = Math.max(0, start)
  let e = Math.min(text.length, end)
  if (s > 0 && s < text.length) {
    const code = text.charCodeAt(s)
    if (code >= 0xDC00 && code <= 0xDFFF) s--
  }
  if (e > 0 && e < text.length) {
    const prev = text.charCodeAt(e - 1)
    if (prev >= 0xD800 && prev <= 0xDBFF) e++
  }
  return [s, e, text.slice(s, e)]
}

function longLineExcerpt(line: string, matchCol: number, maxChars = LONG_LINE_EXCERPT_RADIUS * 2): string {
  if (line.length <= maxChars) return line
  const half = Math.floor(maxChars / 2)
  const rawStart = Math.max(0, matchCol - half)
  const rawEnd = Math.min(line.length, rawStart + maxChars)
  const adjustedStart = Math.max(0, rawEnd - maxChars)
  const [s, e, slice] = safeSliceUtf16(line, adjustedStart, rawEnd)
  const prefix = s > 0 ? '…' : ''
  const suffix = e < line.length ? '…' : ''
  return `${prefix}${slice}${suffix} [excerpt chars ${s + 1}-${e} of ${line.length}]`
}

function validateQuery(args: ContextQuery): {
  parsedTerms: ParsedSearchTerm[]
  searchTerms: ParsedSearchTerm[]
  include?: string
  view: ContextView
  query?: string
  mode: ContextMode
  path: string
  limit: number
  limitClampNote?: string
  caseSensitive: boolean
} {
  const caseSensitive = args.caseSensitive ?? false
  const view: ContextView = args.view ?? 'fragments'
  if (view !== 'fragments' && view !== 'locations') {
    throw new Error('view must be "fragments" or "locations"')
  }
  const termMessage = 'terms must contain 1–12 non-empty search terms (2–128 chars for ASCII, or any non-ASCII symbol/emoji)'
  const expanded: string[] = []
  for (const raw of args.terms ?? []) {
    const trimmed = raw.trim()
    if (!trimmed) throw new Error(termMessage)
    const parts = splitTopLevelAlternation(trimmed)
    if (parts.length === 0) throw new Error(termMessage)
    expanded.push(...parts)
  }
  const uniqueRaw: string[] = []
  const seen = new Set<string>()
  for (const item of expanded) {
    const key = caseSensitive ? item : item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    uniqueRaw.push(item)
  }
  if (uniqueRaw.length > MAX_TERMS) throw new Error('terms must contain at most 12 search terms')
  if (uniqueRaw.some(term => !validTermToken(term))) throw new Error(termMessage)
  const parsedTerms = uniqueRaw.map(raw => parseSearchTerm(raw, caseSensitive))

  let parsedPattern: ParsedSearchTerm | undefined
  if (args.pattern !== undefined) {
    const trimmed = args.pattern.trim()
    if (!trimmed || trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) {
      throw new Error('pattern must contain 1–256 non-empty characters')
    }
    parsedPattern = parseExplicitRegexPattern(trimmed, caseSensitive)
  }
  const searchTerms = parsedPattern ? [...parsedTerms, parsedPattern] : parsedTerms

  const include = args.include !== undefined ? validateIncludeGlob(args.include) : undefined
  const query = args.query?.trim()
  const mode = args.mode ?? 'auto'
  if (searchTerms.length === 0 && !query) {
    throw new Error('provide 1–12 terms, a regex pattern, or a natural-language query')
  }
  if (query !== undefined && (query.length < 1 || query.length > 1000 || /\0/.test(query))) {
    throw new Error('query must contain 1–1000 characters')
  }
  if (mode === 'lexical' && searchTerms.length === 0) throw new Error('lexical mode requires at least one term or pattern')
  if (mode === 'hybrid' && !query) throw new Error('hybrid mode requires a natural-language query')

  const maxLimit = view === 'locations' ? MAX_LOCATION_FILES : 6
  const defaultLimit = view === 'locations' ? 12 : 4
  let limit = defaultLimit
  let limitClampNote: string | undefined
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit)) {
      throw new Error(`limit must be a finite number`)
    }
    const rounded = Math.round(args.limit)
    limit = Math.max(1, Math.min(maxLimit, rounded))
    if (limit !== args.limit) {
      limitClampNote = `limit clamped from ${args.limit} to ${limit} (supported range 1–${maxLimit} for ${view} view)`
    }
  }
  return {
    parsedTerms,
    searchTerms,
    include,
    view,
    query,
    mode,
    path: workspacePath(args.path ?? '.'),
    limit,
    limitClampNote,
    caseSensitive,
  }
}

interface VectorSeed { startLine: number; endLine: number; rank: number; score: number }
interface SemanticQueryCacheEntry { seeds: SemanticSeed[]; queryEmbeddings: number; truncated: boolean; limits: string[] }
export interface SemanticQueryCache { entries: Map<string, SemanticQueryCacheEntry> }
interface SourceHit { line: number; text: string; seed?: VectorSeed }
interface ContextUnit {
  fragments: CodeFragment[]
  terms: string[]
  name: string
  path: string
  start: number
  end: number
  origin: 'lexical' | 'vector' | 'both'
  seedRank?: number
}
interface CandidateMatches { hits: { line: number; text: string }[]; terms: Set<string>; seeds: VectorSeed[] }
interface Candidate { file: string; entry: CandidateMatches }

/** A cheap pre-read signal, not a declaration proof. */
function declarationLike(line: string, term: ParsedSearchTerm, caseSensitive: boolean): boolean {
  if (term.kind !== 'literal') return false
  const escaped = term.rgSubpattern
  const flags = caseSensitive ? '' : 'i'
  return [
    new RegExp(`\\b(?:function|class|interface|type|enum|namespace|const|let|var)\\s+${escaped}\\b`, flags),
    new RegExp(`\\b(?:get|set)\\s+${escaped}\\s*\\(`, flags),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`, flags),
    new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`, flags),
  ].some(pattern => pattern.test(line))
}

function selectEnclosingDeclaration(
  declarations: ContextRange[],
  hitIndex: number,
  terms: readonly ParsedSearchTerm[],
  lineText: string,
  caseSensitive: boolean,
  seed?: VectorSeed,
  seedFirst = hitIndex,
  seedLast = hitIndex,
): { declaration?: ContextRange; spanDecls: ContextRange[] } {
  const overlap = (range: { start: number; end: number }) => Math.max(0,
    Math.min(range.end, seedLast) - Math.max(range.start, seedFirst) + 1)
  const enclosing = seed
    ? declarations.filter(range => range.end >= seedFirst && range.matchStart <= seedLast)
      .sort((a, b) => overlap(b) - overlap(a) || (a.end - a.start) - (b.end - b.start))
    : declarations.filter(range => range.matchStart <= hitIndex && range.end >= hitIndex)
      .sort((a, b) => (a.end - a.matchStart) - (b.end - b.matchStart))
  const named = seed ? [] : enclosing.filter(range => range.matchStart === hitIndex
    && terms.some(term => term.kind === 'literal' && sameText(term.literal ?? term.raw, range.name, caseSensitive))
    && lineText.includes(range.name))
  const sameLine = seed ? [] : enclosing.filter(range => range.matchStart === hitIndex)
  const containingAll = seed ? declarations.filter(range => range.matchStart <= seedFirst && range.end >= seedLast)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start)) : []
  const containingStart = seed ? declarations.filter(range => range.matchStart <= seedFirst && range.end >= seedFirst)
    .sort((a, b) => overlap(b) - overlap(a) || (a.end - a.start) - (b.end - b.start)) : []
  const bestStart = containingStart[0]
  const declaration = seed
    ? containingAll[0] ?? (bestStart && overlap(bestStart) > 0 ? bestStart : undefined)
    : named.length === 1 ? named[0]
      : sameLine.length > 1 ? undefined : enclosing[0]
  const spanDecls = seed ? declarations.filter(range => overlap(range) > 0) : declaration ? [declaration] : []
  return { declaration, spanDecls }
}

function sameText(a: string, b: string, caseSensitive: boolean): boolean {
  return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase()
}

function sourceUnits(
  path: string,
  source: string,
  hits: SourceHit[],
  terms: readonly ParsedSearchTerm[],
  limit: number,
  signal: AbortSignal,
  mark: (reason: string) => void,
  caseSensitive: boolean,
  singleFileMode: boolean,
  astDeclarations: ContextRange[],
): ContextUnit[] {
  const lines = source.split('\n')
  const declarations = astDeclarations
  const maxLinesPerBlock = singleFileMode ? 80 : 40
  const maxBlockBytes = singleFileMode ? SINGLE_FILE_BLOCK_BYTES : MAX_BLOCK_BYTES
  const units = new Map<string, ContextUnit>()
  const uniqueHits = [...new Map(hits.map(hit => [`${hit.line}:${hit.seed?.startLine ?? ''}:${hit.seed?.endLine ?? ''}`, hit])).values()]
    .sort((a, b) => a.line - b.line || (a.seed?.startLine ?? 0) - (b.seed?.startLine ?? 0))
  for (const hit of uniqueHits) {
    signal.throwIfAborted()
    const seed = hit.seed, hitIndex = hit.line - 1
    const seedFirst = seed ? Math.max(0, seed.startLine - 1) : hitIndex
    const seedLast = seed ? Math.min(lines.length - 1, seed.endLine - 1) : hitIndex
    const focusFirst = seed ? seedFirst : Math.max(0, hitIndex - 4)
    const focusLast = seed ? seedLast : Math.min(lines.length - 1, hitIndex + 8)
    const { declaration, spanDecls } = selectEnclosingDeclaration(
      declarations, hitIndex, terms, lines[hitIndex] ?? '', caseSensitive, seed, seedFirst, seedLast,
    )
    const spanFirst = spanDecls.length ? Math.min(seedFirst, ...spanDecls.map(range => range.start)) : undefined
    const spanLast = spanDecls.length ? Math.max(seedLast, ...spanDecls.map(range => range.end)) : undefined
    const hitAnchors: SourceAnchor[] = []
    const anchorLines = seed
      ? Array.from({ length: seedLast - seedFirst + 1 }, (_, index) => ({ line: seedFirst + index + 1, text: lines[seedFirst + index] ?? '' }))
      : [{ line: hit.line, text: hit.text }]
    for (const item of anchorLines) {
      for (const term of terms) {
        const at = findParsedTermIndex(item.text, term, caseSensitive)
        if (at < 0) continue
        const bom = item.line === 1 && lines[0].startsWith('\uFEFF') && !item.text.startsWith('\uFEFF') ? 1 : 0
        hitAnchors.push({ kind: 'match', name: term.raw, line: item.line, character: at + 1 + bom })
      }
    }
    const declarationAnchor: SourceAnchor | undefined = declaration?.name
      ? { kind: 'declaration', name: declaration.name, line: declaration.nameLine + 1, character: declaration.nameCharacter }
      : undefined
    const allAnchors = declarationAnchor ? [declarationAnchor, ...hitAnchors] : hitAnchors
    let splitSkipped = false
    function split(first: number, last: number, sourceKind: FragmentSource,
      contextFirst: number, contextLast: number): CodeFragment[] | undefined {
      const pieces: CodeFragment[] = []
      for (let cursor = first; cursor <= last;) {
        signal.throwIfAborted()
        if (cursor < 0 || cursor >= lines.length) return pieces.length ? pieces : undefined
        const text: string[] = []; let bytes = 0, next = cursor
        while (next <= last && next < lines.length && text.length < maxLinesPerBlock) {
          const size = encoder.encode(lines[next]).byteLength + (text.length ? 1 : 0)
          if (bytes + size > maxBlockBytes) break
          bytes += size; text.push(lines[next++])
        }
        if (!text.length) {
          const lineText = lines[cursor] ?? ''
          const byteLen = encoder.encode(lineText).byteLength
          if (byteLen > maxBlockBytes) {
            splitSkipped = true
            let matchCol = 0
            for (const term of terms) {
              const idx = findParsedTermIndex(lineText, term, caseSensitive)
              if (idx >= 0) { matchCol = idx; break }
            }
            const excerpt = longLineExcerpt(lineText, matchCol)
            const startLine = cursor + 1
            const matchedTerms = terms.filter(term => hasParsedTerm(lineText, term, caseSensitive, true)).map(t => t.raw)
            const anchors = [...new Map(allAnchors.filter(anchor => anchor.line === startLine)
              .map(anchor => [`${anchor.kind}:${anchor.name}:${anchor.line}:${anchor.character}`, anchor])).values()].slice(0, 3)
            mark(`${path}: line ${startLine} (${byteLen} B) truncated to excerpt`)
            pieces.push({
              path, startLine, endLine: startLine, text: excerpt, source: sourceKind,
              matchedTerms, contextStartLine: contextFirst + 1, contextEndLine: contextLast + 1,
              anchors, isLongLineExcerpt: true,
            })
            cursor++
            continue
          }
          return pieces.length ? pieces : undefined
        }
        const content = text.join('\n'), startLine = cursor + 1, endLine = next
        const anchors = [...new Map(allAnchors.filter(anchor => anchor.line >= startLine && anchor.line <= endLine)
          .map(anchor => [`${anchor.kind}:${anchor.name}:${anchor.line}:${anchor.character}`, anchor])).values()]
          .slice(0, 3)
        pieces.push({
          path, startLine, endLine, text: content, source: sourceKind,
          matchedTerms: terms.filter(term => hasParsedTerm(content, term, caseSensitive, !seed && startLine <= hit.line && endLine >= hit.line)).map(t => t.raw),
          contextStartLine: contextFirst + 1, contextEndLine: contextLast + 1, anchors,
        })
        cursor = next
      }
      return pieces
    }
    function withDeclarationAnchor(pieces: CodeFragment[] | undefined): CodeFragment[] | undefined {
      if (!declarationAnchor || !pieces?.length
        || pieces.some(piece => piece.anchors.some(anchor => anchor.kind === 'declaration'))) return pieces
      const [first, ...rest] = pieces
      return [{ ...first, anchors: [declarationAnchor, ...first.anchors].slice(0, 3) }, ...rest]
    }
    function markSeed(pieces: CodeFragment[] | undefined): CodeFragment[] | undefined {
      if (!seed || !pieces) return pieces
      for (const fragment of pieces) {
        if (fragment.endLine < seed.startLine || fragment.startLine > seed.endLine) continue
        fragment.seededByVector = true
        fragment.seedStartLine = seed.startLine
        fragment.seedEndLine = seed.endLine
        fragment.seedCoverage = fragment.startLine <= seed.startLine && fragment.endLine >= seed.endLine ? 'full' : 'partial'
      }
      return pieces
    }
    splitSkipped = false
    const full = spanFirst !== undefined && spanLast !== undefined
      ? withDeclarationAnchor(split(spanFirst, spanLast, 'declaration-context', spanFirst, spanLast)) : undefined
    const fullComplete = !splitSkipped
    const fullBytes = full?.reduce((n, fragment) => n + encoder.encode(fragment.text).byteLength, 0) ?? 0
    let fragments: CodeFragment[] | undefined
    let key: string
    if (spanFirst !== undefined && spanLast !== undefined && full && fullComplete
      && full.length <= limit && fullBytes <= MAX_TEXT_BYTES) {
      fragments = markSeed(full)
      key = `${spanFirst}:${spanLast}:declaration-context`
    } else if (spanFirst !== undefined && spanLast !== undefined) {
      mark('declaration context reduced to a bounded partial range')
      const ranges = [
        { first: Math.max(spanFirst, focusFirst), last: Math.min(spanLast, focusLast), priority: 0 },
      ]
      for (const range of spanDecls) {
        ranges.push({ first: range.start, last: Math.min(range.end, range.matchStart + 2), priority: 1 })
        if (range.end - 2 > focusLast + 2) ranges.push({ first: Math.max(range.start, range.end - 1), last: range.end, priority: 2 })
      }
      const merged: typeof ranges = []
      for (const range of ranges.sort((a, b) => a.first - b.first)) {
        const previous = merged[merged.length - 1]
        if (previous && range.first <= previous.last + 1) {
          previous.last = Math.max(previous.last, range.last)
          previous.priority = Math.min(previous.priority, range.priority)
        } else merged.push({ ...range })
      }
      const pieces: CodeFragment[] = []
      for (const range of merged.sort((a, b) => a.priority - b.priority || a.first - b.first)) {
        const part = split(range.first, range.last, 'declaration-partial', spanFirst, spanLast)
        if (!part) continue
        for (const piece of part) {
          if (pieces.length >= limit) break
          pieces.push(piece)
        }
        if (pieces.length >= limit) break
      }
      pieces.sort((a, b) => a.startLine - b.startLine)
      fragments = markSeed(withDeclarationAnchor(pieces))
      key = `${spanFirst}:${spanLast}:declaration-partial:${hit.line}`
    } else {
      const first = seed ? seedFirst : Math.max(0, hitIndex - 8)
      const last = seed ? seedLast : Math.min(lines.length - 1, hitIndex + 8)
      fragments = markSeed(split(first, last, 'lexical-window', first, last))
      key = `${first}:${last}:lexical-window`
    }
    if (seed) key += `:seed:${seed.startLine}-${seed.endLine}:${seed.rank}`
    if (!fragments?.length) { mark('no usable source lines'); continue }
    const unitTerms = [...new Set(fragments.flatMap(fragment => fragment.matchedTerms))]
    const unit: ContextUnit = {
      fragments,
      terms: unitTerms,
      name: declaration?.name ?? '',
      path,
      start: fragments[0].startLine - 1,
      end: fragments[fragments.length - 1].endLine - 1,
      origin: seed ? 'vector' : 'lexical',
      seedRank: seed?.rank,
    }
    const existing = units.get(key)
    if (!existing) { units.set(key, unit); continue }
    existing.origin = existing.origin === unit.origin ? unit.origin : 'both'
    existing.seedRank = existing.seedRank === undefined ? unit.seedRank : unit.seedRank === undefined ? existing.seedRank : Math.min(existing.seedRank, unit.seedRank)
    const byRange = new Map(existing.fragments.map(fragment => [`${fragment.startLine}:${fragment.endLine}`, fragment]))
    for (const fragment of fragments) {
      const previous = byRange.get(`${fragment.startLine}:${fragment.endLine}`)
      if (!previous) { byRange.set(`${fragment.startLine}:${fragment.endLine}`, fragment); continue }
      previous.matchedTerms = [...new Set([...previous.matchedTerms, ...fragment.matchedTerms])]
      previous.seededByVector = Boolean(previous.seededByVector || fragment.seededByVector)
      if (fragment.seedStartLine !== undefined) previous.seedStartLine = previous.seedStartLine ?? fragment.seedStartLine
      if (fragment.seedEndLine !== undefined) previous.seedEndLine = previous.seedEndLine ?? fragment.seedEndLine
      if (fragment.seedCoverage === 'full' || previous.seedCoverage === 'full') previous.seedCoverage = 'full'
      else if (fragment.seedCoverage === 'partial' || previous.seedCoverage === 'partial') previous.seedCoverage = 'partial'
      previous.anchors = [...new Map([...previous.anchors, ...fragment.anchors]
        .map(anchor => [`${anchor.kind}:${anchor.name}:${anchor.line}:${anchor.character}`, anchor])).values()].slice(0, 3)
    }
    existing.fragments = [...byRange.values()].sort((a, b) => a.startLine - b.startLine)
    existing.terms = [...new Set([...existing.terms, ...unitTerms])]
  }
  return [...units.values()]
}

async function executeHostGrep(
  tools: ToolRuntime,
  exec: ToolExecution,
  pattern: string,
  path: string,
  include: string,
  timeoutMs: number,
): Promise<{ matches: unknown[]; timedOut: boolean }> {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(exec.signal.reason)
  if (exec.signal.aborted) controller.abort(exec.signal.reason)
  else exec.signal.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('internal grep timeout')), timeoutMs)
  try {
    const outcome = await tools.execute({
      name: 'grep',
      arguments: { pattern, path, include },
      callId: `${exec.callId}:grep` as typeof exec.callId,
      rootCallId: exec.rootCallId,
      parent: exec.token,
      agent: exec.agent,
      signal: controller.signal,
    })
    exec.signal.throwIfAborted()
    if (outcome.isError) {
      if (controller.signal.aborted && !exec.signal.aborted) {
        return { matches: [], timedOut: true }
      }
      throw new Error(`host grep failed: ${outcome.error.message}`)
    }
    const value: unknown = outcome.value
    if (typeof value !== 'object' || value === null || !('matches' in value) || !Array.isArray(value.matches)) {
      throw new Error('host grep returned no structured matches')
    }
    return { matches: value.matches, timedOut: false }
  } catch (error) {
    exec.signal.throwIfAborted()
    if (controller.signal.aborted) return { matches: [], timedOut: true }
    throw error
  } finally {
    clearTimeout(timer)
    exec.signal.removeEventListener('abort', onParentAbort)
  }
}

export async function searchCodeContext(
  fs: FileSystem,
  tools: ToolRuntime,
  args: ContextQuery,
  exec: ToolExecution,
  semantic?: SemanticIndexConfig,
  semanticCache?: SemanticQueryCache,
): Promise<ContextResult> {
  const startedAt = Date.now()
  const softDeadline = startedAt + SOFT_DEADLINE_MS
  const rawPath = args.path ?? '.'
  const absolute = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath)
  const {
    searchTerms, include, view, query, mode, path: relativePath, limit, limitClampNote, caseSensitive,
  } = validateQuery({ ...args, path: absolute ? '.' : rawPath })
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  if (mode === 'hybrid' && !semantic) throw new Error('hybrid mode requires a configured semanticIndex')
  if (searchTerms.length === 0 && !semantic) throw new Error('a natural-language query requires a configured semanticIndex; provide terms or pattern')
  exec.signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd, signal: exec.signal })
  if (fs.processPath(root).replace(/[\\/]+$/, '') !== cwd.replace(/[\\/]+$/, '')) {
    throw new Error('host grep and fs must use the same Session process workspace')
  }
  const scope = await fs.resolve(absolute ? rawPath : relativePath, { cwd, signal: exec.signal })
  if (!fs.contains(root, scope)) throw new Error('search path is outside the Session workspace')
  const scopeInfo = await fs.stat(scope, exec.signal)
  const singleFileMode = scopeInfo?.type === 'file'
  const scopePath = fs.processPath(scope), rootPath = fs.processPath(root).replace(/[\\/]+$/, '')
  const path = workspacePath(scopePath === rootPath ? '.' : scopePath.slice(rootPath.length + 1).replace(/\\/g, '/'))

  const files = new Map<string, CandidateMatches>()
  const nonTsMatchedLines = new Map<string, number[]>()
  const earlyLimits: string[] = []
  let earlyTruncated = false
  if (limitClampNote) earlyLimits.push(limitClampNote)
  let activeTerms = searchTerms
  let rawMatches: unknown[] = []
  let matchLimitHit = false

  if (searchTerms.length) {
    if (tools.get('grep', exec.agent) === undefined) throw new Error('host grep is unavailable')
    const grepInclude = include ?? '*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'
    const firstRun = await executeHostGrep(
      tools, exec, buildSearchPattern(searchTerms, caseSensitive), path, grepInclude, GREP_TIMEOUT_MS,
    )
    if (firstRun.timedOut) {
      earlyTruncated = true
      const selective = searchTerms.filter(term => term.kind === 'regex' || (term.literal ?? term.raw).length >= 4)
      if (selective.length > 0 && selective.length < searchTerms.length) {
        const dropped = searchTerms.filter(term => !selective.includes(term)).map(term => term.raw)
        earlyLimits.push(`initial search timed out after 15s; excluded short/broad term(s) [${dropped.join(', ')}] and returned partial results`)
        activeTerms = selective
        const retryRun = await executeHostGrep(
          tools, exec, buildSearchPattern(selective, caseSensitive), path, grepInclude, GREP_RETRY_TIMEOUT_MS,
        )
        if (retryRun.timedOut) {
          earlyLimits.push('retry grep timed out; narrow path or include')
        } else {
          rawMatches = retryRun.matches
        }
      } else {
        earlyLimits.push('search timed out after 15s; narrow path or include, or avoid short high-frequency terms')
      }
    } else {
      rawMatches = firstRun.matches
    }

    matchLimitHit = rawMatches.length > MAX_MATCHES
    const singlePatternFallback = activeTerms.length === 1 && activeTerms[0].kind === 'regex'
    for (const match of (matchLimitHit ? rawMatches.slice(0, MAX_MATCHES) : rawMatches) as unknown[]) {
      exec.signal.throwIfAborted()
      if (typeof match !== 'object' || match === null || typeof (match as { path?: unknown }).path !== 'string'
        || !Number.isSafeInteger((match as { lineNumber?: unknown }).lineNumber)
        || (match as { lineNumber: number }).lineNumber < 1 || typeof (match as { line?: unknown }).line !== 'string') {
        throw new Error('host grep returned an invalid match')
      }
      const parsed = match as { path: string; lineNumber: number; line: string }
      const file = workspacePath(parsed.path)
      if (!supported.test(file)) {
        const list = nonTsMatchedLines.get(file) ?? []
        list.push(parsed.lineNumber)
        nonTsMatchedLines.set(file, list)
        continue
      }
      let entry = files.get(file)
      if (!entry) { entry = { hits: [], terms: new Set(), seeds: [] }; files.set(file, entry) }
      entry.hits.push({ line: parsed.lineNumber, text: parsed.line })
      for (const term of activeTerms) {
        if (hasParsedTerm(parsed.line, term, caseSensitive, singlePatternFallback)) entry.terms.add(term.raw)
      }
    }
  }

  const interpretations = [...new Set(activeTerms.map(t => t.interpretation).filter((x): x is string => Boolean(x)))]
  const result: ContextResult = {
    view,
    matchesFound: rawMatches.length,
    candidateFiles: files.size,
    filesRead: 0,
    bytesRead: 0,
    skipped: [],
    limits: [...earlyLimits],
    interpretations,
    declarationCoords: [],
    omittedRanges: [],
    truncated: earlyTruncated,
    usedVector: false,
    vectorHits: 0,
    queryEmbeddings: 0,
    vectorOnlyFiles: 0,
    vectorSeededFragments: 0,
    seedCoveredFragments: 0,
    vectorStatus: 'off',
    vectorTrigger: 'none',
    terms: [],
    fragments: [],
    locations: [],
    extraMatchedFiles: [],
  }
  const mark = (reason: string) => {
    result.truncated = true
    const text = reason.length > 512 ? `${reason.slice(0, 512)}…` : reason
    if (result.limits.length < 64 && !result.limits.includes(text)) result.limits.push(text)
  }
  for (const [file, lines] of nonTsMatchedLines) {
    if (result.skipped.length >= 20) break
    const previewLines = lines.slice(0, 5).map(n => `L${n}`).join(', ')
    result.skipped.push({
      path: file,
      reason: `non-TS/JS file (${lines.length} match(es): ${previewLines}${lines.length > 5 ? ', …' : ''}; use read or grep)`,
    })
  }
  if (nonTsMatchedLines.size && files.size === 0) mark('only non-TS/JS files matched')
  if (matchLimitHit) mark(`match limit (${MAX_MATCHES}); first ${MAX_MATCHES} of ${rawMatches.length} matches processed`)

  const termStats = new Map(activeTerms.map(term => [term.raw, { matchedFiles: 0, matchedLines: 0 }]))
  const singlePatternFallback = activeTerms.length === 1 && activeTerms[0].kind === 'regex'
  for (const entry of files.values()) {
    for (const term of activeTerms) {
      if (!entry.terms.has(term.raw)) continue
      const stat = termStats.get(term.raw)!
      stat.matchedFiles++
      stat.matchedLines += entry.hits.reduce((n, hit) => n + (hasParsedTerm(hit.text, term, caseSensitive, singlePatternFallback) ? 1 : 0), 0)
    }
  }
  if (matchLimitHit) {
    const noisy = activeTerms
      .map(term => ({ term, lines: termStats.get(term.raw)?.matchedLines ?? 0 }))
      .filter(item => item.lines >= 100 && (item.term.raw.length <= 4 || item.lines >= 400))
      .sort((a, b) => b.lines - a.lines)
    if (noisy.length) {
      mark(`high-frequency term(s): ${noisy.map(item => `${item.term.raw} (${item.lines} lines)`).join(', ')} — omit short/broad terms or narrow path/include`)
    }
  }

  const weakLexical = files.size === 0 || activeTerms.some(term => (termStats.get(term.raw)?.matchedFiles ?? 0) === 0)
  const useVector = semantic !== undefined && query !== undefined
    && (mode === 'hybrid' || activeTerms.length === 0 || (mode === 'auto' && weakLexical))
  result.vectorTrigger = !useVector ? 'none' : activeTerms.length === 0 ? 'query-only' : mode === 'hybrid' ? 'hybrid'
    : files.size === 0 ? 'lexical-empty' : 'lexical-weak'
  if (useVector) {
    const cacheKey = `${semantic!.embedding.id}\0${semantic!.files.join('|')}\0${query!}\0${path}\0${limit}`
    let vector: { seeds: SemanticSeed[]; queryEmbeddings: number; truncated: boolean; limits: string[] } | undefined
    let reused = false
    const cached = semanticCache?.entries.get(cacheKey)
    if (cached) {
      vector = cached
      reused = true
      result.vectorStatus = 'reused'
    } else {
      try {
        vector = await searchSemanticSeeds(fs, semantic!, { query: query!, path, limit: 8 },
          { cwd, signal: exec.signal }, semantic)
      } catch (error) {
        exec.signal.throwIfAborted()
        const reason = error instanceof Error ? error.message : String(error)
        result.vectorStatus = /stale/.test(reason) ? 'stale' : /invalid or incompatible/.test(reason) ? 'invalid' : 'unavailable'
        if (activeTerms.length === 0) throw new Error(`semantic candidates unavailable: ${reason}`)
        mark(`vector unavailable (${result.vectorStatus}); lexical fallback`)
      }
    }
    if (vector) {
      result.usedVector = true
      result.queryEmbeddings = reused ? 0 : vector.queryEmbeddings
      result.vectorHits = vector.seeds.length
      if (!reused) result.vectorStatus = vector.seeds.length ? 'ok' : 'empty'
      for (const seed of vector.seeds) {
        const file = workspacePath(seed.path)
        if (!supported.test(file)) continue
        let entry = files.get(file)
        if (!entry) { entry = { hits: [], terms: new Set(), seeds: [] }; files.set(file, entry) }
        if (!entry.seeds.some(existing => seed.startLine <= existing.endLine && seed.endLine >= existing.startLine)) {
          entry.seeds.push({ startLine: seed.startLine, endLine: seed.endLine, rank: seed.rank, score: seed.score })
        }
      }
      if (vector.truncated && !reused) {
        const shown = vector.limits.slice(0, 8)
        mark(`vector candidate limits: ${shown.join('; ')}${vector.limits.length > shown.length ? `; +${vector.limits.length - shown.length} more` : ''}`)
      }
      if (semanticCache && !reused) {
        semanticCache.entries.set(cacheKey, vector)
        while (semanticCache.entries.size > 8) semanticCache.entries.delete(semanticCache.entries.keys().next().value!)
      }
      result.candidateFiles = files.size
    }
  }

  const candidates: Candidate[] = []
  for (const [file, entry] of files) {
    if (path !== '.' && (singleFileMode ? file !== path : (file !== path && !file.startsWith(path + '/')))) {
      throw new Error(`candidate is outside search scope: ${file}`)
    }
    candidates.push({ file, entry })
  }
  const termFrequency = new Map(activeTerms.map(term => [term.raw,
    [...files.values()].filter(entry => entry.terms.has(term.raw)).length]))
  const termWeight = (termRaw: string) => Math.log(1 + files.size / Math.max(1, termFrequency.get(termRaw) ?? 0))
  const termByRaw = new Map(activeTerms.map(term => [term.raw, term]))
  const candidateScore = (candidate: Candidate) => {
    let score = 0
    for (const termRaw of candidate.entry.terms) {
      const term = termByRaw.get(termRaw)
      score += termWeight(termRaw)
      if (term && candidate.entry.hits.some(hit => hasParsedTerm(hit.text, term, caseSensitive, singlePatternFallback)
        && declarationLike(hit.text, term, caseSensitive))) score += 1
    }
    return score
  }
  const scores = new Map(candidates.map(candidate => [candidate, candidateScore(candidate)]))
  candidates.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0)
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  const fileCap = view === 'locations' ? Math.max(MAX_FILES, limit) : MAX_FILES
  const selected = new Set<Candidate>()
  const hasTerm = (candidate: Candidate, termRaw: string) => candidate.entry.terms.has(termRaw)
  const hasDeclarationHit = (candidate: Candidate, term: ParsedSearchTerm) => candidate.entry.hits.some(hit =>
    hasParsedTerm(hit.text, term, caseSensitive, singlePatternFallback) && declarationLike(hit.text, term, caseSensitive))
  for (const term of [...activeTerms].sort((a, b) => (termFrequency.get(a.raw) ?? 0) - (termFrequency.get(b.raw) ?? 0))) {
    const selectedHasTerm = [...selected].some(candidate => hasTerm(candidate, term.raw))
    const selectedHasDeclaration = [...selected].some(candidate => hasTerm(candidate, term.raw)
      && hasDeclarationHit(candidate, term))
    const withTerm = candidates.filter(candidate => hasTerm(candidate, term.raw))
    const declarationHit = withTerm.find(candidate => hasDeclarationHit(candidate, term))
    if (selectedHasTerm && (selectedHasDeclaration || !declarationHit)) continue
    const candidate = declarationHit ?? withTerm[0]
    if (candidate && selected.size < fileCap) selected.add(candidate)
  }
  const vectorOnly = candidates.filter(candidate => candidate.entry.terms.size === 0 && candidate.entry.seeds.length > 0)
    .sort((a, b) => Math.min(...a.entry.seeds.map(seed => seed.rank)) - Math.min(...b.entry.seeds.map(seed => seed.rank)))
  const lexicalCandidates = candidates.filter(candidate => candidate.entry.terms.size > 0)
  const lexicalCap = activeTerms.length && useVector ? Math.max(0, fileCap - Math.min(2, vectorOnly.length)) : fileCap
  for (const candidate of lexicalCandidates) {
    if (selected.size >= lexicalCap) break
    selected.add(candidate)
  }
  for (const candidate of vectorOnly) {
    if (selected.size >= fileCap) break
    selected.add(candidate)
  }
  for (const candidate of candidates) {
    if (selected.size >= fileCap) break
    selected.add(candidate)
  }
  if (candidates.length > fileCap) mark(`candidate file limit (${fileCap})`)
  result.vectorOnlyFiles = [...selected].filter(candidate => candidate.entry.terms.size === 0 && candidate.entry.seeds.length > 0).length
  const vectorOnlyPaths = new Set(vectorOnly.map(candidate => candidate.file))

  const identifierTerms = activeTerms.filter(term => term.kind === 'literal' && identifierShape.test(term.literal ?? term.raw))
  const seenDeclCoordKeys = new Set<string>()
  const collectDeclarationCoords = (file: string, decls: ContextDeclarationInfo[]) => {
    if (!identifierTerms.length || result.declarationCoords.length >= 12) return
    for (const decl of decls) {
      if (!identifierTerms.some(term => sameText(term.literal ?? term.raw, decl.name, caseSensitive))) continue
      const key = `${decl.name}:${file}:${decl.line}:${decl.character}`
      if (seenDeclCoordKeys.has(key)) continue
      seenDeclCoordKeys.add(key)
      result.declarationCoords.push({
        name: decl.name, path: file, line: decl.line, character: decl.character, kind: decl.kind, container: decl.container,
      })
      if (result.declarationCoords.length >= 12) break
    }
  }

  const units: ContextUnit[] = []
  for (const { file, entry } of selected) {
    exec.signal.throwIfAborted()
    if (Date.now() >= softDeadline) {
      mark('time budget reached; returning partial results from files read so far')
      break
    }
    const skip = (reason: string) => { result.skipped.push({ path: file, reason }); mark('partial source coverage') }
    const target = await fs.resolve(file, { cwd, signal: exec.signal })
    if (!fs.contains(root, target) || !fs.contains(scope, target)) {
      skip('candidate resolved outside search scope')
      continue
    }
    let source: string
    try {
      const info = await fs.stat(target, exec.signal)
      if (!info || info.type !== 'file') { skip('not a regular file'); continue }
      if (info.size === undefined || info.size > MAX_FILE_BYTES) {
        if (view === 'locations' && entry.hits.length) {
          result.locations.push({
            path: file,
            totalMatches: entry.hits.length,
            hits: entry.hits.slice(0, 6).map(hit => {
              let col = 1
              for (const term of activeTerms) {
                const idx = findParsedTermIndex(hit.text, term, caseSensitive)
                if (idx >= 0) { col = idx + 1; break }
              }
              return {
                line: hit.line,
                character: col,
                preview: longLineExcerpt(hit.text.trim(), col - 1, 160),
                matchedTerms: activeTerms.filter(t => hasParsedTerm(hit.text, t, caseSensitive, singlePatternFallback)).map(t => t.raw),
              }
            }),
          })
          mark(`${file}: file exceeds 1 MiB; listed grep line locations without AST scan`)
          continue
        }
        skip('size unknown or file exceeds 1 MiB'); continue
      }
      if (result.bytesRead + info.size > MAX_READ_BYTES) { skip('total read budget (4 MiB)'); continue }
      const bytes = await fs.readBytes(target, exec.signal, Math.min(MAX_FILE_BYTES, MAX_READ_BYTES - result.bytesRead))
      result.bytesRead += bytes.byteLength
      result.filesRead++
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      exec.signal.throwIfAborted()
      skip('source read or decode failed')
      continue
    }
    if (source.includes('\0')) { skip('binary content'); continue }
    if (/\r(?!\n)|[\u2028\u2029]/.test(source)) { skip('unsupported line separators; use explicit file reading'); continue }
    const lines = source.split('\n')
    const lexicalHits = entry.hits.filter(hit => {
      let current = lines[hit.line - 1]
      if (hit.line < lines.length) current = current?.replace(/\r$/, '')
      let searched = hit.text
      if (hit.line === 1) {
        current = current?.replace(/^\uFEFF/, '')
        searched = searched.replace(/^\uFEFF/, '')
      }
      return current === searched && activeTerms.some(term => hasParsedTerm(hit.text, term, caseSensitive, singlePatternFallback))
    })
    if (entry.hits.length && lexicalHits.length !== entry.hits.length) { skip('search lines changed or could not be verified') }
    const seedHits = entry.seeds.filter(seed => seed.startLine <= lines.length)
      .map(seed => ({ line: seed.startLine, text: lines[seed.startLine - 1] ?? '', seed }))
    if (seedHits.length !== entry.seeds.length) mark('vector seed line outside current source')
    const hits = [...lexicalHits, ...seedHits]
    if (!hits.length) { skip('no verified or seeded source line'); continue }

    const astScan = scanContextAst(file, source, reason => mark(`${file}: ${reason}`))
    collectDeclarationCoords(file, astScan.declarations)

    if (view === 'locations') {
      const sortedHits = [...lexicalHits].sort((a, b) => {
        const aDecl = activeTerms.some(term => hasParsedTerm(a.text, term, caseSensitive, singlePatternFallback) && declarationLike(a.text, term, caseSensitive)) ? 1 : 0
        const bDecl = activeTerms.some(term => hasParsedTerm(b.text, term, caseSensitive, singlePatternFallback) && declarationLike(b.text, term, caseSensitive)) ? 1 : 0
        return bDecl - aDecl || a.line - b.line
      })
      const locHits: LocationHit[] = []
      const seenLines = new Set<number>()
      for (const hit of sortedHits) {
        if (locHits.length >= 6) break
        if (seenLines.has(hit.line)) continue
        seenLines.add(hit.line)
        const hitIndex = hit.line - 1
        const { declaration } = selectEnclosingDeclaration(astScan.ranges, hitIndex, activeTerms, lines[hitIndex] ?? '', caseSensitive)
        // Fall back to nearest enclosing class/interface/declaration header if range > 160 lines.
        const enclosingInfo = declaration
          ? { name: declaration.name, kind: declaration.kind, line: declaration.nameLine + 1, character: declaration.nameCharacter }
          : [...astScan.declarations].reverse().find(d => d.line === hit.line)
        let col = 1
        for (const term of activeTerms) {
          const idx = findParsedTermIndex(hit.text, term, caseSensitive)
          if (idx >= 0) { col = idx + 1; break }
        }
        const trimmedLine = (lines[hitIndex] ?? '').trim()
        const trimOffset = (lines[hitIndex] ?? '').length - (lines[hitIndex] ?? '').trimStart().length
        const preview = longLineExcerpt(trimmedLine, Math.max(0, col - 1 - trimOffset), 160)
        locHits.push({
          line: hit.line,
          character: col,
          preview,
          matchedTerms: activeTerms.filter(t => hasParsedTerm(hit.text, t, caseSensitive, singlePatternFallback)).map(t => t.raw),
          ...(enclosingInfo ? {
            declarationName: enclosingInfo.name,
            declarationKind: enclosingInfo.kind,
            declarationLine: enclosingInfo.line,
            declarationCharacter: enclosingInfo.character,
          } : {}),
        })
      }
      if (locHits.length || seedHits.length) {
        result.locations.push({ path: file, totalMatches: lexicalHits.length + seedHits.length, hits: locHits })
      }
      continue
    }

    const nextUnits = sourceUnits(
      file, source, hits, activeTerms, limit, exec.signal, mark, caseSensitive, singleFileMode, astScan.ranges,
    )
    units.push(...nextUnits)
  }

  if (view === 'locations') {
    result.locations = result.locations.slice(0, limit)
    const shownPaths = new Set(result.locations.map(l => l.path))
    result.extraMatchedFiles = candidates
      .filter(c => !shownPaths.has(c.file) && c.entry.hits.length > 0)
      .slice(0, 20)
      .map(c => ({
        path: c.file,
        matches: c.entry.hits.length,
        lines: [...new Set(c.entry.hits.map(h => h.line))].slice(0, 5),
      }))
    if (candidates.length > limit) mark(`location file display capped at ${limit} of ${candidates.length} files`)
    result.terms = activeTerms.map(term => {
      const stat = termStats.get(term.raw)!
      const shown = result.locations.filter(loc => loc.hits.some(h => h.matchedTerms.includes(term.raw))).length
      return {
        term: term.raw,
        ...stat,
        selectedFragments: shown,
        anchorFragments: shown,
        ...(stat.matchedFiles === 0 ? { omittedReason: 'no match' } : {}),
      }
    })
    return result
  }

  const score = (unit: ContextUnit) => (activeTerms.some(term => term.kind === 'literal' && sameText(term.literal ?? term.raw, unit.name, caseSensitive)) ? 1000 : 0)
    + unit.terms.reduce((n, term) => n + termWeight(term), 0)
      * (unit.fragments[0].source === 'declaration-context' || unit.fragments[0].source === 'declaration-partial' ? 2 : 1)

  units.sort((a, b) => Number(a.origin === 'vector') - Number(b.origin === 'vector')
    || score(b) - score(a) || (a.seedRank ?? 0) - (b.seedRank ?? 0)
    || a.path.localeCompare(b.path) || a.start - b.start)
  if (units.length > MAX_WINDOWS) mark('candidate context limit (120)')
  const remaining = units.slice(0, MAX_WINDOWS)
  const represented = new Set<string>()
  const subtractDisplayed = (fragment: CodeFragment): CodeFragment[] => {
    const existing = result.fragments.filter(old => old.path === fragment.path)
      .sort((a, b) => a.startLine - b.startLine)
    const pieces: [number, number][] = []
    let cursor = fragment.startLine
    for (const old of existing) {
      if (old.endLine < cursor) continue
      if (old.startLine > fragment.endLine) break
      if (old.startLine > cursor) pieces.push([cursor, Math.min(fragment.endLine, old.startLine - 1)])
      cursor = Math.max(cursor, old.endLine + 1)
      if (cursor > fragment.endLine) break
    }
    if (cursor <= fragment.endLine) pieces.push([cursor, fragment.endLine])
    const lines = fragment.text.split('\n')
    return pieces.map(([startLine, endLine]) => {
      const text = lines.slice(startLine - fragment.startLine, endLine - fragment.startLine + 1).join('\n')
      const piece: CodeFragment = {
        ...fragment, startLine, endLine, text,
        matchedTerms: fragment.matchedTerms.filter(termRaw => {
          const parsed = termByRaw.get(termRaw)
          return parsed ? hasParsedTerm(text, parsed, caseSensitive, fragment.isLongLineExcerpt || parsed.kind === 'regex') : false
        }),
        anchors: fragment.anchors.filter(anchor => anchor.line >= startLine && anchor.line <= endLine),
      }
      if (fragment.seedCoverage !== undefined && fragment.seedStartLine !== undefined && fragment.seedEndLine !== undefined) {
        piece.seedCoverage = startLine <= fragment.seedStartLine && endLine >= fragment.seedEndLine ? 'full' : 'partial'
      }
      return piece
    })
  }
  const vectorShown = new Map<string, number>()
  let textBytes = 0
  while (remaining.length) {
    exec.signal.throwIfAborted()
    let index = remaining.findIndex(unit => unit.origin !== 'vector'
      && activeTerms.some(term => term.kind === 'literal' && sameText(term.literal ?? term.raw, unit.name, caseSensitive)))
    if (index < 0) index = remaining.findIndex(unit => unit.origin !== 'vector' && !represented.has(unit.path))
    if (index < 0) index = remaining.findIndex(unit => !represented.has(unit.path))
    if (index < 0) index = 0
    const unit = remaining.splice(index, 1)[0]
    const unseenVector = [...vectorOnlyPaths].some(path => !vectorShown.has(path))
    const maxVectorFragments = unseenVector ? 1 : 2
    if (unit.origin === 'vector' && (vectorShown.get(unit.path) ?? 0) >= maxVectorFragments) continue
    const available = unit.fragments.flatMap(subtractDisplayed).filter(fragment => fragment.text.length > 0)
    const seedFragments = unit.origin === 'vector'
      ? available.filter(fragment => fragment.seededByVector).slice(0, maxVectorFragments - (vectorShown.get(unit.path) ?? 0))
      : []
    if (unit.origin === 'vector' && !seedFragments.length) { mark('vector seed range omitted by fragment budget'); continue }
    const additions = unit.origin === 'vector' ? seedFragments : available
    if (!additions.length) continue
    const size = additions.reduce((n, fragment) => n + encoder.encode(fragment.text).byteLength, 0)
    if (result.fragments.length + additions.length > limit || textBytes + size > MAX_TEXT_BYTES) {
      mark('result context omitted by fragment/text budget')
      if (result.omittedRanges.length < 6) {
        result.omittedRanges.push({
          path: unit.path,
          name: unit.name || 'context',
          startLine: additions[0].contextStartLine,
          endLine: additions[additions.length - 1].contextEndLine,
        })
      }
      continue
    }
    textBytes += size; result.fragments.push(...additions); represented.add(unit.path)
    if (unit.origin === 'vector') vectorShown.set(unit.path, (vectorShown.get(unit.path) ?? 0) + 1)
    result.vectorSeededFragments += additions.filter(fragment => fragment.seededByVector).length
    result.seedCoveredFragments += additions.filter(fragment => fragment.seedCoverage === 'full').length
  }

  const selectedFiles = new Set([...selected].map(candidate => candidate.file))
  result.terms = activeTerms.map(term => {
    const stat = termStats.get(term.raw)!
    const selectedFragments = result.fragments.filter(fragment => fragment.matchedTerms.includes(term.raw)).length
    const anchorFragments = result.fragments.filter(fragment => fragment.anchors.some(anchor => anchor.name === term.raw)).length
    let omittedReason: string | undefined
    if (selectedFragments === 0 && anchorFragments === 0) {
      if (stat.matchedFiles === 0) omittedReason = 'no match'
      else if (![...selectedFiles].some(file => files.get(file)?.terms.has(term.raw))) {
        omittedReason = candidates.length > fileCap ? `candidate file limit (${fileCap})` : 'matched files not selected'
      } else omittedReason = 'selected source produced no fragment for this term'
    }
    return { term: term.raw, ...stat, selectedFragments, anchorFragments, ...(omittedReason ? { omittedReason } : {}) }
  })

  return result
}

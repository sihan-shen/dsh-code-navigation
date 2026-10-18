import { contextDeclarations } from '../ast/typescript-context-ranges.js'
import { searchSemanticSeeds, type SemanticSeed } from './semantic-context-search.js'
import type { SemanticIndexConfig } from '../semantic/types.js'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ToolExecution, ToolRuntime } from '@deepseek-ai/dsh-tools'

const MAX_MATCHES = 2000
const MAX_FILES = 12
const MAX_FILE_BYTES = 1024 * 1024
const MAX_READ_BYTES = 4 * MAX_FILE_BYTES
const MAX_WINDOWS = 120
const MAX_BLOCK_BYTES = 2048
const MAX_TEXT_BYTES = 8192
const encoder = new TextEncoder()
const supported = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i

export type ContextMode = 'auto' | 'lexical' | 'hybrid'
export interface ContextQuery { terms?: string[]; query?: string; mode?: ContextMode; path?: string; limit?: number }
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
  /** True only when this fragment's range came from a vector seed. */
  seededByVector?: boolean
  seedStartLine?: number
  seedEndLine?: number
  /** How much of this fragment's seed range the fragment covers. */
  seedCoverage?: 'full' | 'partial'
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
  matchesFound: number
  candidateFiles: number
  filesRead: number
  bytesRead: number
  skipped: { path: string; reason: string }[]
  limits: string[]
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
}

function workspacePath(path: string): string {
  if (!path || path.length > 512 || path.startsWith('/') || /^[A-Za-z]:/.test(path)
    || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) {
    throw new Error('path must be a workspace-relative file or directory without parent traversal')
  }
  return path.split('/').filter(part => part && part !== '.').join('/') || '.'
}

function validateQuery(args: ContextQuery): { terms: string[]; query?: string; mode: ContextMode; path: string; limit: number } {
  const terms = [...new Set((args.terms ?? []).map(term => term.trim()))]
  const query = args.query?.trim()
  const mode = args.mode ?? 'auto'
  if (!['auto', 'lexical', 'hybrid'].includes(mode)) throw new Error('mode must be auto, lexical or hybrid')
  if (terms.length === 0 && !query) throw new Error('provide 1–6 literal terms or a natural-language query')
  if (args.terms !== undefined && args.terms.length > 6) throw new Error('terms must contain at most 6 literal search terms')
  if (args.terms !== undefined && args.terms.length === 0 && !query) throw new Error('terms must contain 1–6 literal search terms')
  if (terms.some(term => term.length < 2 || term.length > 64 || /[\r\n\0]/.test(term)
    || !/[\p{L}\p{N}]/u.test(term))) throw new Error('terms must contain 2–64 characters, including a letter or number')
  if (query !== undefined && (query.length < 1 || query.length > 1000 || /\0/.test(query))) throw new Error('query must contain 1–1000 characters')
  if (mode === 'lexical' && terms.length === 0) throw new Error('lexical mode requires at least one literal term')
  if (mode === 'hybrid' && !query) throw new Error('hybrid mode requires a natural-language query')
  const limit = args.limit ?? 4
  if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('limit must be an integer from 1 to 6')
  return { terms, query, mode, path: workspacePath(args.path ?? '.'), limit }
}

interface VectorSeed { startLine: number; endLine: number; rank: number; score: number }
interface SemanticQueryCacheEntry { seeds: SemanticSeed[]; queryEmbeddings: number; truncated: boolean; limits: string[] }
export interface SemanticQueryCache { entries: Map<string, SemanticQueryCacheEntry> }
interface SourceHit { line: number; text: string; seed?: VectorSeed }
interface ContextUnit { fragments: CodeFragment[]; terms: string[]; name: string; path: string; start: number; origin: 'lexical' | 'vector' | 'both'; seedRank?: number }
interface CandidateMatches { hits: { line: number; text: string }[]; terms: Set<string>; seeds: VectorSeed[] }
interface Candidate { file: string; entry: CandidateMatches; target: Awaited<ReturnType<FileSystem['resolve']>> }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A cheap pre-read signal, not a declaration proof. */
function declarationLike(line: string, term: string): boolean {
  const escaped = escapeRegExp(term)
  return [
    new RegExp(`\\b(?:function|class|interface|type|enum|namespace|const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\b(?:get|set)\\s+${escaped}\\s*\\(`),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`),
    new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`),
  ].some(pattern => pattern.test(line))
}

function sourceUnits(path: string, source: string, hits: SourceHit[], terms: string[],
  limit: number, signal: AbortSignal, mark: (reason: string) => void): ContextUnit[] {
  const lines = source.split('\n'), declarations = contextDeclarations(path, source,
    reason => mark(`${path}: ${reason}`))
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
    const overlap = (range: { start: number; end: number }) => Math.max(0,
      Math.min(range.end, seedLast) - Math.max(range.start, seedFirst) + 1)
    const enclosing = seed
      ? declarations.filter(range => range.end >= seedFirst && range.matchStart <= seedLast)
        .sort((a, b) => overlap(b) - overlap(a) || (a.end - a.start) - (b.end - b.start))
      : declarations.filter(range => range.matchStart <= hitIndex && range.end >= hitIndex)
        .sort((a, b) => (a.end - a.matchStart) - (b.end - b.matchStart))
    const named = seed ? [] : enclosing.filter(range => range.matchStart === hitIndex && terms.includes(range.name)
      && lines[hitIndex].includes(range.name))
    // Line-only grep cannot disambiguate multiple declarations beginning on one line.
    const sameLine = seed ? [] : enclosing.filter(range => range.matchStart === hitIndex)
    // Prefer a declaration containing the whole seed; a tail-only overlap is not evidence.
    const containingAll = seed ? declarations.filter(range => range.matchStart <= seedFirst && range.end >= seedLast)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start)) : []
    const containingStart = seed ? declarations.filter(range => range.matchStart <= seedFirst && range.end >= seedFirst)
      .sort((a, b) => overlap(b) - overlap(a) || (a.end - a.start) - (b.end - b.start)) : []
    const bestStart = containingStart[0]
    const declaration = seed
      ? containingAll[0] ?? (bestStart && overlap(bestStart) > 0 ? bestStart : undefined)
      : named.length === 1 ? named[0]
        : sameLine.length > 1 ? undefined : enclosing[0]
    const spanDecls = seed
      ? declarations.filter(range => overlap(range) > 0)
      : declaration ? [declaration] : []
    const spanFirst = spanDecls.length ? Math.min(seedFirst, ...spanDecls.map(range => range.start)) : undefined
    const spanLast = spanDecls.length ? Math.max(seedLast, ...spanDecls.map(range => range.end)) : undefined
    const hitAnchors: SourceAnchor[] = []
    const anchorLines = seed
      ? Array.from({ length: seedLast - seedFirst + 1 }, (_, index) => ({ line: seedFirst + index + 1, text: lines[seedFirst + index] ?? '' }))
      : [{ line: hit.line, text: hit.text }]
    for (const item of anchorLines) {
      for (const term of terms) {
        if (!item.text.includes(term)) continue
        const at = item.text.indexOf(term)
        if (at < 0) continue
        const bom = item.line === 1 && lines[0].startsWith('\uFEFF') && !item.text.startsWith('\uFEFF') ? 1 : 0
        hitAnchors.push({ kind: 'match', name: term, line: item.line, character: at + 1 + bom })
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
        while (next <= last && next < lines.length && text.length < 40) {
          const size = encoder.encode(lines[next]).byteLength + (text.length ? 1 : 0)
          if (bytes + size > MAX_BLOCK_BYTES) break
          bytes += size; text.push(lines[next++])
        }
        if (!text.length) {
          if (encoder.encode(lines[cursor] ?? '').byteLength > MAX_BLOCK_BYTES) {
            splitSkipped = true
            mark(`${path}: source line ${cursor + 1} exceeds 2 KiB`)
            cursor++
            continue
          }
          return pieces.length ? pieces : undefined
        }
        const content = text.join('\n'), startLine = cursor + 1, endLine = next
        const anchors = [...new Map(allAnchors.filter(anchor => anchor.line >= startLine && anchor.line <= endLine)
          .map(anchor => [`${anchor.kind}:${anchor.name}:${anchor.line}:${anchor.character}`, anchor])).values()]
          .slice(0, 3)
        pieces.push({ path, startLine, endLine, text: content, source: sourceKind,
          matchedTerms: terms.filter(term => content.includes(term)),
          contextStartLine: contextFirst + 1, contextEndLine: contextLast + 1, anchors })
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
    const unit: ContextUnit = { fragments,
      terms: terms.filter(term => fragments!.some(fragment => fragment.text.includes(term))),
      name: declaration?.name ?? '', path, start: fragments[0].startLine - 1,
      origin: seed ? 'vector' : 'lexical', seedRank: seed?.rank }
    const existing = units.get(key)
    if (!existing) { units.set(key, unit); continue }
    // Several hits may share one declaration or lexical window; keep every term anchor.
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
    existing.terms = [...new Set([...existing.terms,
      ...terms.filter(term => fragments!.some(fragment => fragment.text.includes(term)))])]
  }
  return [...units.values()]
}

export async function searchCodeContext(
  fs: FileSystem, tools: ToolRuntime, args: ContextQuery, exec: ToolExecution,
  semantic?: SemanticIndexConfig, semanticCache?: SemanticQueryCache,
): Promise<ContextResult> {
  const rawPath = args.path ?? '.'
  // Absolute paths are accepted only after provider containment checks below.
  const absolute = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath)
  const { terms, query, mode, path: relativePath, limit } = validateQuery({ ...args, path: absolute ? '.' : rawPath })
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  if (mode === 'hybrid' && !semantic) throw new Error('hybrid mode requires a configured semanticIndex')
  if (terms.length === 0 && !semantic) throw new Error('a natural-language query requires a configured semanticIndex; provide literal terms')
  exec.signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd, signal: exec.signal })
  // Host grep runs a process in Session cwd; remote FS worlds must not be mixed with it.
  if (fs.processPath(root).replace(/[\\/]+$/, '') !== cwd.replace(/[\\/]+$/, '')) throw new Error('host grep and fs must use the same Session process workspace')
  const scope = await fs.resolve(absolute ? rawPath : relativePath, { cwd, signal: exec.signal })
  if (!fs.contains(root, scope)) throw new Error('search path is outside the Session workspace')
  const scopePath = fs.processPath(scope), rootPath = fs.processPath(root).replace(/[\\/]+$/, '')
  const path = workspacePath(scopePath === rootPath ? '.' : scopePath.slice(rootPath.length + 1).replace(/\\/g, '/'))
  const files = new Map<string, CandidateMatches>()
  let rawMatches: unknown[] = []
  let matchLimitHit = false
  if (terms.length) {
    if (tools.get('grep', exec.agent) === undefined) throw new Error('host grep is unavailable')
    const pattern = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const outcome = await tools.execute({ name: 'grep', arguments: {
      pattern, path, include: '*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}' },
    callId: `${exec.callId}:grep` as typeof exec.callId, rootCallId: exec.rootCallId,
    parent: exec.token, agent: exec.agent, signal: exec.signal })
    exec.signal.throwIfAborted()
    if (outcome.isError) throw new Error(`host grep failed: ${outcome.error.message}`)
    const value: unknown = outcome.value
    if (typeof value !== 'object' || value === null || !('matches' in value) || !Array.isArray(value.matches)) {
      throw new Error('host grep returned no structured matches')
    }
    rawMatches = value.matches
    matchLimitHit = rawMatches.length > MAX_MATCHES
    for (const match of (matchLimitHit ? rawMatches.slice(0, MAX_MATCHES) : rawMatches) as unknown[]) {
      exec.signal.throwIfAborted()
      if (typeof match !== 'object' || match === null || typeof (match as { path?: unknown }).path !== 'string'
        || !Number.isSafeInteger((match as { lineNumber?: unknown }).lineNumber)
        || (match as { lineNumber: number }).lineNumber < 1 || typeof (match as { line?: unknown }).line !== 'string') {
        throw new Error('host grep returned an invalid match')
      }
      const parsed = match as { path: string; lineNumber: number; line: string }
      const file = workspacePath(parsed.path)
      if (!supported.test(file)) throw new Error('host grep returned an unsupported file')
      let entry = files.get(file)
      if (!entry) { entry = { hits: [], terms: new Set(), seeds: [] }; files.set(file, entry) }
      entry.hits.push({ line: parsed.lineNumber, text: parsed.line })
      for (const term of terms) if (parsed.line.includes(term)) entry.terms.add(term)
    }
  }
  const result: ContextResult = { matchesFound: rawMatches.length, candidateFiles: files.size,
    filesRead: 0, bytesRead: 0, skipped: [], limits: [], truncated: false,
    usedVector: false, vectorHits: 0, queryEmbeddings: 0, vectorOnlyFiles: 0,
    vectorSeededFragments: 0, seedCoveredFragments: 0, vectorStatus: 'off', vectorTrigger: 'none', terms: [], fragments: [] }
  const mark = (reason: string) => {
    result.truncated = true
    const text = reason.length > 512 ? `${reason.slice(0, 512)}…` : reason
    if (result.limits.length < 64 && !result.limits.includes(text)) result.limits.push(text)
  }
  if (matchLimitHit) mark(`match limit (${MAX_MATCHES}); first ${MAX_MATCHES} of ${rawMatches.length} matches processed`)
  const termStats = new Map(terms.map(term => [term, { matchedFiles: 0, matchedLines: 0 }]))
  for (const entry of files.values()) {
    for (const term of entry.terms) {
      const stat = termStats.get(term)!
      stat.matchedFiles++
      stat.matchedLines += entry.hits.reduce((n, hit) => n + (hit.text.includes(term) ? 1 : 0), 0)
    }
  }
  const weakLexical = files.size === 0 || terms.some(term => (termStats.get(term)?.matchedFiles ?? 0) === 0)
  const useVector = semantic !== undefined && query !== undefined
    && (mode === 'hybrid' || terms.length === 0 || (mode === 'auto' && weakLexical))
  result.vectorTrigger = !useVector ? 'none' : terms.length === 0 ? 'query-only' : mode === 'hybrid' ? 'hybrid'
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
          { cwd, signal: exec.signal })
      } catch (error) {
        exec.signal.throwIfAborted()
        const reason = error instanceof Error ? error.message : String(error)
        result.vectorStatus = /stale/.test(reason) ? 'stale' : /invalid or incompatible/.test(reason) ? 'invalid' : 'unavailable'
        if (terms.length === 0) throw new Error(`semantic candidates unavailable: ${reason}`)
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
  // Validate every candidate before dropping any due to a resource budget.
  const candidates: Candidate[] = []
  for (const [file, entry] of files) {
    const target = await fs.resolve(file, { cwd, signal: exec.signal })
    if (!fs.contains(root, target) || !fs.contains(scope, target)) throw new Error(`candidate is outside search scope: ${file}`)
    candidates.push({ file, entry, target })
  }
  const termFrequency = new Map(terms.map(term => [term,
    [...files.values()].filter(entry => entry.terms.has(term)).length]))
  const termWeight = (term: string) => Math.log(1 + files.size / Math.max(1, termFrequency.get(term) ?? 0))
  const candidateScore = (candidate: Candidate) => {
    let score = 0
    for (const term of candidate.entry.terms) {
      score += termWeight(term)
      if (candidate.entry.hits.some(hit => hit.text.includes(term) && declarationLike(hit.text, term))) score += 1
    }
    return score
  }
  const scores = new Map(candidates.map(candidate => [candidate, candidateScore(candidate)]))
  candidates.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0)
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  // Reserve a candidate for every query term before common multi-term files fill the cap.
  // Rare terms and declaration-shaped hits get first choice; this is still lexical evidence.
  const selected = new Set<Candidate>()
  const hasTerm = (candidate: Candidate, term: string) => candidate.entry.terms.has(term)
  const hasDeclarationHit = (candidate: Candidate, term: string) => candidate.entry.hits.some(hit =>
    hit.text.includes(term) && declarationLike(hit.text, term))
  for (const term of [...terms].sort((a, b) => (termFrequency.get(a) ?? 0) - (termFrequency.get(b) ?? 0))) {
    const selectedHasTerm = [...selected].some(candidate => hasTerm(candidate, term))
    const selectedHasDeclaration = [...selected].some(candidate => hasTerm(candidate, term)
      && hasDeclarationHit(candidate, term))
    const withTerm = candidates.filter(candidate => hasTerm(candidate, term))
    const declarationHit = withTerm.find(candidate => hasDeclarationHit(candidate, term))
    if (selectedHasTerm && (selectedHasDeclaration || !declarationHit)) continue
    const candidate = declarationHit ?? withTerm[0]
    if (candidate) selected.add(candidate)
  }
  const vectorOnly = candidates.filter(candidate => candidate.entry.terms.size === 0 && candidate.entry.seeds.length > 0)
    .sort((a, b) => Math.min(...a.entry.seeds.map(seed => seed.rank)) - Math.min(...b.entry.seeds.map(seed => seed.rank)))
  const lexicalCandidates = candidates.filter(candidate => candidate.entry.terms.size > 0)
  // Reserve at most two slots for vector-only files, and only when they are not already lexical picks.
  const lexicalCap = terms.length && useVector ? Math.max(0, MAX_FILES - Math.min(2, vectorOnly.length)) : MAX_FILES
  for (const candidate of lexicalCandidates) {
    if (selected.size >= lexicalCap) break
    selected.add(candidate)
  }
  for (const candidate of vectorOnly) {
    if (selected.size >= MAX_FILES) break
    selected.add(candidate)
  }
  for (const candidate of candidates) {
    if (selected.size >= MAX_FILES) break
    selected.add(candidate)
  }
  if (candidates.length > MAX_FILES) mark('candidate file limit (12)')
  result.vectorOnlyFiles = [...selected].filter(candidate => candidate.entry.terms.size === 0 && candidate.entry.seeds.length > 0).length
  const vectorOnlyPaths = new Set(vectorOnly.map(candidate => candidate.file))
  const units: ContextUnit[] = []
  for (const { file, entry, target } of selected) {
    exec.signal.throwIfAborted()
    const skip = (reason: string) => { result.skipped.push({ path: file, reason }); mark('partial source coverage') }
    let source: string
    try {
      const info = await fs.stat(target, exec.signal)
      if (!info || info.type !== 'file') { skip('not a regular file'); continue }
      if (info.size === undefined || info.size > MAX_FILE_BYTES) { skip('size unknown or file exceeds 1 MiB'); continue }
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
    // grep uses LF records, while TypeScript also treats these as line breaks.
    if (/\r(?!\n)|[\u2028\u2029]/.test(source)) { skip('unsupported line separators; use explicit file reading'); continue }
    const lines = source.split('\n')
    const lexicalHits = entry.hits.filter(hit => {
      let current = lines[hit.line - 1]
      // rg strips CR only when it belongs to a CRLF terminator, not at EOF.
      if (hit.line < lines.length) current = current?.replace(/\r$/, '')
      let searched = hit.text
      if (hit.line === 1) {
        current = current?.replace(/^\uFEFF/, '')
        searched = searched.replace(/^\uFEFF/, '')
      }
      return current === searched && terms.some(term => hit.text.includes(term))
    })
    if (entry.hits.length && lexicalHits.length !== entry.hits.length) { skip('search lines changed or could not be verified') }
    const seedHits = entry.seeds.filter(seed => seed.startLine <= lines.length)
      .map(seed => ({ line: seed.startLine, text: lines[seed.startLine - 1] ?? '', seed }))
    if (seedHits.length !== entry.seeds.length) mark('vector seed line outside current source')
    const hits = [...lexicalHits, ...seedHits]
    if (!hits.length) { skip('no verified or seeded source line'); continue }
    const nextUnits = sourceUnits(file, source, hits, terms, limit, exec.signal, mark)
    units.push(...nextUnits)
  }
  const score = (unit: ContextUnit) => (terms.includes(unit.name) ? 1000 : 0)
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
      const piece: CodeFragment = { ...fragment, startLine, endLine, text,
        matchedTerms: fragment.matchedTerms.filter(term => text.includes(term)),
        anchors: fragment.anchors.filter(anchor => anchor.line >= startLine && anchor.line <= endLine) }
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
    // Lexical declaration anchors precede diversification; vector units fill remaining slots.
    let index = remaining.findIndex(unit => unit.origin !== 'vector' && terms.includes(unit.name))
    if (index < 0) index = remaining.findIndex(unit => unit.origin !== 'vector' && !represented.has(unit.path))
    if (index < 0) index = remaining.findIndex(unit => !represented.has(unit.path))
    if (index < 0) index = 0
    const unit = remaining.splice(index, 1)[0]
    const unseenVector = [...vectorOnlyPaths].some(path => !vectorShown.has(path))
    const maxVectorFragments = unseenVector ? 1 : 2
    if (unit.origin === 'vector' && (vectorShown.get(unit.path) ?? 0) >= maxVectorFragments) continue
    const available = unit.fragments.flatMap(subtractDisplayed).filter(fragment => fragment.text.length > 0)
    // A vector seed must show the fragment that actually intersects its range, not just the declaration head.
    const seedFragments = unit.origin === 'vector'
      ? available.filter(fragment => fragment.seededByVector).slice(0, maxVectorFragments - (vectorShown.get(unit.path) ?? 0))
      : []
    if (unit.origin === 'vector' && !seedFragments.length) { mark('vector seed range omitted by fragment budget'); continue }
    const additions = unit.origin === 'vector' ? seedFragments : available
    if (!additions.length) continue
    const size = additions.reduce((n, fragment) => n + encoder.encode(fragment.text).byteLength, 0)
    if (result.fragments.length + additions.length > limit || textBytes + size > MAX_TEXT_BYTES) {
      mark('result context omitted by fragment/text budget'); continue
    }
    textBytes += size; result.fragments.push(...additions); represented.add(unit.path)
    if (unit.origin === 'vector') vectorShown.set(unit.path, (vectorShown.get(unit.path) ?? 0) + 1)
    result.vectorSeededFragments += additions.filter(fragment => fragment.seededByVector).length
    result.seedCoveredFragments += additions.filter(fragment => fragment.seedCoverage === 'full').length
  }
  const selectedFiles = new Set([...selected].map(candidate => candidate.file))
  result.terms = terms.map(term => {
    const stat = termStats.get(term)!
    const selectedFragments = result.fragments.filter(fragment => fragment.matchedTerms.includes(term)).length
    const anchorFragments = result.fragments.filter(fragment => fragment.anchors.some(anchor => anchor.name === term)).length
    let omittedReason: string | undefined
    if (selectedFragments === 0 && anchorFragments === 0) {
      if (stat.matchedFiles === 0) omittedReason = 'no literal match'
      else if (![...selectedFiles].some(file => files.get(file)?.terms.has(term))) {
        omittedReason = candidates.length > MAX_FILES ? 'candidate file limit (12)' : 'matched files not selected'
      } else omittedReason = 'selected source produced no fragment for this term'
    }
    return { term, ...stat, selectedFragments, anchorFragments, ...(omittedReason ? { omittedReason } : {}) }
  })

  return result
}

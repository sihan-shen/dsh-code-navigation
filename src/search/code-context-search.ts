import { contextDeclarations } from '../ast/typescript-context-ranges.js'
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

export interface ContextQuery { terms: string[]; path?: string; limit?: number }
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

function validateQuery(args: ContextQuery): { terms: string[]; path: string; limit: number } {
  if (args.terms.length < 1 || args.terms.length > 6) throw new Error('terms must contain 1–6 literal search terms')
  const terms = [...new Set(args.terms.map(term => term.trim()))]
  if (terms.some(term => term.length < 2 || term.length > 64 || /[\r\n\0]/.test(term)
    || !/[\p{L}\p{N}]/u.test(term))) throw new Error('terms must contain 2–64 characters, including a letter or number')
  const limit = args.limit ?? 4
  if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('limit must be an integer from 1 to 6')
  return { terms, path: workspacePath(args.path ?? '.'), limit }
}

interface ContextUnit { fragments: CodeFragment[]; terms: string[]; name: string; path: string; start: number }
interface CandidateMatches { hits: { line: number; text: string }[]; terms: Set<string> }
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

function sourceUnits(path: string, source: string, hits: { line: number; text: string }[], terms: string[],
  limit: number, signal: AbortSignal, mark: (reason: string) => void): ContextUnit[] {
  const lines = source.split('\n'), declarations = contextDeclarations(path, source,
    reason => mark(`${path}: ${reason}`))
  const units = new Map<string, ContextUnit>()
  const uniqueHits = [...new Map(hits.map(hit => [hit.line, hit])).values()].sort((a, b) => a.line - b.line)
  for (const hit of uniqueHits) {
    signal.throwIfAborted()
    const hitIndex = hit.line - 1
    const enclosing = declarations.filter(r => r.matchStart <= hitIndex && r.end >= hitIndex)
      .sort((a, b) => (a.end - a.matchStart) - (b.end - b.matchStart))
    const named = enclosing.filter(r => r.matchStart === hitIndex && terms.includes(r.name)
      && lines[hitIndex].includes(r.name))
    // Line-only grep cannot disambiguate multiple declarations beginning on one line.
    const sameLine = enclosing.filter(r => r.matchStart === hitIndex)
    const declaration = named.length === 1 ? named[0]
      : sameLine.length > 1 ? undefined : enclosing[0]
    const hitAnchors: SourceAnchor[] = []
    for (const term of terms) {
      if (!hit.text.includes(term)) continue
      const at = hit.text.indexOf(term)
      if (at < 0) continue
      const bom = hit.line === 1 && lines[0].startsWith('\uFEFF') && !hit.text.startsWith('\uFEFF') ? 1 : 0
      hitAnchors.push({ kind: 'match', name: term, line: hit.line, character: at + 1 + bom })
    }
    const declarationAnchor: SourceAnchor | undefined = declaration?.name
      ? { kind: 'declaration', name: declaration.name, line: declaration.nameLine + 1, character: declaration.nameCharacter }
      : undefined
    const allAnchors = declarationAnchor ? [declarationAnchor, ...hitAnchors] : hitAnchors
    function split(first: number, last: number, sourceKind: FragmentSource,
      contextFirst: number, contextLast: number): CodeFragment[] | undefined {
      const pieces: CodeFragment[] = []
      for (let cursor = first; cursor <= last;) {
        signal.throwIfAborted()
        const text: string[] = []; let bytes = 0, next = cursor
        while (next <= last && text.length < 40) {
          const size = encoder.encode(lines[next]).byteLength + (text.length ? 1 : 0)
          if (bytes + size > MAX_BLOCK_BYTES) break
          bytes += size; text.push(lines[next++])
        }
        if (!text.length) return undefined
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
    const full = withDeclarationAnchor(declaration
      ? split(declaration.start, declaration.end, 'declaration-context', declaration.start, declaration.end) : undefined)
    const fullBytes = full?.reduce((n, fragment) => n + encoder.encode(fragment.text).byteLength, 0) ?? 0
    let fragments: CodeFragment[] | undefined
    let key: string
    if (declaration && full && full.length <= limit && fullBytes <= MAX_TEXT_BYTES) {
      fragments = full
      key = `${declaration.start}:${declaration.end}:declaration-context`
    } else if (declaration) {
      mark('declaration context reduced to a bounded partial range')
      const ranges = [
        { first: Math.max(declaration.start, hitIndex - 4), last: Math.min(declaration.end, hitIndex + 8), priority: 0 },
        { first: declaration.start, last: Math.min(declaration.end, declaration.matchStart + 2), priority: 1 },
      ]
      if (declaration.end - 2 > hitIndex + 2) {
        ranges.push({ first: Math.max(declaration.start, declaration.end - 1), last: declaration.end, priority: 2 })
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
        const part = split(range.first, range.last, 'declaration-partial', declaration.start, declaration.end)
        if (!part) continue
        for (const piece of part) {
          if (pieces.length >= limit) break
          pieces.push(piece)
        }
        if (pieces.length >= limit) break
      }
      pieces.sort((a, b) => a.startLine - b.startLine)
      fragments = withDeclarationAnchor(pieces)
      key = `${declaration.start}:${declaration.end}:declaration-partial:${hit.line}`
    } else {
      const first = Math.max(0, hitIndex - 8), last = Math.min(lines.length - 1, hitIndex + 8)
      fragments = split(first, last, 'lexical-window', first, last)
      key = `${first}:${last}:lexical-window`
    }
    if (!fragments?.length) { mark('source line exceeds 2 KiB'); continue }
    const existing = units.get(key)
    if (!existing) {
      units.set(key, { fragments, terms: terms.filter(term => fragments!.some(fragment => fragment.text.includes(term))),
        name: declaration?.name ?? '', path, start: fragments[0].startLine - 1 })
      continue
    }
    // Several hits may share one declaration or lexical window; keep every term anchor.
    const byRange = new Map(existing.fragments.map(fragment => [`${fragment.startLine}:${fragment.endLine}`, fragment]))
    for (const fragment of fragments) {
      const previous = byRange.get(`${fragment.startLine}:${fragment.endLine}`)
      if (!previous) { byRange.set(`${fragment.startLine}:${fragment.endLine}`, fragment); continue }
      previous.matchedTerms = [...new Set([...previous.matchedTerms, ...fragment.matchedTerms])]
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
): Promise<ContextResult> {
  const rawPath = args.path ?? '.'
  // Absolute paths are accepted only after provider containment checks below.
  const absolute = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath)
  const { terms, path: relativePath, limit } = validateQuery({ ...args, path: absolute ? '.' : rawPath })
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  exec.signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd, signal: exec.signal })
  // Host grep runs a process in Session cwd; remote FS worlds must not be mixed with it.
  if (fs.processPath(root).replace(/[\\/]+$/, '') !== cwd.replace(/[\\/]+$/, '')) throw new Error('host grep and fs must use the same Session process workspace')
  const scope = await fs.resolve(absolute ? rawPath : relativePath, { cwd, signal: exec.signal })
  if (!fs.contains(root, scope)) throw new Error('search path is outside the Session workspace')
  const scopePath = fs.processPath(scope), rootPath = fs.processPath(root).replace(/[\\/]+$/, '')
  const path = workspacePath(scopePath === rootPath ? '.' : scopePath.slice(rootPath.length + 1).replace(/\\/g, '/'))
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
  const rawMatches = value.matches
  const matchLimitHit = rawMatches.length > MAX_MATCHES
  const matches = matchLimitHit ? rawMatches.slice(0, MAX_MATCHES) : rawMatches
  const files = new Map<string, CandidateMatches>()
  for (const match of matches) {
    exec.signal.throwIfAborted()
    if (typeof match !== 'object' || match === null || typeof match.path !== 'string'
      || !Number.isSafeInteger(match.lineNumber) || match.lineNumber < 1 || typeof match.line !== 'string') {
      throw new Error('host grep returned an invalid match')
    }
    const file = workspacePath(match.path)
    if (!supported.test(file)) throw new Error('host grep returned an unsupported file')
    let entry = files.get(file)
    if (!entry) { entry = { hits: [], terms: new Set() }; files.set(file, entry) }
    entry.hits.push({ line: match.lineNumber, text: match.line })
    for (const term of terms) if (match.line.includes(term)) entry.terms.add(term)
  }
  const result: ContextResult = { matchesFound: rawMatches.length, candidateFiles: files.size,
    filesRead: 0, bytesRead: 0, skipped: [], limits: [], truncated: false, terms: [], fragments: [] }
  const mark = (reason: string) => { result.truncated = true; if (!result.limits.includes(reason)) result.limits.push(reason) }
  if (matchLimitHit) mark(`match limit (${MAX_MATCHES}); first ${MAX_MATCHES} of ${rawMatches.length} matches processed`)
  const termStats = new Map(terms.map(term => [term, { matchedFiles: 0, matchedLines: 0 }]))
  for (const entry of files.values()) {
    for (const term of entry.terms) {
      const stat = termStats.get(term)!
      stat.matchedFiles++
      stat.matchedLines += entry.hits.reduce((n, hit) => n + (hit.text.includes(term) ? 1 : 0), 0)
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
  for (const candidate of candidates) {
    if (selected.size >= MAX_FILES) break
    selected.add(candidate)
  }
  if (candidates.length > MAX_FILES) mark('candidate file limit (12)')
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
    const hits = entry.hits.filter(hit => {
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
    if (hits.length !== entry.hits.length) { skip('search lines changed or could not be verified') }
    units.push(...sourceUnits(file, source, hits, terms, limit, exec.signal, mark))
  }
  const score = (unit: ContextUnit) => (terms.includes(unit.name) ? 1000 : 0)
    + unit.terms.reduce((n, term) => n + termWeight(term), 0)
      * (unit.fragments[0].source === 'declaration-context' || unit.fragments[0].source === 'declaration-partial' ? 2 : 1)

  units.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path) || a.start - b.start)
  if (units.length > MAX_WINDOWS) mark('candidate context limit (120)')
  const remaining = units.slice(0, MAX_WINDOWS)
  const represented = new Set<string>()
  const covered = (fragment: CodeFragment) => {
    let nextLine = fragment.startLine
    for (const old of result.fragments.filter(old => old.path === fragment.path)
      .sort((a, b) => a.startLine - b.startLine)) {
      if (old.startLine > nextLine) break
      nextLine = Math.max(nextLine, old.endLine + 1)
      if (nextLine > fragment.endLine) return true
    }
    return false
  }
  let textBytes = 0
  while (remaining.length) {
    exec.signal.throwIfAborted()
    // Exact declaration anchors precede diversification; then prefer an unseen file.
    let index = remaining.findIndex(unit => terms.includes(unit.name))
    if (index < 0) index = remaining.findIndex(unit => !represented.has(unit.path))
    if (index < 0) index = 0
    const unit = remaining.splice(index, 1)[0]
    // Covered ranges add no source; partial overlap only adds the uncovered pieces.
    const additions = unit.fragments.filter(fragment => !covered(fragment))
    if (!additions.length) continue
    const size = additions.reduce((n, fragment) => n + encoder.encode(fragment.text).byteLength, 0)
    if (result.fragments.length + additions.length > limit || textBytes + size > MAX_TEXT_BYTES) {
      mark('result context omitted by fragment/text budget'); continue
    }
    textBytes += size; result.fragments.push(...additions); represented.add(unit.path)
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

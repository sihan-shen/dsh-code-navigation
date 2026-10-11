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
const supported = /\.(?:ts|tsx|js|jsx)$/i

export interface ContextQuery { terms: string[]; path?: string; limit?: number }
export interface CodeFragment {
  path: string
  startLine: number
  endLine: number
  text: string
  source: 'lexical-window' | 'declaration-context'
  matchedTerms: string[]
  contextStartLine: number
  contextEndLine: number
}
export interface ContextResult {
  matchesFound: number
  candidateFiles: number
  filesRead: number
  bytesRead: number
  skipped: { path: string; reason: string }[]
  limits: string[]
  truncated: boolean
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

function sourceUnits(path: string, source: string, hits: number[], terms: string[], limit: number,
  signal: AbortSignal, mark: (reason: string) => void): ContextUnit[] {
  const lines = source.split('\n'), declarations = contextDeclarations(path, source,
    reason => mark(`${path}: ${reason}`))
  const units = new Map<string, ContextUnit>()
  for (const hit of [...new Set(hits)].sort((a, b) => a - b)) {
    signal.throwIfAborted()
    const enclosing = declarations.filter(r => r.matchStart <= hit - 1 && r.end >= hit - 1)
      .sort((a, b) => (a.end - a.matchStart) - (b.end - b.matchStart))
    const anchors = enclosing.filter(r => r.matchStart === hit - 1 && terms.includes(r.name)
      && lines[hit - 1].includes(r.name))
    // Line-only grep cannot disambiguate multiple declarations beginning on one line.
    const sameLine = enclosing.filter(r => r.matchStart === hit - 1)
    const declaration = anchors.length === 1 ? anchors[0]
      : sameLine.length > 1 ? undefined : enclosing[0]
    let start = declaration?.start ?? Math.max(0, hit - 1 - 8)
    let end = declaration?.end ?? Math.min(lines.length - 1, hit - 1 + 8)
    let kind: CodeFragment['source'] = declaration ? 'declaration-context' : 'lexical-window'
    function split(first: number, last: number): CodeFragment[] | undefined {
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
        const content = text.join('\n')
        pieces.push({ path, startLine: cursor + 1, endLine: next, text: content, source: kind,
          matchedTerms: terms.filter(term => content.includes(term)), contextStartLine: first + 1, contextEndLine: last + 1 })
        cursor = next
      }
      return pieces
    }
    let fragments = split(start, end)
    if (declaration && (!fragments || fragments.length > limit
      || fragments.reduce((n, f) => n + encoder.encode(f.text).byteLength, 0) > MAX_TEXT_BYTES)) {
      mark('declaration context exceeds result budget; lexical fallback is partial')
      start = Math.max(0, hit - 1 - 8); end = Math.min(lines.length - 1, hit - 1 + 8)
      kind = 'lexical-window'; fragments = split(start, end)
    }
    if (!fragments) { mark('source line exceeds 2 KiB'); continue }
    const content = lines.slice(start, end + 1).join('\n')
    // Keep every piece of the associated range, including pieces without a query term.
    units.set(`${start}:${end}:${kind}`, { fragments, terms: terms.filter(term => content.includes(term)),
      name: kind === 'declaration-context' ? declaration!.name : '', path, start })
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
  const outcome = await tools.execute({ name: 'grep', arguments: { pattern, path, include: '*.{ts,tsx,js,jsx}' },
    callId: `${exec.callId}:grep` as typeof exec.callId, rootCallId: exec.rootCallId,
    parent: exec.token, agent: exec.agent, signal: exec.signal })
  exec.signal.throwIfAborted()
  if (outcome.isError) throw new Error(`host grep failed: ${outcome.error.message}`)
  const value: unknown = outcome.value
  if (typeof value !== 'object' || value === null || !('matches' in value) || !Array.isArray(value.matches)) {
    throw new Error('host grep returned no structured matches')
  }
  if (value.matches.length > MAX_MATCHES) throw new Error('host grep found more than 2000 matches; narrow path or terms')
  const files = new Map<string, CandidateMatches>()
  for (const match of value.matches) {
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
  const result: ContextResult = { matchesFound: value.matches.length, candidateFiles: files.size,
    filesRead: 0, bytesRead: 0, skipped: [], limits: [], truncated: false, fragments: [] }
  const mark = (reason: string) => { result.truncated = true; if (!result.limits.includes(reason)) result.limits.push(reason) }
  // Validate every candidate before dropping any due to a resource budget.
  const candidates: { file: string; entry: CandidateMatches; target: Awaited<ReturnType<FileSystem['resolve']>> }[] = []
  for (const [file, entry] of files) {
    const target = await fs.resolve(file, { cwd, signal: exec.signal })
    if (!fs.contains(root, target) || !fs.contains(scope, target)) throw new Error(`candidate is outside search scope: ${file}`)
    candidates.push({ file, entry, target })
  }
  candidates.sort((a, b) => b.entry.terms.size - a.entry.terms.size || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  // Reserve a candidate for every query term before common multi-term files fill the cap.
  // This preserves lexical coverage, not a semantic declaration guarantee.
  const selected = new Set<typeof candidates[number]>()
  for (const term of [...terms].sort((a, b) =>
    candidates.filter(c => c.entry.terms.has(a)).length - candidates.filter(c => c.entry.terms.has(b)).length)) {
    if ([...selected].some(c => c.entry.terms.has(term))) continue
    const candidate = candidates.find(c => c.entry.terms.has(term))
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
    try {
      const info = await fs.stat(target, exec.signal)
      if (!info || info.type !== 'file') { skip('not a regular file'); continue }
      if (info.size === undefined || info.size > MAX_FILE_BYTES) { skip('size unknown or file exceeds 1 MiB'); continue }
      if (result.bytesRead + info.size > MAX_READ_BYTES) { skip('total read budget (4 MiB)'); continue }
      const bytes = await fs.readBytes(target, exec.signal, Math.min(MAX_FILE_BYTES, MAX_READ_BYTES - result.bytesRead))
      result.bytesRead += bytes.byteLength
      result.filesRead++
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
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
      if (hits.some(hit => encoder.encode(lines[hit.line - 1]).byteLength > MAX_BLOCK_BYTES)) mark('matched line exceeds 2 KiB')
      units.push(...sourceUnits(file, source, hits.map(hit => hit.line), terms, limit, exec.signal, mark))
    } catch {
      exec.signal.throwIfAborted()
      skip('source read or decode failed')
    }
  }
  const weight = (term: string) => Math.log(1 + files.size / Math.max(1,
    [...files.values()].filter(entry => entry.terms.has(term)).length))
  const score = (unit: ContextUnit) => (terms.includes(unit.name) ? 1000 : 0)
    + unit.terms.reduce((n, term) => n + weight(term), 0)
      * (unit.fragments[0].source === 'declaration-context' ? 2 : 1)

  units.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path) || a.start - b.start)
  if (units.length > MAX_WINDOWS) mark('candidate context limit (120)')
  const remaining = units.slice(0, MAX_WINDOWS)
  const represented = new Set<string>()
  let textBytes = 0
  while (remaining.length) {
    exec.signal.throwIfAborted()
    // Exact declaration anchors precede diversification; then prefer an unseen file.
    let index = remaining.findIndex(unit => terms.includes(unit.name))
    if (index < 0) index = remaining.findIndex(unit => !represented.has(unit.path))
    if (index < 0) index = 0
    const unit = remaining.splice(index, 1)[0]
    // Covered units add no source and must not trigger a missing-context warning.
    if (unit.fragments.every(f => {
      let nextLine = f.startLine
      for (const old of result.fragments.filter(old => old.path === f.path)
        .sort((a, b) => a.startLine - b.startLine)) {
        if (old.startLine > nextLine) break
        nextLine = Math.max(nextLine, old.endLine + 1)
        if (nextLine > f.endLine) return true
      }
      return false
    })) continue
    const size = unit.fragments.reduce((n, f) => n + encoder.encode(f.text).byteLength, 0)
    if (result.fragments.length + unit.fragments.length > limit || textBytes + size > MAX_TEXT_BYTES) {
      mark('result context omitted by fragment/text budget'); continue
    }
    textBytes += size; result.fragments.push(...unit.fragments); represented.add(unit.path)
  }

  return result
}

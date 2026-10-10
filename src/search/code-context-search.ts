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
  source: 'lexical-window'
  matchedTerms: string[]
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

function compare(a: CodeFragment, b: CodeFragment): number {
  return b.matchedTerms.length - a.matchedTerms.length
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine
}

function windows(path: string, lines: string[], hits: number[], terms: string[], signal: AbortSignal, mark: (reason: string) => void): CodeFragment[] {
  const ranges: { start: number; end: number }[] = []
  for (const hit of [...new Set(hits)].sort((a, b) => a - b)) {
    const start = Math.max(0, hit - 1 - 8), end = Math.min(lines.length - 1, hit - 1 + 8)
    const previous = ranges.at(-1)
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }
  const fragments: CodeFragment[] = []
  for (const range of ranges) {
    let start = range.start
    while (start <= range.end) {
      signal.throwIfAborted()
      let end = start, bytes = 0
      const text: string[] = []
      while (end <= range.end && text.length < 40) {
        const size = encoder.encode(lines[end]).byteLength + (text.length ? 1 : 0)
        if (bytes + size > MAX_BLOCK_BYTES) break
        bytes += size
        text.push(lines[end++])
      }
      if (text.length === 0) { mark('source line exceeds 2 KiB'); start++; continue }
      if (end <= range.end) mark('window split by line or byte budget')
      const content = text.join('\n')
      const matchedTerms = terms.filter(term => content.includes(term))
      // Context-only pieces do not displace fragments that contain a query term.
      if (matchedTerms.length) fragments.push({ path, startLine: start + 1, endLine: end,
        text: content, source: 'lexical-window', matchedTerms })
      start = end
    }
  }
  return fragments
}

export async function searchCodeContext(
  fs: FileSystem, tools: ToolRuntime, args: ContextQuery, exec: ToolExecution,
): Promise<ContextResult> {
  const { terms, path, limit } = validateQuery(args)
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  exec.signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd, signal: exec.signal })
  // Host grep runs a process in Session cwd; remote FS worlds must not be mixed with it.
  if (fs.processPath(root).replace(/[\\/]+$/, '') !== cwd.replace(/[\\/]+$/, '')) throw new Error('host grep and fs must use the same Session process workspace')
  const scope = await fs.resolve(path, { cwd, signal: exec.signal })
  if (!fs.contains(root, scope)) throw new Error('search path is outside the Session workspace')
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
  const files = new Map<string, { hits: { line: number; text: string }[]; terms: Set<string> }>()
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
  const candidates = []
  for (const [file, entry] of files) {
    const target = await fs.resolve(file, { cwd, signal: exec.signal })
    if (!fs.contains(root, target) || !fs.contains(scope, target)) throw new Error(`candidate is outside search scope: ${file}`)
    candidates.push({ file, entry, target })
  }
  candidates.sort((a, b) => b.entry.terms.size - a.entry.terms.size || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  if (candidates.length > MAX_FILES) mark('candidate file limit (12)')
  const fragments: CodeFragment[] = []
  for (const { file, entry, target } of candidates.slice(0, MAX_FILES)) {
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
      const found = windows(file, lines, hits.map(hit => hit.line), terms, exec.signal, mark)
      fragments.push(...found)
    } catch {
      exec.signal.throwIfAborted()
      skip('source read or decode failed')
    }
  }
  fragments.sort(compare)
  if (fragments.length > MAX_WINDOWS) mark('candidate window limit (120)')
  if (fragments.length > limit) mark(`result limit (${limit})`)
  let textBytes = 0
  for (const fragment of fragments.slice(0, MAX_WINDOWS)) {
    exec.signal.throwIfAborted()
    if (result.fragments.length >= limit) break
    const size = encoder.encode(fragment.text).byteLength
    if (textBytes + size > MAX_TEXT_BYTES) { mark('fragment text budget (8 KiB)'); continue }
    textBytes += size
    result.fragments.push(fragment)
  }
  return result
}

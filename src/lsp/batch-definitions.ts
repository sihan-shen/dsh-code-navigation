import type { FileSystem, FsTarget, FsInfo } from '@deepseek-ai/dsh-fs'
import type { LspService, LspLocation } from '@deepseek-ai/dsh-lsp'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { extractDeclarations } from '../ast/typescript-declarations.js'

export const DEFINITION_LIMITS = {
  queries: 8, targets: 3, fileBytes: 65536, totalBytes: 393216,
  sourceRows: 96, renderBytes: 12000,
} as const

export interface DefinitionCursor {
  file_path: string
  line: number
  character: number
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
}
export interface DefinitionItem {
  index: number
  path: string
  line: number
  character: number
  status: 'ok' | 'empty' | 'duplicate' | 'error' | 'partial' | 'unavailable'
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
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || path.split('/').some(part => part === '..') || !/\.ts$/i.test(path)) return undefined
    return path
  } catch { return undefined }
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240)
}

export async function findBatchDefinitions(
  fs: FileSystem, lsp: LspService, args: { queries: DefinitionCursor[] }, exec: ToolExecution,
): Promise<BatchDefinitions> {
  if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > DEFINITION_LIMITS.queries) {
    throw new Error('queries must contain 1–8 cursors')
  }
  for (const q of args.queries) {
    if (!q || typeof q.file_path !== 'string' || !q.file_path || q.file_path.length > 512
      || q.file_path.includes('\0') || !/\.ts$/i.test(q.file_path)
      || !Number.isSafeInteger(q.line) || q.line < 1
      || !Number.isSafeInteger(q.character) || q.character < 1) {
      throw new Error('Each cursor requires a .ts path and positive one-based UTF-16 coordinates')
    }
  }
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  const signal = exec.signal
  signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd, signal })
  const rootUri = fs.fileUrl(root)
  const texts = new Map<FsTarget['targetKey'], Source>()
  let remaining: number = DEFINITION_LIMITS.totalBytes, bytesRead = 0

  async function source(target: FsTarget): Promise<Source> {
    signal.throwIfAborted()
    const cached = texts.get(target.targetKey)
    if (cached) {
      if ((await fs.stat(target, signal))?.version !== cached.version) {
        throw new Error('Source changed during navigation; retry with current coordinates')
      }
      return cached
    }
    const cap = Math.min(DEFINITION_LIMITS.fileBytes, remaining)
    if (cap <= 0) throw new Error('Source read budget exhausted')
    const before = await fs.stat(target, signal)
    if (before?.type !== 'file' || !Number.isSafeInteger(before.size)
      || before.size! < 0 || before.size! > cap) throw new Error('Source is not a bounded regular file')
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
    return value
  }

  // Validate the entire input before starting even the first LSP request.
  const cursors: (DefinitionCursor & { path: string; target: FsTarget })[] = []
  for (const q of args.queries) {
    const target = await fs.resolve(q.file_path, { cwd, signal })
    if (!fs.contains(root, target)) throw new Error('Source is outside the Session workspace')
    const path = workspacePath(fs.fileUrl(target), rootUri)
    if (path === undefined) throw new Error('Source is outside the workspace .ts URI namespace')
    const value = await source(target)
    if (q.line > value.lines.length || q.character > value.lines[q.line - 1].length + 1) {
      throw new Error('Source cursor is outside current text')
    }
    cursors.push({ ...q, path, target })
  }
  signal.throwIfAborted()
  const seen = new Map<string, number>()
  let lspQueries = 0
  const jobs = cursors.map(async (q, index) => {
    const item: DefinitionItem = {
      index, path: q.path, line: q.line, character: q.character,
      status: 'empty', duplicateOf: -1, targets: [], omitted: 0, error: '',
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
  const responses = await Promise.all(jobs)
  let sourceRows = 0
  for (const { item, locations } of responses) {
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
        const first = Math.max(1, start.line - 1), last = Math.min(value.lines.length, start.line + 15)
        const lines: DefinitionTarget['lines'] = []
        for (let n = first; n <= last && sourceRows < DEFINITION_LIMITS.sourceRows; n++) {
          lines.push({ line: n, text: value.lines[n - 1].slice(0, 240), truncated: value.lines[n - 1].length > 240 })
          sourceRows++
        }
        item.targets.push({
          path: canonicalPath, uri: loc.uri, line: start.line + 1, character: start.character + 1,
          name: decl?.name ?? '', kind: decl?.kind ?? 'unknown', container: decl?.container ?? '',
          sha256: value.sha256, lines, contextComplete: lines.length === last - first + 1,
        })
      } catch (error) {
        signal.throwIfAborted()
        item.omitted++; item.error ||= failureMessage(error)
      }
    }
    if (item.omitted && item.status === 'ok') item.status = item.targets.length ? 'partial' : 'unavailable'
  }
  signal.throwIfAborted()
  return { items: responses.map(r => r.item), lspQueries, bytesRead, sourceRows,
    omittedTargets: responses.reduce((n, r) => n + r.item.omitted, 0) }
}

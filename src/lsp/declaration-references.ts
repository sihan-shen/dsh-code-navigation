import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { LspService, LspLocation } from '@deepseek-ai/dsh-lsp'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { extractDeclarations } from '../ast/typescript-declarations.js'
import type { Declaration } from '../ast/typescript-declarations.js'

const MAX_FILE_BYTES = 128 * 1024
const MAX_TOTAL_BYTES = 512 * 1024
const MAX_LOCATIONS = 30
const MAX_FILES = 10

export interface ReferenceFile {
  uri: string
  path: string
  locations: LspLocation[]
  lines: { line: number; text: string }[]
  reason: string
}

export interface ReferenceResult {
  status: 'ok' | 'empty' | 'not-found' | 'ambiguous'
  candidates: Declaration[]
  candidatesTruncated: boolean
  returnedLocations: number
  uniqueLocations: number
  uniqueLines: number
  uniqueFiles: number
  omittedLocations: number
  files: ReferenceFile[]
  reads: number
  bytesRead: number
  lspQueries: number
}

/** Resolve only URIs in this filesystem's own workspace URI namespace. */
function workspacePath(uri: string, rootUri: string): string | undefined {
  try {
    const root = new URL(rootUri), target = new URL(uri)
    const prefix = root.pathname.replace(/\/$/, '') + '/'
    if (target.protocol !== 'file:' || root.protocol !== 'file:' || target.host !== root.host
      || target.search || target.hash || !target.pathname.startsWith(prefix)) return undefined
    const path = decodeURIComponent(target.pathname.slice(prefix.length))
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..')) return undefined
    return path
  } catch { return undefined }
}

export async function findDeclarationReferences(
  fs: FileSystem, lsp: LspService, args: { file_path: string; name: string }, exec: ToolExecution,
): Promise<ReferenceResult> {
  const path = args.file_path
  if (!path || path.length > 512 || path.startsWith('/') || /^[A-Za-z]:/.test(path)
    || path.includes('\\') || !/\.ts$/i.test(path)) throw new Error('file_path must be a workspace-relative .ts declaration file')
  if (!args.name || args.name.length > 128
    || extractDeclarations('query.ts', `let ${args.name} = 1`, new Set([args.name]), 1).length !== 1) {
    throw new Error('name must be one exact TS identifier')
  }
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  const signal = exec.signal
  signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd, signal })
  const target = await fs.resolve(path, { cwd, signal })
  if (!fs.contains(root, target)) throw new Error('declaration file is outside the Session workspace')
  const result: ReferenceResult = {
    status: 'not-found', candidates: [], candidatesTruncated: false,
    returnedLocations: 0, uniqueLocations: 0, uniqueLines: 0, uniqueFiles: 0,
    omittedLocations: 0, files: [], reads: 0, bytesRead: 0, lspQueries: 0,
  }
  // Reserve each read's cap before I/O, including failed reads and files changing after stat.
  let remaining = MAX_TOTAL_BYTES
  async function readSource(file: FsTarget): Promise<string> {
    signal.throwIfAborted()
    const cap = Math.min(MAX_FILE_BYTES, remaining)
    if (cap <= 0) throw new Error('source read budget exhausted')
    const info = await fs.stat(file, signal)
    if (info?.type !== 'file') throw new Error('not a regular file')
    if (info.size === undefined || info.size > cap) throw new Error('file size unknown or exceeds source read budget')
    remaining -= cap
    result.reads++
    const bytes = await fs.readBytes(file, signal, cap)
    result.bytesRead += bytes.byteLength
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (source.includes('\0')) throw new Error('binary source')
    // Refund unused reservation only on a completed bounded read.
    remaining += cap - bytes.byteLength
    return source
  }
  const source = await readSource(target)
  const candidates = extractDeclarations(path, source, new Set([args.name]), MAX_LOCATIONS + 1)
  result.candidatesTruncated = candidates.length > MAX_LOCATIONS
  result.candidates = candidates.slice(0, MAX_LOCATIONS)
  if (candidates.length === 0) return result
  if (candidates.length !== 1) { result.status = 'ambiguous'; return result }
  const declaration = candidates[0]
  result.lspQueries++
  const query = await lsp.query({
    operation: 'findReferences', filePath: fs.processPath(target), workspaceRoot: fs.processPath(root),
    position: { line: declaration.line - 1, character: declaration.character - 1 },
  }, signal)
  if (query.kind !== 'locations') throw new Error('LSP returned an unexpected result kind')
  signal.throwIfAborted()
  result.returnedLocations = query.locations.length
  const unique = new Map<string, LspLocation>()
  for (const location of query.locations) {
    const r = location.range
    unique.set(JSON.stringify([location.uri, r.start.line, r.start.character, r.end.line, r.end.character]), location)
  }
  const locations = [...unique.values()]
  result.uniqueLocations = locations.length
  result.uniqueFiles = new Set(locations.map(item => item.uri)).size
  result.uniqueLines = new Set(locations.map(item => JSON.stringify([item.uri, item.range.start.line]))).size
  result.status = locations.length ? 'ok' : 'empty'
  result.omittedLocations = Math.max(0, locations.length - MAX_LOCATIONS)
  const groups = new Map<string, ReferenceFile>()
  const rootUri = fs.fileUrl(root)
  for (const location of locations.slice(0, MAX_LOCATIONS)) {
    let group = groups.get(location.uri)
    if (!group) {
      group = { uri: location.uri, path: workspacePath(location.uri, rootUri) ?? location.uri, locations: [], lines: [], reason: '' }
      groups.set(location.uri, group)
    }
    group.locations.push(location)
  }
  const sourceCache = new Map([[fs.fileUrl(target), source]])
  let attachedFiles = 0
  for (const group of groups.values()) {
    signal.throwIfAborted()
    const relativePath = workspacePath(group.uri, rootUri)
    if (query.resolvedWorkspaceUri !== rootUri) { group.reason = 'LSP and filesystem workspace URI differ'; continue }
    if (relativePath === undefined) { group.reason = 'external or non-file URI; source not read'; continue }
    if (attachedFiles >= MAX_FILES) { group.reason = 'source file limit reached'; continue }
    try {
      const file = await fs.resolve(relativePath, { cwd, signal })
      if (!fs.contains(root, file)) { group.reason = 'resolved outside workspace; source not read'; continue }
      const canonicalUri = fs.fileUrl(file)
      let text = sourceCache.get(canonicalUri)
      if (text === undefined) {
        text = await readSource(file)
        sourceCache.set(canonicalUri, text)
      }
      attachedFiles++
      const lines = text.split(/\r\n|\n|\r/)
      const needed = new Set<number>()
      for (const location of group.locations) {
        const start = location.range.start
        if (start.line < 0 || start.line >= lines.length || start.character < 0 || start.character > lines[start.line].length) {
          group.reason = 'a location does not match current source; verify file changes'
          continue
        }
        for (let i = Math.max(0, start.line - 1); i <= Math.min(lines.length - 1, start.line + 1); i++) needed.add(i)
      }
      group.lines = [...needed].sort((a, b) => a - b).map(i => ({ line: i + 1, text: lines[i].slice(0, 240) }))
    } catch (error) {
      signal.throwIfAborted()
      group.reason = error instanceof Error ? error.message : 'source read failed'
    }
  }
  result.files = [...groups.values()]
  return result
}

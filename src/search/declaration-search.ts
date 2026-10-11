import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ToolExecution, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { extractDeclarations } from '../ast/typescript-declarations.js'
import type { Declaration } from '../ast/typescript-declarations.js'

const MAX_FILES = 20
const MAX_NAMES = 8
const MAX_FILE_BYTES = 1024 * 1024
const MAX_RESULTS = 30
const SUPPORTED_FILE = /\.(?:ts|tsx|js|jsx)$/i

export interface SearchResult {
  filesScanned: number
  declarations: Declaration[]
  skipped: { path: string; reason: string }[]
  truncated: boolean
}

function validateNames(names: string[]): ReadonlySet<string> {
  if (names.length < 1 || names.length > MAX_NAMES) throw new Error(`names must contain 1–${MAX_NAMES} identifiers`)
  const unique = new Set<string>()
  for (const name of names) {
    if (name.length === 0 || name.length > 128) throw new Error('each name must contain 1–128 characters')
    const found = extractDeclarations('query.ts', `let ${name} = 1`, new Set([name]), 1)
    if (found.length !== 1) throw new Error(`name must be one valid TS/JS identifier: ${name}`)
    unique.add(name)
  }
  return unique
}

function validateFiles(files: string[]): string[] {
  if (files.length < 1 || files.length > MAX_FILES) throw new Error(`files must contain 1–${MAX_FILES} paths`)
  const unique = new Set<string>()
  for (const path of files) {
    if (!path || path.length > 512 || path.startsWith('/') || /^[A-Za-z]:/.test(path)
      || path.includes('\\') || !SUPPORTED_FILE.test(path)) {
      throw new Error(`unsupported workspace-relative TS/JS path: ${path}`)
    }
    unique.add(path)
  }
  return [...unique]
}

async function discoverFiles(tools: ToolRuntime, names: ReadonlySet<string>, exec: ToolExecution): Promise<string[]> {
  if (tools.get('grep', exec.agent) === undefined) throw new Error('host grep is unavailable; provide candidate files')
  const pattern = [...names].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const outcome = await tools.execute({
    callId: `${exec.callId}:grep` as typeof exec.callId,
    rootCallId: exec.rootCallId,
    parent: exec.token,
    agent: exec.agent,
    signal: exec.signal,
    name: 'grep',
    arguments: { pattern, include: '*.{ts,tsx,js,jsx}' },
  })
  if (outcome.isError) throw new Error(`host grep failed: ${outcome.error.message}; provide candidate files`)
  const value: unknown = outcome.value
  if (typeof value !== 'object' || value === null || !('matches' in value) || !Array.isArray(value.matches)) {
    throw new Error('host grep returned no structured matches')
  }
  const paths = new Set<string>()
  for (const match of value.matches) {
    if (typeof match !== 'object' || match === null || !('path' in match) || typeof match.path !== 'string') {
      throw new Error('host grep returned an invalid candidate path')
    }
    paths.add(match.path)
    if (paths.size > MAX_FILES) throw new Error(`host grep found more than ${MAX_FILES} candidate files; provide a narrower files list`)
  }
  return [...paths]
}

export async function findDeclarations(
  fs: FileSystem,
  tools: ToolRuntime,
  args: { names: string[]; files?: string[] },
  exec: ToolExecution,
): Promise<SearchResult> {
  const names = validateNames(args.names)
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  exec.signal.throwIfAborted()
  const candidates = args.files === undefined ? await discoverFiles(tools, names, exec) : args.files
  const result: SearchResult = { filesScanned: 0, declarations: [], skipped: [], truncated: false }
  if (candidates.length === 0 && args.files === undefined) return result
  const paths = validateFiles(candidates)
  const root = await fs.resolve('.', { cwd, signal: exec.signal })
  for (const path of paths) {
    exec.signal.throwIfAborted()
    const target = await fs.resolve(path, { cwd, signal: exec.signal })
    if (!fs.contains(root, target)) throw new Error(`path is outside the Session workspace: ${path}`)
    const info = await fs.stat(target, exec.signal)
    if (info?.type !== 'file') {
      result.skipped.push({ path, reason: info === undefined ? 'not found' : 'not a regular file' })
      continue
    }
    if (info.size === undefined || info.size > MAX_FILE_BYTES) {
      result.skipped.push({ path, reason: info.size === undefined ? 'size unknown' : 'file exceeds 1 MiB' })
      continue
    }
    let source: string
    try {
      const bytes = await fs.readBytes(target, exec.signal, MAX_FILE_BYTES)
      // Preserve BOM so syntax coordinates stay aligned with the original file.
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (source.includes('\0')) throw new Error('binary content')
    } catch (error) {
      exec.signal.throwIfAborted()
      result.skipped.push({ path, reason: error instanceof Error && error.message === 'binary content' ? 'binary content' : 'read failed' })
      continue
    }
    result.filesScanned++
    const declarations = extractDeclarations(path, source, names, MAX_RESULTS + 1 - result.declarations.length)
    result.declarations.push(...declarations)
    if (result.declarations.length > MAX_RESULTS) {
      result.declarations.length = MAX_RESULTS
      result.truncated = true
      break
    }
  }
  return result
}

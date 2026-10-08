import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { extractDeclarations } from './declarations.js'
import type { Declaration } from './declarations.js'

const MAX_FILES = 20
const MAX_FILE_BYTES = 1024 * 1024
const MAX_RESULTS = 30
const SUPPORTED_FILE = /\.(?:ts|tsx|js|jsx)$/i

export interface SearchResult {
  filesScanned: number
  declarations: Declaration[]
  skipped: { path: string; reason: string }[]
  truncated: boolean
}

function validateName(name: string): void {
  if (name.length === 0 || name.length > 128) throw new Error('name must contain 1–128 characters')
  const found = extractDeclarations('query.ts', `let ${name} = 1`, name, 1)
  if (found.length !== 1) throw new Error('name must be one valid TS/JS identifier')
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

export async function findDeclarations(
  fs: FileSystem,
  args: { name: string; files: string[] },
  exec: ToolExecution,
): Promise<SearchResult> {
  validateName(args.name)
  const paths = validateFiles(args.files)
  const cwd = exec.agent?.session.header.cwd
  if (!cwd) throw new Error('A Harness Session workspace is required')
  exec.signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd, signal: exec.signal })
  const result: SearchResult = { filesScanned: 0, declarations: [], skipped: [], truncated: false }
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
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (source.includes('\0')) throw new Error('binary content')
    } catch (error) {
      exec.signal.throwIfAborted()
      result.skipped.push({ path, reason: error instanceof Error && error.message === 'binary content' ? 'binary content' : 'read failed' })
      continue
    }
    result.filesScanned++
    const declarations = extractDeclarations(path, source, args.name, MAX_RESULTS + 1 - result.declarations.length)
    result.declarations.push(...declarations)
    if (result.declarations.length > MAX_RESULTS) {
      result.declarations.length = MAX_RESULTS
      result.truncated = true
      break
    }
  }
  return result
}

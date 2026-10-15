import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { DeclarationNode } from '../ast/typescript-declarations.js'
import { chunkText, normalizeVectors } from '../semantic/chunks.js'
import { loadSnapshot, snapshotLocation, verifySnapshot } from '../semantic/snapshot.js'
import { encoder, relativePath, resolveConfig } from '../semantic/types.js'
import type { IndexExecution, SemanticIndexConfig, SourceChunk } from '../semantic/types.js'

export interface SemanticQuery { query: string; path?: string; limit?: number }
export interface SemanticContextResult {
  indexCreatedAt: string
  embeddingId: string
  candidateChunks: number
  documentEmbeddings: number
  queryEmbeddings: number
  elapsedMs: number
  embeddingMs: number
  indexBytes: number
  truncated: boolean
  limits: string[]
  hits: (SourceChunk & { score: number; declarations: DeclarationNode[] })[]
  fragments: (SourceChunk & { text: string })[]
}

export async function searchSemanticContext(fs: FileSystem, input: SemanticIndexConfig,
  args: SemanticQuery, exec: IndexExecution): Promise<SemanticContextResult> {
  const started = performance.now(), config = resolveConfig(input)
  const query = args.query?.trim(), path = relativePath(args.path ?? '.'), limit = args.limit ?? 4
  if (!query || query.length > 1000 || /\0/.test(query)) throw new Error('query must contain 1–1000 characters')
  if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('limit must be an integer from 1 to 6')
  const location = await snapshotLocation(fs, exec), { snapshot, bytes } = await loadSnapshot(fs, config, location)
  const candidates = snapshot.chunks.filter(chunk => path === '.' || chunk.path === path || chunk.path.startsWith(path + '/'))
  const result: SemanticContextResult = { indexCreatedAt: snapshot.createdAt, embeddingId: snapshot.embedding.id,
    candidateChunks: candidates.length, documentEmbeddings: 0, queryEmbeddings: 0, elapsedMs: 0,
    embeddingMs: 0, indexBytes: bytes, truncated: !!snapshot.omissions.length, limits: [...snapshot.omissions], hits: [], fragments: [] }
  if (candidates.length) {
    const before = performance.now()
    const [vector] = normalizeVectors(await config.embedding.embed([query], 'query', location.signal), 1, config.embedding.dimensions)
    result.embeddingMs = performance.now() - before; result.queryEmbeddings = 1
    location.signal.throwIfAborted()
    const scored = candidates.map(chunk => ({ chunk, score: chunk.vector.reduce((sum, n, i) => sum + n * vector[i], 0) }))
      .sort((a, b) => b.score - a.score || (a.chunk.path < b.chunk.path ? -1 : a.chunk.path > b.chunk.path ? 1 : 0)
        || a.chunk.startLine - b.chunk.startLine)
    const files = new Map(snapshot.files.map(file => [file.path, file]))
    const covered = new Map<string, Set<number>>()
    let textBytes = 0
    for (const { chunk, score } of scored.slice(0, limit)) {
      location.signal.throwIfAborted()
      const file = files.get(chunk.path)!
      const declarations = file.declarations.filter(node => node.startLine <= chunk.endLine && node.endLine >= chunk.startLine)
        .sort((a, b) => Number(b.line >= chunk.startLine && b.line <= chunk.endLine)
          - Number(a.line >= chunk.startLine && a.line <= chunk.endLine)
          || (a.endLine - a.startLine) - (b.endLine - b.startLine) || a.line - b.line)
      result.hits.push({ path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine,
        score: Math.max(-1, Math.min(1, score)), declarations: declarations.filter(node => node.name.length <= 160).slice(0, 4) })
      if (declarations.length > result.hits[result.hits.length - 1].declarations.length) {
        result.limits.push(`${chunk.path}:${chunk.startLine}-${chunk.endLine}: AST metadata limited to 4 bounded names`)
      }
      const seen = covered.get(chunk.path) ?? new Set<number>()
      covered.set(chunk.path, seen)
      let start = chunk.startLine
      while (start <= chunk.endLine) {
        if (seen.has(start)) { start++; continue }
        let end = start
        while (end < chunk.endLine && !seen.has(end + 1)) end++
        const part = { path: chunk.path, startLine: start, endLine: end }
        const text = chunkText(part, file.source), size = encoder.encode(text).byteLength
        if (textBytes + size <= 8192) {
          result.fragments.push({ ...part, text }); textBytes += size
          for (let line = start; line <= end; line++) seen.add(line)
        } else result.limits.push(`${part.path}:${start}-${end}: source omitted by 8 KiB budget`)
        start = end + 1
      }
      // A ranked hit can be entirely covered by a higher hit; its mapping is retained.
    }
    if (scored.length > limit) result.limits.push(`top-${limit} candidates only; ${scored.length - limit} lower-ranked chunks not returned`)
  }
  await verifySnapshot(fs, location, snapshot)
  result.truncated = result.limits.length > 0
  result.elapsedMs = performance.now() - started
  return result
}

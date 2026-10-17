import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { DeclarationNode } from '../ast/typescript-declarations.js'
import { chunkText, normalizeVectors } from '../semantic/chunks.js'
import { loadSnapshot, snapshotLocation, verifySnapshot } from '../semantic/snapshot.js'
import { loadRelations, verifyRelations } from '../semantic/relations.js'
import { selectSemanticReferences } from './semantic-reference-selection.js'
import type { ReferenceEvidence } from '../semantic/relations.js'
import { encoder, relativePath, resolveConfig } from '../semantic/types.js'
import type { IndexExecution, SemanticIndexConfig, SourceChunk } from '../semantic/types.js'

export interface SemanticQuery { query: string; path?: string; limit?: number; expand_relations?: boolean }
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
  relations: ReferenceEvidence[]
  relationIndexCreatedAt: string
  relationIndexBytes: number
  lspQueries: number
  fragments: (SourceChunk & { text: string })[]
}

export async function searchSemanticContext(fs: FileSystem, input: SemanticIndexConfig,
  args: SemanticQuery, exec: IndexExecution): Promise<SemanticContextResult> {
  const started = performance.now(), config = resolveConfig(input)
  const query = args.query?.trim(), path = relativePath(args.path ?? '.'), limit = args.limit ?? 4
  if (!query || query.length > 1000 || /\0/.test(query)) throw new Error('query must contain 1–1000 characters')
  if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('limit must be an integer from 1 to 6')
  if (args.expand_relations !== undefined && typeof args.expand_relations !== 'boolean') throw new Error('expand_relations must be boolean')
  if (args.expand_relations === true && !config.relations) throw new Error('relations are not configured; the operator must configure and prepare them first')
  const location = await snapshotLocation(fs, exec), { snapshot, bytes, info } = await loadSnapshot(fs, config, location)
  const expanded = config.relations && args.expand_relations !== false
    ? await loadRelations(fs, config, location, snapshot, info.version) : undefined
  const candidates = snapshot.chunks.filter(chunk => path === '.' || chunk.path === path || chunk.path.startsWith(path + '/'))
  const result: SemanticContextResult = { indexCreatedAt: snapshot.createdAt, embeddingId: snapshot.embedding.id,
    candidateChunks: candidates.length, documentEmbeddings: 0, queryEmbeddings: 0, elapsedMs: 0,
    embeddingMs: 0, indexBytes: bytes, truncated: !!snapshot.omissions.length, limits: [...snapshot.omissions], hits: [], fragments: [], relations: [],
    relationIndexCreatedAt: expanded?.relations.createdAt ?? '', relationIndexBytes: expanded?.bytes ?? 0, lspQueries: 0 }
  if (candidates.length) {
    const before = performance.now()
    const [vector] = normalizeVectors(await config.embedding.embed([query], 'query', location.signal), 1, config.embedding.dimensions)
    result.embeddingMs = performance.now() - before; result.queryEmbeddings = 1
    location.signal.throwIfAborted()
    const scored = candidates.map(chunk => ({ chunk, score: chunk.vector.reduce((sum, n, i) => sum + n * vector[i], 0) }))
      .sort((a, b) => b.score - a.score || (a.chunk.path < b.chunk.path ? -1 : a.chunk.path > b.chunk.path ? 1 : 0)
        || a.chunk.startLine - b.chunk.startLine)
    const files = new Map(snapshot.files.map(file => [file.path, file]))
    const selected = scored.slice(0, limit)
    const covered = new Map<string, Set<number>>()
    let textBytes = 0
    function appendSource(part: SourceChunk, budget: number): void {
      const file = files.get(part.path)!, seen = covered.get(part.path) ?? new Set<number>()
      covered.set(part.path, seen)
      let start = part.startLine
      while (start <= part.endLine) {
        if (seen.has(start)) { start++; continue }
        let end = start
        while (end < part.endLine && !seen.has(end + 1)) end++
        const range = { path: part.path, startLine: start, endLine: end }
        const text = chunkText(range, file.source), size = encoder.encode(text).byteLength
        if (textBytes + size <= budget) {
          result.fragments.push({ ...range, text }); textBytes += size
          for (let line = start; line <= end; line++) seen.add(line)
        } else result.limits.push(`${part.path}:${start}-${end}: source omitted by shared budget`)
        start = end + 1
      }
    }
    if (expanded) {
      const selection = selectSemanticReferences(expanded.relations, selected.map(item => item.chunk), path)
      result.relations = selection.references
      result.limits.push(...selection.limits)
      for (const ref of result.relations) {
        const lines = files.get(ref.path)!.source.split('\n').length
        appendSource({ path: ref.path, startLine: Math.max(1, ref.line - 3), endLine: Math.min(lines, ref.line + 3) }, 3072)
      }
    }
    for (const { chunk, score } of selected) {
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
      appendSource(chunk, 8192)
    }
    if (scored.length > limit) result.limits.push(`top-${limit} candidates only; ${scored.length - limit} lower-ranked chunks not returned`)
  }
  await verifySnapshot(fs, location, snapshot)
  if (expanded) await verifyRelations(fs, location, expanded.relations)
  result.truncated = result.limits.length > 0
  result.elapsedMs = performance.now() - started
  return result
}

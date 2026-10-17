import { encoder } from './types.js'
import type { SourceChunk } from './types.js'

/** 与问题无关的连续块，保持与历史 40 行/2 KiB/8 行重叠的基线可比较。 */
export function sourceChunks(path: string, source: string): { chunks: SourceChunk[]; omissions: string[] } {
  const lines = source.split('\n'), chunks: SourceChunk[] = [], omissions: string[] = []
  const sizes = lines.map(line => encoder.encode(line).byteLength)
  for (let start = 0; start < lines.length;) {
    if (sizes[start] > 2048) {
      omissions.push(`${path}:${start + 1}: line exceeds 2048 UTF-8 bytes; not embedded`)
      start++; continue
    }
    let end = start, bytes = 0
    while (end < lines.length && end - start < 40 && bytes + sizes[end] + (end > start ? 1 : 0) <= 2048) {
      bytes += sizes[end] + (end > start ? 1 : 0); end++
    }
    if (lines.slice(start, end).join('\n').trim()) chunks.push({ path, startLine: start + 1, endLine: end })
    if (end === lines.length) break
    start = Math.max(start + 1, end - 8)
  }
  return { chunks, omissions }
}

export function chunkText(chunk: SourceChunk, source: string): string {
  return source.split('\n').slice(chunk.startLine - 1, chunk.endLine).join('\n')
}

export function normalizeVectors(value: readonly (readonly number[])[], count: number, dimensions: number): number[][] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('embedding returned an incorrect vector count')
  return Array.from(value, vector => {
    if (!Array.isArray(vector) || vector.length !== dimensions
      || Array.from(vector).some(n => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new Error('embedding returned non-finite values or incorrect dimensions')
    }
    const scale = Math.max(...vector.map(n => Math.abs(n)))
    if (!scale) throw new Error('embedding returned a zero vector')
    const norm = Math.sqrt(vector.reduce((sum, n) => sum + (n / scale) ** 2, 0))
    return vector.map(n => (n / scale) / norm)
  })
}

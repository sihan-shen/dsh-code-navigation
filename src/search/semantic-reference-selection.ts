import type { ReferenceEvidence, RelationsSnapshot } from '../semantic/relations.js'
import type { SourceChunk } from '../semantic/types.js'
import { encoder } from '../semantic/types.js'

/** 优先补种子范围外的位置；按锚点轮转，避免服务器顺序耗尽共享映射预算。 */
export function selectSemanticReferences(relations: RelationsSnapshot, seeds: readonly SourceChunk[], path: string): {
  references: ReferenceEvidence[]; limits: string[]
} {
  const limits: string[] = [], references: ReferenceEvidence[] = []
  const seedPaths = new Set(seeds.map(seed => seed.path))
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
  const tier = (ref: ReferenceEvidence): number => !seedPaths.has(ref.path) ? 0
    : seeds.some(seed => seed.path === ref.path && seed.startLine <= ref.line && seed.endLine >= ref.line) ? 2 : 1
  const seen = new Set<string>()
  const queues = relations.anchors.map(anchor => ({ anchor, rank: seeds.findIndex(seed => seed.path === anchor.anchor.path
    && seed.startLine <= anchor.anchor.line && seed.endLine >= anchor.anchor.line) }))
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || compare(a.anchor.targetId, b.anchor.targetId))
    .map(({ anchor }) => {
      limits.push(`${anchor.targetId}: anchored LSP references only; exclusions ${JSON.stringify(anchor.excluded)}; no complete call graph or unique overload target`)
      const items = anchor.references.filter(ref => {
        if (path !== '.' && ref.path !== path && !ref.path.startsWith(path + '/')) return false
        const key = JSON.stringify([ref.targetId, ref.path, ref.line, ref.character])
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).sort((a, b) => tier(a) - tier(b) || compare(a.path, b.path) || a.line - b.line || a.character - b.character)
      return { items, cursor: 0 }
    })
  let mappingBytes = 0, omitted = 0
  while (references.length < 8 && queues.some(queue => queue.cursor < queue.items.length)) {
    for (const queue of queues) {
      if (references.length >= 8) break
      while (queue.cursor < queue.items.length) {
        const ref = queue.items[queue.cursor++], bytes = encoder.encode(JSON.stringify(ref)).byteLength
        if (mappingBytes + bytes > 2048) { omitted++; continue }
        references.push(ref); mappingBytes += bytes
        break
      }
    }
  }
  omitted += queues.reduce((sum, queue) => sum + queue.items.length - queue.cursor, 0)
  if (omitted) limits.push(`${omitted} additional one-hop references omitted by 8-edge / 2 KiB mapping budget`)
  return { references, limits }
}

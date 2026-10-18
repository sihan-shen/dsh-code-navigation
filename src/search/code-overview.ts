import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { chunkText, sourceChunks } from '../semantic/chunks.js'
import { loadSnapshot, snapshotLocation } from '../semantic/snapshot.js'
import { loadOverviews, overviewCosts, verifyOverviewBase } from '../semantic/overviews.js'
import { resolveOverviewSetup } from '../semantic/overview-types.js'
import type { OverviewCitation, OverviewSetup } from '../semantic/overview-types.js'
import { encoder } from '../semantic/types.js'
import type { IndexExecution, SemanticIndexConfig, SourceChunk } from '../semantic/types.js'

export interface CodeOverviewQuery { node?: string; view?: 'summary' | 'source' }
export interface CodeOverviewResult {
  nodeId: string
  label: string
  view: 'summary' | 'source'
  sourceFiles: number
  snapshotCreatedAt: string
  overviewCreatedAt: string
  generatorId: string
  generationCalls: number
  storedCosts: ReturnType<typeof overviewCosts>
  catalog: { id: string; label: string; children: string[]; sourceFiles: number }[]
  claims: { text: string; evidence: OverviewCitation[] }[]
  fragments: (SourceChunk & { text: string })[]
  limits: string[]
}

export function overviewNodeHint(setup: OverviewSetup): string {
  const catalog = setup.nodes.map(node => ({ id: node.id, label: node.label,
    ...(encoder.encode(JSON.stringify(node.files[0])).byteLength <= 256
      ? { path: node.files[0] } : { pathOmitted: true }) }))
  return `Configured nodes: ${JSON.stringify(catalog)}. Default: ${JSON.stringify(setup.rootId)}. Example: nav_get_code_overview(${JSON.stringify({ node: setup.rootId })}).`
}

export async function getCodeOverview(fs: FileSystem, input: SemanticIndexConfig,
  args: CodeOverviewQuery, exec: IndexExecution): Promise<CodeOverviewResult> {
  const setup = resolveOverviewSetup(input), view = args.view ?? 'summary', id = args.node ?? setup.rootId
  if (view !== 'summary' && view !== 'source') throw new Error('overview view must be summary or source')
  if (typeof id !== 'string') throw new Error('overview node must be a configured id')
  const node = setup.nodes.find(node => node.id === id)
  if (!node) throw new Error(`unknown overview node. ${overviewNodeHint(setup)}`)
  const location = await snapshotLocation(fs, exec), { snapshot, info } = await loadSnapshot(fs, setup.semantic, location)
  const result: CodeOverviewResult = { nodeId: id, label: node.label, view, sourceFiles: node.files.length,
    snapshotCreatedAt: snapshot.createdAt, overviewCreatedAt: '', generatorId: setup.generator.id, generationCalls: 0,
    storedCosts: overviewCosts([]), catalog: setup.nodes.map(n => ({ id: n.id, label: n.label, children: [...n.children], sourceFiles: n.files.length })),
    claims: [], fragments: [], limits: [...snapshot.omissions] }
  const loaded = view === 'summary' ? await loadOverviews(fs, setup, location, snapshot, info.version) : undefined
  if (loaded) {
    const entry = loaded.overviews.nodes.find(entry => entry.id === id)!
    result.overviewCreatedAt = loaded.overviews.createdAt
    result.claims = entry.claims.map(claim => ({ text: claim.text, evidence: claim.evidence.map(ref => ({ ...ref })) }))
    result.storedCosts = overviewCosts(loaded.overviews.nodes)
    const descendants = new Set<string>()
    function include(id: string): void {
      descendants.add(id)
      for (const child of setup.nodes.find(node => node.id === id)!.children) include(child)
    }
    include(id)
    for (const child of loaded.overviews.nodes.filter(node => descendants.has(node.id))) {
      result.limits.push(...child.limitations.map(message => `${child.id}: ${message}`))
    }
    if (node.children.length) result.limits.push('Parent overview aggregates child summaries; it did not independently verify their claims against source.')
  } else {
    // 可重现的原文视图，而非按问题优化的检索基线；不依赖摘要文件或生成回调。
    const files = node.files.map(path => snapshot.files.find(file => file.path === path)!)
    const chunks = files.map(file => sourceChunks(file.path, file.source).chunks)
    const seen = new Set<string>()
    let usedBytes = 0, usedLines = 0, omitted = 0
    for (let i = 0; i < Math.max(...chunks.map(list => list.length)); i++) for (let j = 0; j < files.length; j++) {
      const chunk = chunks[j][i]
      if (!chunk) continue
      let start = chunk.startLine
      while (start <= chunk.endLine && seen.has(`${chunk.path}:${start}`)) start++
      if (start > chunk.endLine) continue
      const part = { ...chunk, startLine: start }, text = chunkText(part, files[j].source)
      const size = encoder.encode(text).byteLength, lines = part.endLine - part.startLine + 1
      if (usedBytes + size > 8192 || usedLines + lines > 96) { omitted++; continue }
      usedBytes += size; usedLines += lines
      result.fragments.push({ ...part, text })
      for (let line = part.startLine; line <= part.endLine; line++) seen.add(`${part.path}:${line}`)
    }
    result.limits.push('Source view samples consecutive chunks round-robin from file starts; it is not a question-optimized retrieval baseline or a full subsystem view.')
    if (omitted) result.limits.push(`${omitted} source ranges omitted by the shared 8 KiB / 96-line budget.`)
  }
  await verifyOverviewBase(fs, location, snapshot, info.version)
  if (loaded && (await fs.stat(loaded.target, location.signal))?.version !== loaded.version) throw new Error('overviews changed during query')
  return result
}

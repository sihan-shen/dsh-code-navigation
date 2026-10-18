import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { loadSnapshot, snapshotLocation, verifySnapshot } from './snapshot.js'
import type { SnapshotLocation } from './snapshot.js'
import { encoder, isCanonicalTimestamp, isRegularFileWithin } from './types.js'
import type { IndexExecution, SemanticIndexConfig, SemanticSnapshot } from './types.js'
import { exactOverviewKeys, overviewNumber, overviewText, resolveOverviewSetup,
  MAX_OVERVIEW_BYTES, MAX_OVERVIEW_INPUT_BYTES, OVERVIEWS_PATH, OVERVIEW_INSTRUCTION } from './overview-types.js'
import type { GeneratedOverview, OverviewPlanNode, OverviewRequest, OverviewSetup } from './overview-types.js'

export interface StoredOverview extends GeneratedOverview, OverviewPlanNode {
  generation: { elapsedMs: number; inputBytes: number; outputBytes: number }
}
export interface OverviewsSnapshot {
  format: 'ci-code-overviews-v1'
  workspaceKey: string
  indexVersion: string
  generatorId: string
  createdAt: string
  nodes: StoredOverview[]
}
export function overviewCosts(nodes: readonly StoredOverview[]) {
  function sum(values: number[]): number {
    const total = values.reduce((sum, value) => sum + value, 0)
    if (!overviewNumber(total)) throw new Error('overview cost total exceeds the safe integer range')
    return total
  }
  return { generationCalls: nodes.length,
    inputBytes: sum(nodes.map(node => node.generation.inputBytes)),
    outputBytes: sum(nodes.map(node => node.generation.outputBytes)),
    reportedTokens: sum(nodes.map(node => node.usage.totalTokens ?? 0)),
    reportedRequests: sum(nodes.map(node => node.usage.requests ?? 0)),
    unknownTokenCalls: nodes.filter(node => node.usage.totalTokens === null).length,
    unknownRequestCalls: nodes.filter(node => node.usage.requests === null).length }
}
async function overviewTarget(fs: FileSystem, location: SnapshotLocation): Promise<FsTarget> {
  const info = await fs.lstat(OVERVIEWS_PATH, { cwd: location.cwd }, location.signal)
  if (info && info.type !== 'file') throw new Error('overviews must be an ordinary file without symlinks')
  const target = await fs.resolve(OVERVIEWS_PATH, { cwd: location.cwd, signal: location.signal })
  if (!fs.contains(location.root, target)) throw new Error('overviews are outside the workspace')
  return target
}
export async function verifyOverviewBase(fs: FileSystem, location: SnapshotLocation,
  snapshot: SemanticSnapshot, indexVersion: string): Promise<void> {
  if ((await fs.stat(location.index, location.signal))?.version !== indexVersion) {
    throw new Error('base semantic index changed; rebuild overviews explicitly')
  }
  await verifySnapshot(fs, location, snapshot)
}
function requestFor(node: OverviewPlanNode, snapshot: SemanticSnapshot, children: readonly StoredOverview[]): OverviewRequest {
  return { profile: 'code-overview-v1', instruction: OVERVIEW_INSTRUCTION, node: { id: node.id, label: node.label },
    sources: node.children.length ? [] : node.files.map(path => ({ path, source: snapshot.files.find(file => file.path === path)!.source })),
    children: children.map(child => ({ id: child.id, label: child.label, claims: child.claims, limitations: child.limitations })) }
}
function validateGenerated(value: GeneratedOverview, node: OverviewPlanNode, snapshot: SemanticSnapshot,
  children: readonly StoredOverview[]): GeneratedOverview {
  const bad = (): never => { throw new Error(`invalid overview claims, citations or usage: ${node.id}`) }
  if (!exactOverviewKeys(value, ['claims', 'limitations', 'usage']) || !Array.isArray(value.claims)
    || value.claims.length < 1 || value.claims.length > 6 || !Array.isArray(value.limitations) || value.limitations.length > 4
    || !exactOverviewKeys(value.usage, ['totalTokens', 'requests'])
    || Object.values(value.usage).some(n => n !== null && !overviewNumber(n))) bad()
  const citationKey = (ref: { path: string; startLine: number; endLine: number }) => JSON.stringify([ref.path, ref.startLine, ref.endLine])
  const allowed = new Set(children.flatMap(child => child.claims.flatMap(claim => claim.evidence.map(citationKey))))
  const claims = Array.from(value.claims, claim => {
    if (!exactOverviewKeys(claim, ['text', 'evidence']) || !overviewText(claim.text, 400)
      || !Array.isArray(claim.evidence) || claim.evidence.length < 1 || claim.evidence.length > 3) return bad()
    const evidence = Array.from(claim.evidence, ref => {
      if (!exactOverviewKeys(ref, ['path', 'startLine', 'endLine']) || !Number.isSafeInteger(ref.startLine)
        || !Number.isSafeInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine
        || ref.endLine - ref.startLine >= 12 || !node.files.includes(ref.path)) return bad()
      const file = snapshot.files.find(file => file.path === ref.path)
      if (!file || ref.endLine > file.source.split('\n').length) return bad()
      const citation = { path: ref.path, startLine: ref.startLine, endLine: ref.endLine }
      if (node.children.length && !allowed.has(citationKey(citation))) return bad()
      return citation
    })
    if (new Set(evidence.map(ref => JSON.stringify(ref))).size !== evidence.length) return bad()
    return { text: claim.text, evidence }
  })
  const limitations = Array.from(value.limitations, item => overviewText(item, 200) ? item : bad())
  return { claims, limitations, usage: { totalTokens: value.usage.totalTokens, requests: value.usage.requests } }
}

export async function loadOverviews(fs: FileSystem, setup: OverviewSetup, location: SnapshotLocation,
  snapshot: SemanticSnapshot, indexVersion: string) {
  const target = await overviewTarget(fs, location), info = await fs.stat(target, location.signal)
  if (!info) throw new Error('overviews are not prepared; the operator must run prepareSemanticOverviews first')
  if (!isRegularFileWithin(info, MAX_OVERVIEW_BYTES)) throw new Error('overviews exceed 256 KiB or are not a regular file')
  const bytes = await fs.readBytes(target, location.signal, MAX_OVERVIEW_BYTES)
  if ((await fs.stat(target, location.signal))?.version !== info.version) throw new Error('overviews changed while being read')
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as OverviewsSnapshot
  const bad = (): never => { throw new Error('overviews invalid/stale/incompatible; run prepareSemanticOverviews with rebuild: true') }
  if (!exactOverviewKeys(value, ['format', 'workspaceKey', 'indexVersion', 'generatorId', 'createdAt', 'nodes'])
    || value.format !== 'ci-code-overviews-v1' || value.workspaceKey !== snapshot.workspaceKey || value.indexVersion !== indexVersion
    || value.generatorId !== setup.generator.id || !isCanonicalTimestamp(value.createdAt)
    || !Array.isArray(value.nodes) || value.nodes.length !== setup.order.length) bad()
  const previous = new Map<string, StoredOverview>()
  for (let i = 0; i < value.nodes.length; i++) {
    const entry = value.nodes[i], node = setup.order[i]
    if (!exactOverviewKeys(entry, ['id', 'label', 'files', 'children', 'claims', 'limitations', 'usage', 'generation'])
      || entry.id !== node.id || entry.label !== node.label || JSON.stringify(entry.files) !== JSON.stringify(node.files)
      || JSON.stringify(entry.children) !== JSON.stringify(node.children)
      || !exactOverviewKeys(entry.generation, ['inputBytes', 'outputBytes', 'elapsedMs'])
      || !Number.isFinite(entry.generation.elapsedMs) || entry.generation.elapsedMs < 0) bad()
    const children = node.children.map(id => previous.get(id)!)
    const generated = validateGenerated({ claims: entry.claims, limitations: entry.limitations, usage: entry.usage }, node, snapshot, children)
    // Stored inputBytes is cost metadata; recomputing it would reserialize every source on each query.
    if (!overviewNumber(entry.generation.inputBytes) || entry.generation.inputBytes > MAX_OVERVIEW_INPUT_BYTES
      || entry.generation.outputBytes !== encoder.encode(JSON.stringify(generated)).byteLength) bad()
    previous.set(node.id, entry)
  }
  overviewCosts(value.nodes)
  await verifyOverviewBase(fs, location, snapshot, indexVersion)
  return { overviews: value, bytes: bytes.byteLength, target, version: info.version }
}

async function generate(setup: OverviewSetup, request: OverviewRequest, signal: AbortSignal): Promise<GeneratedOverview> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  try {
    return await new Promise<GeneratedOverview>((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => { signal.throwIfAborted(); return setup.generator.generate(request, signal) }).then(resolve, reject)
    })
  } finally { signal.removeEventListener('abort', abort) }
}

/** 只由操作者显式准备；查询不自动生成。父节点仅聚合直接子摘要，不假装重新看过原文。 */
export async function prepareSemanticOverviews(fs: FileSystem, input: SemanticIndexConfig,
  exec: IndexExecution & { rebuild?: boolean }) {
  const started = performance.now(), setup = resolveOverviewSetup(input)
  const signal = AbortSignal.any([exec.signal ?? new AbortController().signal, AbortSignal.timeout(120000)])
  const location = await snapshotLocation(fs, { ...exec, signal }), { snapshot, info } = await loadSnapshot(fs, setup.semantic, location)
  const target = await overviewTarget(fs, location), previous = await fs.stat(target, signal)
  const result = (status: 'created' | 'rebuilt' | 'reused', value: OverviewsSnapshot, bytes: number) => ({ status,
    indexPath: OVERVIEWS_PATH, nodes: value.nodes.length, rootId: setup.rootId, indexBytes: bytes,
    generatedNodes: status === 'reused' ? 0 : value.nodes.length,
    ...overviewCosts(status === 'reused' ? [] : value.nodes), storedCosts: overviewCosts(value.nodes), elapsedMs: performance.now() - started })
  if (previous && !exec.rebuild) {
    const loaded = await loadOverviews(fs, setup, location, snapshot, info.version)
    return result('reused', loaded.overviews, loaded.bytes)
  }
  const value: OverviewsSnapshot = { format: 'ci-code-overviews-v1', workspaceKey: snapshot.workspaceKey,
    indexVersion: info.version, generatorId: setup.generator.id, createdAt: new Date().toISOString(), nodes: [] }
  for (const node of setup.order.filter(node => !node.children.length)) {
    if (encoder.encode(JSON.stringify(requestFor(node, snapshot, []))).byteLength > MAX_OVERVIEW_INPUT_BYTES) {
      throw new Error(`overview input exceeds 64 KiB: ${node.id}; narrow/split the explicit group`)
    }
  }
  for (const node of setup.order) {
    signal.throwIfAborted()
    const children = node.children.map(id => value.nodes.find(child => child.id === id)!)
    const request = requestFor(node, snapshot, children), inputBytes = encoder.encode(JSON.stringify(request)).byteLength
    if (inputBytes > MAX_OVERVIEW_INPUT_BYTES) throw new Error(`overview input exceeds 64 KiB: ${node.id}; narrow/split the explicit group`)
    const before = performance.now(), output = validateGenerated(await generate(setup, request, signal), node, snapshot, children)
    signal.throwIfAborted()
    value.nodes.push({ ...node, ...output, generation: { inputBytes,
      outputBytes: encoder.encode(JSON.stringify(output)).byteLength, elapsedMs: performance.now() - before } })
    if ((await fs.stat(location.index, signal))?.version !== info.version) {
      throw new Error('base semantic index changed; rebuild overviews explicitly')
    }
  }
  const text = JSON.stringify(value), bytes = encoder.encode(text).byteLength
  if (bytes > MAX_OVERVIEW_BYTES) throw new Error('overviews exceed 256 KiB')
  overviewCosts(value.nodes)
  const current = await snapshotLocation(fs, { ...exec, signal }), currentTarget = await overviewTarget(fs, current)
  if (current.root.targetKey !== location.root.targetKey || currentTarget.targetKey !== target.targetKey) throw new Error('overview path changed during preparation')
  await verifyOverviewBase(fs, location, snapshot, info.version)
  await fs.writeText(target, text, previous ? { kind: 'replaceIfVersion', version: previous.version } : { kind: 'createIfAbsent' }, signal)
  return result(previous ? 'rebuilt' : 'created', value, bytes)
}

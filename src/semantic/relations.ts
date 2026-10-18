import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { LspService } from '@deepseek-ai/dsh-lsp'
import { referenceSites } from '../ast/typescript-reference-sites.js'
import type { ReferenceSite } from '../ast/typescript-reference-sites.js'
import { loadSnapshot, snapshotLocation, verifySnapshot } from './snapshot.js'
import type { SnapshotLocation } from './snapshot.js'
import { encoder, isCanonicalTimestamp, isRegularFileWithin, resolveConfig } from './types.js'
import type { IndexExecution, RelationAnchor, SemanticIndexConfig, SemanticSnapshot } from './types.js'

const RELATIONS_PATH = '.code-navigation/semantic-relations.json'
const MAX_BYTES = 512 * 1024
export interface ReferenceEvidence extends ReferenceSite {
  path: string
  sourceVersion: string
  targetId: string
  targetVersion: string
}
interface AnchorReferences {
  anchor: RelationAnchor
  targetId: string
  targetVersion: string
  references: ReferenceEvidence[]
  excluded: { unprocessed: number; outsideScope: number; unsupported: number; overLimit: number }
}
interface EnvironmentVersion { path: string; targetKey: string; version: string }
export interface RelationsSnapshot {
  format: 'ci-semantic-relations-v1'
  indexVersion: string
  workspaceKey: string
  createdAt: string
  config: NonNullable<SemanticIndexConfig['relations']>
  environment: EnvironmentVersion[]
  anchors: AnchorReferences[]
}

async function relationTarget(fs: FileSystem, location: SnapshotLocation): Promise<FsTarget> {
  const info = await fs.lstat(RELATIONS_PATH, { cwd: location.cwd }, location.signal)
  if (info && info.type !== 'file') throw new Error('semantic relations must be an ordinary file without symlinks')
  const target = await fs.resolve(RELATIONS_PATH, { cwd: location.cwd, signal: location.signal })
  if (!fs.contains(location.root, target)) throw new Error('semantic relations path is outside workspace')
  return target
}

async function environmentVersions(fs: FileSystem, location: SnapshotLocation, paths: readonly string[]): Promise<EnvironmentVersion[]> {
  const result: EnvironmentVersion[] = []
  for (const path of paths) {
    const target = await fs.resolve(path, { cwd: location.cwd, signal: location.signal })
    const info = await fs.stat(target, location.signal)
    if (!fs.contains(location.root, target) || info?.type !== 'file' || !info.version) {
      throw new Error(`relation environment must be an existing workspace file: ${path}`)
    }
    result.push({ path, targetKey: target.targetKey, version: info.version })
  }
  return result
}

function anchorTarget(snapshot: SemanticSnapshot, anchor: RelationAnchor) {
  const file = snapshot.files.find(file => file.path === anchor.path)
  const node = file?.declarations.find(node => node.line === anchor.line && node.character === anchor.character)
  if (!file || !node) throw new Error(`relation anchor is not an exact supported declaration: ${anchor.path}:${anchor.line}:${anchor.character}`)
  return { file, node }
}

export async function verifyRelations(fs: FileSystem, location: SnapshotLocation, relations: RelationsSnapshot): Promise<void> {
  const current = await fs.stat(location.index, location.signal)
  if (current?.version !== relations.indexVersion || JSON.stringify(await environmentVersions(fs, location,
    relations.config.environmentFiles)) !== JSON.stringify(relations.environment)) {
    throw new Error('semantic relations are stale; run prepareSemanticRelations with rebuild: true')
  }
  location.signal.throwIfAborted()
}

export async function loadRelations(fs: FileSystem, config: SemanticIndexConfig, location: SnapshotLocation,
  snapshot: SemanticSnapshot, indexVersion: string): Promise<{ relations: RelationsSnapshot; bytes: number }> {
  if (!config.relations) throw new Error('semantic relations are not configured')
  const target = await relationTarget(fs, location), info = await fs.stat(target, location.signal)
  if (!info) throw new Error('semantic relations are not prepared; the operator must run prepareSemanticRelations first')
  if (!isRegularFileWithin(info, MAX_BYTES)) {
    throw new Error('semantic relations exceed 512 KiB or are not a regular file')
  }
  const bytes = await fs.readBytes(target, location.signal, MAX_BYTES)
  if ((await fs.stat(target, location.signal))?.version !== info.version) throw new Error('semantic relations changed while being read')
  const bad = (): never => { throw new Error('semantic relations invalid/incompatible; run prepareSemanticRelations with rebuild: true') }
  let relations: RelationsSnapshot
  try { relations = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return bad() }
  if (!relations || relations.format !== 'ci-semantic-relations-v1' || relations.indexVersion !== indexVersion
    || relations.workspaceKey !== snapshot.workspaceKey || JSON.stringify(relations.config) !== JSON.stringify(config.relations)
    || !isCanonicalTimestamp(relations.createdAt)
    || !Array.isArray(relations.anchors) || relations.anchors.length !== config.relations.anchors.length
    || !Array.isArray(relations.environment) || relations.environment.length !== config.relations.environmentFiles.length) bad()
  // 磁盘角色/容器不作为可信语法；只复核实际引用的文件，不执行 LSP 或 embedding。
  const siteCache = new Map<string, Map<string, ReferenceSite>>()
  const sitesFor = (path: string): Map<string, ReferenceSite> => {
    let sites = siteCache.get(path)
    if (!sites) {
      const file = snapshot.files.find(file => file.path === path)
      sites = file ? referenceSites(file.path, file.source) : new Map()
      siteCache.set(path, sites)
    }
    return sites
  }
  for (let i = 0; i < relations.anchors.length; i++) {
    const entry = relations.anchors[i], anchor = config.relations.anchors[i], { file, node } = anchorTarget(snapshot, anchor)
    if (!entry || JSON.stringify(entry.anchor) !== JSON.stringify(anchor) || entry.targetId !== node.id
      || entry.targetVersion !== file.version || !Array.isArray(entry.references) || entry.references.length > 24
      || !entry.excluded || Object.keys(entry.excluded).sort().join(',') !== 'outsideScope,overLimit,unprocessed,unsupported'
      || Object.values(entry.excluded).some(n => !Number.isSafeInteger(n) || n < 0)) bad()
    const seen = new Set<string>()
    for (const ref of entry.references) {
      if (!ref || Object.keys(ref).sort().join(',') !== 'character,containerId,endCharacter,line,path,role,sourceVersion,targetId,targetVersion'
        || !Number.isInteger(ref.line) || !Number.isInteger(ref.character) || !Number.isInteger(ref.endCharacter)) bad()
      const source = snapshot.files.find(file => file.path === ref.path)
      const site = sitesFor(ref.path).get(`${ref.line}:${ref.character}`)
      const key = `${ref.path}:${ref.line}:${ref.character}`
      if (!source || !site || ref.sourceVersion !== source.version || ref.targetId !== node.id
        || ref.targetVersion !== file.version || ref.endCharacter !== site.endCharacter
        || ref.role !== site.role || ref.containerId !== site.containerId || seen.has(key)) bad()
      seen.add(key)
    }
  }
  await verifyRelations(fs, location, relations)
  return { relations, bytes: bytes.byteLength }
}

/** 在已准备固定源码上显式构建入向引用；不发现全仓关系，不构建向量。 */
export async function prepareSemanticRelations(fs: FileSystem, lsp: LspService, input: SemanticIndexConfig,
  exec: IndexExecution & { rebuild?: boolean }) {
  const started = performance.now(), config = resolveConfig(input)
  if (!config.relations) throw new Error('relations configuration is required')
  const location = await snapshotLocation(fs, { ...exec,
    signal: AbortSignal.any([exec.signal ?? new AbortController().signal, AbortSignal.timeout(120000)]) })
  const { snapshot, info } = await loadSnapshot(fs, config, location), target = await relationTarget(fs, location)
  const previous = await fs.stat(target, location.signal)
  const result = (value: RelationsSnapshot, status: 'created' | 'rebuilt' | 'reused', bytes: number, lspQueries: number) => ({
    status, indexPath: RELATIONS_PATH, anchors: value.anchors.length,
    references: value.anchors.reduce((n, a) => n + a.references.length, 0),
    excluded: value.anchors.map(a => ({ targetId: a.targetId, ...a.excluded })),
    indexBytes: bytes, lspQueries, documentEmbeddings: 0, elapsedMs: performance.now() - started,
  })
  if (previous && !exec.rebuild) {
    const loaded = await loadRelations(fs, config, location, snapshot, info.version)
    await verifySnapshot(fs, location, snapshot)
    return result(loaded.relations, 'reused', loaded.bytes, 0)
  }
  const relations: RelationsSnapshot = { format: 'ci-semantic-relations-v1', indexVersion: info.version,
    workspaceKey: snapshot.workspaceKey, createdAt: new Date().toISOString(), config: config.relations,
    environment: await environmentVersions(fs, location, config.relations.environmentFiles), anchors: [] }
  const filesByUri = new Map<string, SemanticSnapshot['files'][number]>()
  for (const file of snapshot.files) {
    const source = await fs.resolve(file.path, { cwd: location.cwd, signal: location.signal })
    filesByUri.set(fs.fileUrl(source), file)
  }
  const sites = new Map(snapshot.files.map(file => [file.path, referenceSites(file.path, file.source)]))
  for (const anchor of config.relations.anchors) {
    const { file, node } = anchorTarget(snapshot, anchor)
    const entry: AnchorReferences = { anchor, targetId: node.id, targetVersion: file.version, references: [],
      excluded: { unprocessed: 0, outsideScope: 0, unsupported: 0, overLimit: 0 } }
    const source = await fs.resolve(file.path, { cwd: location.cwd, signal: location.signal })
    const response = await lsp.query({ operation: 'findReferences', filePath: fs.processPath(source),
      workspaceRoot: fs.processPath(location.root), position: { line: anchor.line - 1, character: anchor.character - 1 } }, location.signal)
    location.signal.throwIfAborted()
    if (response.kind !== 'locations' || response.resolvedWorkspaceUri !== fs.fileUrl(location.root)) {
      throw new Error('relation LSP result/workspace differs from filesystem workspace')
    }
    entry.excluded.unprocessed = Math.max(0, response.locations.length - 256)
    const seen = new Set<string>()
    for (const loc of response.locations.slice(0, 256)) {
      const file = filesByUri.get(loc.uri)
      if (!file) { entry.excluded.outsideScope++; continue }
      const { start, end } = loc.range
      const site = sites.get(file.path)?.get(`${start.line + 1}:${start.character + 1}`)
      if (!site || !Number.isInteger(start.line) || !Number.isInteger(start.character) || start.line !== end.line
        || end.character + 1 !== site.endCharacter) { entry.excluded.unsupported++; continue }
      const key = `${file.path}:${site.line}:${site.character}`
      if (seen.has(key)) continue
      seen.add(key)
      if (entry.references.length >= 24) { entry.excluded.overLimit++; continue }
      entry.references.push({ path: file.path, sourceVersion: file.version, targetId: node.id, targetVersion: entry.targetVersion, ...site })
    }
    relations.anchors.push(entry)
  }
  await verifySnapshot(fs, location, snapshot)
  await verifyRelations(fs, location, relations)
  const current = await snapshotLocation(fs, location)
  if (current.root.targetKey !== location.root.targetKey || (await relationTarget(fs, current)).targetKey !== target.targetKey) {
    throw new Error('semantic relations path changed during preparation')
  }
  const text = JSON.stringify(relations), bytes = encoder.encode(text).byteLength
  if (bytes > MAX_BYTES) throw new Error('semantic relations exceed 512 KiB')
  await fs.writeText(target, text, previous ? { kind: 'replaceIfVersion', version: previous.version } : { kind: 'createIfAbsent' }, location.signal)
  return result(relations, previous ? 'rebuilt' : 'created', bytes, relations.anchors.length)
}

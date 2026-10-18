import ts from 'typescript'
import type { FileSystem, FsTarget, FsInfo } from '@deepseek-ai/dsh-fs'
import { extractDeclarationTree } from '../ast/typescript-declarations.js'
import { chunkText, normalizeVectors, sourceChunks } from './chunks.js'
import { encoder, INDEX_PATH, MAX_CHUNKS, MAX_FILE_BYTES, MAX_INDEX_BYTES,
  MAX_SOURCE_BYTES, MAX_VECTOR_VALUES, resolveConfig } from './types.js'
import type { IndexExecution, SemanticIndexConfig, SemanticSnapshot, SnapshotFile } from './types.js'

export interface SnapshotLocation { root: FsTarget; index: FsTarget; signal: AbortSignal; cwd: string }

export async function snapshotLocation(fs: FileSystem, exec: IndexExecution): Promise<SnapshotLocation> {
  if (!exec.cwd) throw new Error('a Harness Session workspace/cwd is required')
  const signal = exec.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const root = await fs.resolve('.', { cwd: exec.cwd, signal })
  if ((await fs.stat(root, signal))?.type !== 'directory') throw new Error('workspace must be a directory')
  // 不允许缓存目录或最终文件链接到别处；路径不存在时由宿主原子写创建。
  for (const path of ['.code-navigation', INDEX_PATH]) {
    const info = await fs.lstat(path, { cwd: exec.cwd }, signal)
    if (info && info.type !== (path === INDEX_PATH ? 'file' : 'directory')) {
      throw new Error('semantic index directory/file must be ordinary paths, without symlinks')
    }
  }
  const index = await fs.resolve(INDEX_PATH, { cwd: exec.cwd, signal })
  if (!fs.contains(root, index)) throw new Error('semantic index is outside the workspace')
  return { root, index, signal, cwd: exec.cwd }
}

async function sourceTarget(fs: FileSystem, location: SnapshotLocation, path: string): Promise<{ target: FsTarget; info: FsInfo }> {
  const { signal, cwd, root } = location
  signal.throwIfAborted()
  const target = await fs.resolve(path, { cwd, signal })
  if (!fs.contains(root, target) || target.targetKey === location.index.targetKey) throw new Error(`source is outside the fixed workspace: ${path}`)
  const info = await fs.stat(target, signal)
  if (!info || info.type !== 'file' || !Number.isSafeInteger(info.size) || info.size! < 0 || info.size! > MAX_FILE_BYTES) {
    throw new Error(`source must be a regular file of at most 1 MiB: ${path}`)
  }
  return { target, info }
}

/** 整个固定文件集复核；只比较宿主版本信号，不解析 token，也不计算哈希。 */
export async function verifySnapshot(fs: FileSystem, location: SnapshotLocation, snapshot: SemanticSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    const { target, info } = await sourceTarget(fs, location, file.path)
    if (target.targetKey !== file.targetKey || info.version !== file.version) {
      throw new Error(`semantic index is stale: ${file.path}; run prepareSemanticIndex with rebuild: true`)
    }
  }
  location.signal.throwIfAborted()
}

function decodeSnapshot(text: string, config: SemanticIndexConfig, location: SnapshotLocation): SemanticSnapshot {
  const value = JSON.parse(text) as SemanticSnapshot
  const bad = (): never => { throw new Error('semantic index is invalid or incompatible; run prepareSemanticIndex with rebuild: true') }
  if (!value || value.format !== 'ci-semantic-snapshot-v1' || value.parserVersion !== ts.version
    || value.workspaceKey !== location.root.targetKey || !value.embedding
    || value.embedding.id !== config.embedding.id || value.embedding.dimensions !== config.embedding.dimensions
    || typeof value.createdAt !== 'string' || value.createdAt.length !== 24
    || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
    || !Array.isArray(value.files) || value.files.length !== config.files.length
    || !Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > MAX_CHUNKS
    || value.chunks.length * config.embedding.dimensions > MAX_VECTOR_VALUES
    || !Array.isArray(value.omissions) || value.omissions.length > 4096
    || value.omissions.some(message => typeof message !== 'string' || message.length > 1024)) bad()
  let sourceBytes = 0, declarationCount = 0
  const targets = new Set<string>()
  const expectedChunks: ReturnType<typeof sourceChunks>['chunks'] = [], expectedOmissions: string[] = []
  for (let i = 0; i < value.files.length; i++) {
    const file = value.files[i]
    if (!file || file.path !== config.files[i] || typeof file.targetKey !== 'string' || !file.targetKey
      || typeof file.version !== 'string' || !file.version || targets.has(file.targetKey)
      || typeof file.source !== 'string' || typeof file.syntaxError !== 'boolean' || !Array.isArray(file.declarations)) bad()
    targets.add(file.targetKey)
    const bytes = encoder.encode(file.source).byteLength
    sourceBytes += bytes
    if (bytes > MAX_FILE_BYTES || sourceBytes > MAX_SOURCE_BYTES || /\0|\r(?!\n)|[\u2028\u2029]/.test(file.source)) bad()
    const lines = file.source.split('\n')
    const parents = new Map<string, SnapshotFile['declarations'][number]>()
    declarationCount += file.declarations.length
    if (declarationCount > 4096 || (file.syntaxError && file.declarations.length)) bad()
    for (const node of file.declarations) {
      if (!node || typeof node.name !== 'string' || !node.name || typeof node.kind !== 'string'
        || !['function', 'class', 'interface', 'type', 'enum', 'variable', 'method'].includes(node.kind)
        || typeof node.parentId !== 'string' || !Number.isInteger(node.line) || !Number.isInteger(node.character)
        || !Number.isInteger(node.startLine) || !Number.isInteger(node.endLine)
        || node.startLine < 1 || node.startLine > node.line || node.line > node.endLine || node.endLine > lines.length
        || node.character < 1 || node.character > lines[node.line - 1].length + 1
        || node.id !== `${file.path}:${node.line}:${node.character}` || parents.has(node.id)) bad()
      const parent = parents.get(node.parentId)
      if (node.parentId && (!parent || parent.startLine > node.startLine || parent.endLine < node.endLine)) bad()
      parents.set(node.id, node)
    }
    const layout = sourceChunks(file.path, file.source)
    expectedChunks.push(...layout.chunks); expectedOmissions.push(...layout.omissions)
    if (file.syntaxError) expectedOmissions.push(`${file.path}: syntax diagnostics; AST metadata unavailable`)
  }
  if (expectedChunks.length !== value.chunks.length || JSON.stringify(expectedOmissions) !== JSON.stringify(value.omissions)) bad()
  for (let i = 0; i < value.chunks.length; i++) {
    const chunk = value.chunks[i], expected = expectedChunks[i]
    if (!chunk || chunk.path !== expected.path || chunk.startLine !== expected.startLine || chunk.endLine !== expected.endLine) bad()
    // 校验磁盘数值，精确 cosine 的归一化与冷准备一致；不调用 embedding/AST。
    chunk.vector = normalizeVectors([chunk.vector], 1, config.embedding.dimensions)[0]
  }
  return value
}

export async function loadSnapshot(fs: FileSystem, config: SemanticIndexConfig, location: SnapshotLocation): Promise<{
  snapshot: SemanticSnapshot; info: FsInfo; bytes: number
}> {
  const { index, signal } = location
  const info = await fs.stat(index, signal)
  if (!info) throw new Error('semantic index is not prepared; the operator must run prepareSemanticIndex first')
  if (info.type !== 'file' || !Number.isSafeInteger(info.size) || info.size! < 0 || info.size! > MAX_INDEX_BYTES) {
    throw new Error('semantic index must be a regular file of at most 64 MiB')
  }
  const bytes = await fs.readBytes(index, signal, MAX_INDEX_BYTES)
  const current = await fs.stat(index, signal)
  if (current?.version !== info.version) throw new Error('semantic index changed while being read; retry after preparation finishes')
  let snapshot: SemanticSnapshot
  try {
    snapshot = decodeSnapshot(new TextDecoder('utf-8', { fatal: true }).decode(bytes), config, location)
  } catch (error) {
    signal.throwIfAborted()
    throw new Error(`cannot reuse semantic index: ${error instanceof Error ? error.message : 'invalid snapshot'}; rebuild explicitly`)
  }
  await verifySnapshot(fs, location, snapshot)
  return { snapshot, info, bytes: bytes.byteLength }
}

export interface PreparationResult {
  status: 'created' | 'rebuilt' | 'reused'
  indexPath: string
  files: number
  chunks: number
  declarations: number
  embeddedDocuments: number
  sourceBytes: number
  indexBytes: number
  elapsedMs: number
  embeddingMs: number
  omissions: string[]
}

/** 显式准备入口；查询和插件加载从不隐式构建或更新索引。 */
export async function prepareSemanticIndex(fs: FileSystem, input: SemanticIndexConfig,
  exec: IndexExecution & { rebuild?: boolean }): Promise<PreparationResult> {
  const started = performance.now(), config = resolveConfig(input), location = await snapshotLocation(fs, exec)
  const { index, root, signal } = location
  const previous = await fs.stat(index, signal)
  const result = (snapshot: SemanticSnapshot, status: PreparationResult['status'], indexBytes: number,
    embeddedDocuments: number, embeddingMs: number): PreparationResult => ({
    status, indexPath: INDEX_PATH, files: snapshot.files.length, chunks: snapshot.chunks.length,
    declarations: snapshot.files.reduce((sum, file) => sum + file.declarations.length, 0), embeddedDocuments,
    sourceBytes: snapshot.files.reduce((sum, file) => sum + encoder.encode(file.source).byteLength, 0),
    indexBytes, elapsedMs: performance.now() - started, embeddingMs, omissions: snapshot.omissions,
  })
  if (previous && !exec.rebuild) {
    const loaded = await loadSnapshot(fs, config, location)
    return result(loaded.snapshot, 'reused', loaded.bytes, 0, 0)
  }
  const snapshot: SemanticSnapshot = { format: 'ci-semantic-snapshot-v1', parserVersion: ts.version,
    workspaceKey: root.targetKey, embedding: { id: config.embedding.id, dimensions: config.embedding.dimensions },
    createdAt: new Date().toISOString(), files: [], chunks: [], omissions: [] }
  let sourceBytes = 0, declarationCount = 0
  const targets = new Set<string>()
  for (const path of config.files) {
    const { target, info } = await sourceTarget(fs, location, path)
    if (targets.has(target.targetKey)) throw new Error(`duplicate canonical source: ${path}`)
    targets.add(target.targetKey)
    sourceBytes += info.size!
    if (sourceBytes > MAX_SOURCE_BYTES) throw new Error('fixed source set exceeds 4 MiB')
    const bytes = await fs.readBytes(target, signal, MAX_FILE_BYTES)
    if (bytes.byteLength !== info.size || (await fs.stat(target, signal))?.version !== info.version) {
      throw new Error(`source changed during preparation: ${path}`)
    }
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (/\0|\r(?!\n)|[\u2028\u2029]/.test(source)) throw new Error(`unsupported binary or line separators: ${path}`)
    const tree = extractDeclarationTree(path, source)
    declarationCount += tree.declarations.length
    if (declarationCount > 4096) throw new Error('semantic index exceeds 4096 declarations')
    snapshot.files.push({ path, targetKey: target.targetKey, version: info.version, source, ...tree })
    const layout = sourceChunks(path, source)
    snapshot.chunks.push(...layout.chunks.map(chunk => ({ ...chunk, vector: [] })))
    snapshot.omissions.push(...layout.omissions)
    if (tree.syntaxError) snapshot.omissions.push(`${path}: syntax diagnostics; AST metadata unavailable`)
    if (snapshot.chunks.length > MAX_CHUNKS || snapshot.chunks.length * config.embedding.dimensions > MAX_VECTOR_VALUES) {
      throw new Error('semantic index exceeds 2048 chunks or 2097152 vector values; narrow the fixed file set')
    }
  }
  if (!snapshot.chunks.length) throw new Error('fixed source set contains no embeddable chunks')
  const sources = new Map(snapshot.files.map(file => [file.path, file.source]))
  let embeddingMs = 0
  for (let start = 0; start < snapshot.chunks.length; start += 8) {
    signal.throwIfAborted()
    const batch = snapshot.chunks.slice(start, start + 8)
    const documents = batch.map(chunk => `${chunk.path}:${chunk.startLine}-${chunk.endLine}\n${chunkText(chunk, sources.get(chunk.path)!)}`)
    const before = performance.now()
    const vectors = normalizeVectors(await config.embedding.embed(documents, 'document', signal), batch.length, config.embedding.dimensions)
    embeddingMs += performance.now() - before
    signal.throwIfAborted()
    batch.forEach((chunk, i) => { chunk.vector = vectors[i] })
  }
  await verifySnapshot(fs, location, snapshot)
  const text = JSON.stringify(snapshot), indexBytes = encoder.encode(text).byteLength
  if (indexBytes > MAX_INDEX_BYTES) throw new Error('serialized semantic index exceeds 64 MiB')
  // 重新检查缓存路径与 canonical identity；不发布失败/取消的半成品。
  const currentLocation = await snapshotLocation(fs, exec)
  if (currentLocation.root.targetKey !== root.targetKey || currentLocation.index.targetKey !== index.targetKey) {
    throw new Error('semantic index path changed during preparation')
  }
  await verifySnapshot(fs, location, snapshot)
  await fs.writeText(index, text, previous ? { kind: 'replaceIfVersion', version: previous.version }
    : { kind: 'createIfAbsent' }, signal)
  return result(snapshot, previous ? 'rebuilt' : 'created', indexBytes, snapshot.chunks.length, embeddingMs)
}

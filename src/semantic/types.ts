import type { DeclarationNode } from '../ast/typescript-declarations.js'
import type { SemanticOverviewsConfig } from './overview-types.js'

/** id 必须包括模型修订、pooling、预处理与 query/document 指令版本。 */
export interface LocalEmbedding {
  id: string
  dimensions: number
  embed(texts: readonly string[], purpose: 'document' | 'query', signal: AbortSignal):
    Promise<readonly (readonly number[])[]>
}

export interface RelationAnchor { path: string; line: number; character: number }
export interface SemanticRelationsConfig {
  /** 操作者标识实际 LSP 工具链/配置；并非由宿主返回的 provider 身份。 */
  lspId: string
  environmentFiles: readonly string[]
  anchors: readonly RelationAnchor[]
}

export interface SemanticIndexConfig {
  /** 固定的工作区相对 TS/JS 文件集合，不进行 glob 或全仓发现。 */
  files: readonly string[]
  embedding: LocalEmbedding
  relations?: SemanticRelationsConfig
  overviews?: SemanticOverviewsConfig
}

export interface IndexExecution { cwd: string; signal?: AbortSignal }
export interface SourceChunk { path: string; startLine: number; endLine: number }
export interface SnapshotFile {
  path: string
  targetKey: string
  version: string
  source: string
  syntaxError: boolean
  declarations: DeclarationNode[]
}
export interface SemanticSnapshot {
  format: 'ci-semantic-snapshot-v1'
  parserVersion: string
  workspaceKey: string
  embedding: { id: string; dimensions: number }
  createdAt: string
  files: SnapshotFile[]
  chunks: (SourceChunk & { vector: number[] })[]
  omissions: string[]
}

export const INDEX_PATH = '.code-navigation/semantic-index.json'
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_SOURCE_BYTES = 4 * MAX_FILE_BYTES
export const MAX_INDEX_BYTES = 64 * MAX_FILE_BYTES
export const MAX_CHUNKS = 2048
export const MAX_VECTOR_VALUES = 2097152
export const encoder = new TextEncoder()

export function relativePath(value: string): string {
  if (typeof value !== 'string' || !value || encoder.encode(value).byteLength > 512 || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || /[\\\0\r\n]/.test(value) || value.split('/').includes('..')) {
    throw new Error('semantic index paths must be workspace-relative without parent traversal')
  }
  return value.split('/').filter(part => part && part !== '.').join('/') || '.'
}

export function resolveConfig(config: SemanticIndexConfig): SemanticIndexConfig {
  if (!config || !Array.isArray(config.files) || config.files.length < 1 || config.files.length > 32) {
    throw new Error('semantic index requires 1–32 explicit files')
  }
  const files = config.files.map(file => relativePath(file)).sort()
  if (files.some(file => !/\.(ts|tsx|js|jsx)$/i.test(file) || file.startsWith('.code-navigation/'))
    || new Set(files).size !== files.length) throw new Error('semantic index requires unique TS/JS source paths')
  const embedding = config.embedding
  if (!embedding || typeof embedding.id !== 'string' || !embedding.id.trim() || embedding.id.length > 256
    || /[\0\r\n]/.test(embedding.id) || !Number.isInteger(embedding.dimensions)
    || embedding.dimensions < 1 || embedding.dimensions > 4096 || typeof embedding.embed !== 'function') {
    throw new Error('a local embedding id, dimensions (1–4096) and embed function are required')
  }
  let relations: SemanticRelationsConfig | undefined
  if (config.relations) {
    const r = config.relations
    if (typeof r.lspId !== 'string' || !r.lspId.trim() || encoder.encode(r.lspId).byteLength > 256
      || /[\0\r\n]/.test(r.lspId) || !Array.isArray(r.anchors) || r.anchors.length < 1 || r.anchors.length > 8
      || !Array.isArray(r.environmentFiles) || r.environmentFiles.length < 1 || r.environmentFiles.length > 16) {
      throw new Error('relations require lspId, 1–8 declaration anchors and 1–16 environment files')
    }
    const anchors = r.anchors.map(anchor => {
      const path = relativePath(anchor.path)
      if (!files.includes(path) || !Number.isSafeInteger(anchor.line) || anchor.line < 1
        || !Number.isSafeInteger(anchor.character) || anchor.character < 1) throw new Error('relation anchors require exact prepared declaration coordinates')
      return Object.freeze({ path, line: anchor.line, character: anchor.character })
    }).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.character - b.character)
    const environmentFiles = r.environmentFiles.map(relativePath).sort()
    if (new Set(anchors.map(a => JSON.stringify(a))).size !== anchors.length
      || new Set(environmentFiles).size !== environmentFiles.length
      || environmentFiles.some(path => path === '.' || path.startsWith('.code-navigation/'))) throw new Error('duplicate anchors or invalid environment files')
    relations = Object.freeze({ lspId: r.lspId, anchors: Object.freeze(anchors), environmentFiles: Object.freeze(environmentFiles) })
  }
  return { relations, files: Object.freeze(files), embedding: Object.freeze({ id: embedding.id,
    dimensions: embedding.dimensions, embed: embedding.embed.bind(embedding) }) }
}

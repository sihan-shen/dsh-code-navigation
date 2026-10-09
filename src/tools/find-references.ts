import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-lsp'
import { findDeclarationReferences } from '../lsp/declaration-references.js'
import type { ReferenceResult } from '../lsp/declaration-references.js'

const POSITION_SCHEMA = {
  type: 'object', required: true, additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
  },
} as const

function renderReferences(value: ReferenceResult): string {
  if (value.status === 'not-found') return 'No matching syntax declaration in the specified file; no LSP query was made.'
  if (value.status === 'ambiguous') {
    const rows = ['Ambiguous syntax declarations; no LSP query was made. Select a candidate and use native lsp at its position.']
    let length = rows[0].length, shown = 0
    for (const c of value.candidates) {
      const row = `${c.path}:${c.line}:${c.character} ${c.kind}${c.container ? ` in ${c.container}` : ''}`
      if (length + row.length + 1 > 3600) break
      rows.push(row); length += row.length + 1; shown++
    }
    rows.push(`Shown ${shown} declaration candidates${value.candidatesTruncated || shown < value.candidates.length ? '; additional candidates omitted' : ''}.`)
    return rows.join('\n')
  }
  const target = value.candidates[0]
  const header = `Target ${target.path}:${target.line}:${target.character} ${target.kind}; references include declaration.\nServer returned ${value.returnedLocations} locations; unique ${value.uniqueLocations} locations / ${value.uniqueLines} starting lines / ${value.uniqueFiles} files.`
  const blocks: string[] = []
  let length = header.length, shown = 0, sourceRowsShown = 0
  // Positions take priority over source context; a large snippet must not hide references.
  for (const file of value.files) {
    const block = [file.path,
      ...file.locations.map(l => `  ${l.range.start.line + 1}:${l.range.start.character + 1}-${l.range.end.line + 1}:${l.range.end.character + 1}`),
    ].join('\n')
    if (length + block.length + 1 > 3500) continue
    blocks.push(block); length += block.length + 1; shown += file.locations.length
  }
  for (const file of value.files) {
    const title = `Source ${file.path}${file.reason ? ` (${file.reason})` : ''}`
    if (length + title.length + 1 > 3500) continue
    const rows = [title]
    let blockLength = title.length
    for (const line of file.lines) {
      const row = `  ${line.line} | ${line.text}`
      if (length + blockLength + row.length + 2 > 3500) continue
      rows.push(row); blockLength += row.length + 1; sourceRowsShown++
    }
    if (rows.length > 1 || file.reason) { blocks.push(rows.join('\n')); length += blockLength + 1 }
  }
  const sourceRows = value.files.reduce((n, file) => n + file.lines.length, 0)
  return [header, ...blocks,
    `Shown ${shown} locations; omitted ${value.uniqueLocations - shown}. Source rows ${sourceRowsShown}/${sourceRows}; each row capped at 240 characters. Context is current text, not an atomic LSP snapshot.`,
    ...(value.status === 'empty' ? ['Server returned no references at this declaration; this is not a service failure.'] : []),
  ].join('\n')
}

export function registerFindReferencesTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ci_find_references',
    description: 'Find semantic references to one exact-name declaration in a known workspace-relative .ts file. Use this directly when the declaration file and name are known: it locates the unique syntax declaration, makes one host LSP query, and returns ranges plus bounded nearby source. Do not first enumerate textual references or read every file. Multiple declarations return candidates without querying LSP. Includes declarations and aliases; reports location, line and file counts separately. Snippets do not establish call hierarchy; read further only when needed for behavior, enclosing functions, ambiguity, truncation or conflicting source. For arbitrary use-sites or non-TS files use native lsp.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Known workspace-relative .ts declaration file.' },
      name: { type: 'string', required: true, description: 'One exact declaration identifier; no import alias resolution or global name search.' },
    },
    // Structured results retain precise ranges; only the model-facing presentation is capped.
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['ok', 'empty', 'not-found', 'ambiguous'] as const },
          candidates: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true }, path: { type: 'string', required: true },
              line: { type: 'integer', required: true }, character: { type: 'integer', required: true },
              kind: { type: 'string', required: true }, container: { type: 'string', required: true },
              sourceLine: { type: 'string', required: true },
            },
          } },
          candidatesTruncated: { type: 'boolean', required: true },
          returnedLocations: { type: 'integer', required: true },
          uniqueLocations: { type: 'integer', required: true },
          uniqueLines: { type: 'integer', required: true }, uniqueFiles: { type: 'integer', required: true },
          omittedLocations: { type: 'integer', required: true, description: 'Locations excluded by the structured result limit; rendering reports any additional omissions separately.' },
          reads: { type: 'integer', required: true, description: 'Project readBytes attempts, excluding host LSP source synchronization.' },
          bytesRead: { type: 'integer', required: true, description: 'Bytes returned by project readBytes calls, excluding host LSP reads.' },
          lspQueries: { type: 'integer', required: true },
          files: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              uri: { type: 'string', required: true }, path: { type: 'string', required: true },
              locations: { type: 'array', required: true, items: {
                type: 'object', additionalProperties: false, properties: {
                  uri: { type: 'string', required: true },
                  range: { type: 'object', required: true, additionalProperties: false,
                    description: 'Zero-based UTF-16 half-open range from the host LSP; rendered coordinates are one-based.', properties: {
                    start: POSITION_SCHEMA, end: POSITION_SCHEMA,
                  } },
                },
              } },
              lines: { type: 'array', required: true, items: {
                type: 'object', additionalProperties: false, properties: {
                  line: { type: 'integer', required: true }, text: { type: 'string', required: true },
                },
              } },
              reason: { type: 'string', required: true },
            },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReferences(value) }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => findDeclarationReferences(ctx.fs, ctx.lsp, args, exec),
  }))
}

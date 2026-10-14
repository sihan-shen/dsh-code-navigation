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
  const blocks: { file: ReferenceResult['files'][number]; rows: string[] }[] = []
  let length = header.length, shown = 0, sourceRowsShown = 0
  // Positions take priority over source context; a large snippet must not hide references.
  for (const file of value.files) {
    const block = [file.path,
      ...file.locations.map(l => `  ${l.range.start.line + 1}:${l.range.start.character + 1}-${l.range.end.line + 1}:${l.range.end.character + 1}`),
    ].join('\n')
    if (length + block.length + 1 > 3500) continue
    blocks.push({ file, rows: [block] }); length += block.length + 1; shown += file.locations.length
  }
  // Reserve all displayed positions before filling each file block with source.
  for (const { file, rows } of blocks) {
    const hits = new Set(file.locations.map(location => location.range.start.line + 1))
    if (file.reason) {
      const row = `  Context: ${file.reason}`
      if (length + row.length + 1 <= 3500) { rows.push(row); length += row.length + 1 }
    }
    for (const line of file.lines) {
      const row = `  ${hits.has(line.line) ? '*' : ' '}${line.line} | ${line.text}`
      if (length + row.length + 1 > 3500) continue
      rows.push(row); length += row.length + 1; sourceRowsShown++
    }
  }
  const sourceRows = value.files.reduce((n, file) => n + file.lines.length, 0)
  return [header, ...blocks.map(block => block.rows.join('\n')),
    `Shown ${shown} locations; omitted ${value.uniqueLocations - shown}. Source rows ${sourceRowsShown}/${sourceRows}; * marks reference starting lines. Import/export context capped at 12 lines; each row at 240 characters. Context is current text, not an atomic LSP snapshot.`,
    ...(value.status === 'empty' ? ['Server returned no references at this declaration; this is not a service failure.'] : []),
  ].join('\n')
}

export function registerFindReferencesTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ci_find_references',
    description: 'Replace searching and ordinary read of candidate usage files when semantic references are needed and a declaration name plus its workspace-relative .ts file are known. Returned exact ranges and bounded source replace those reads when sufficient; do not add a reference query just to confirm uses already proved. Call directly with file_path and name; no manual cursor or preliminary reference grep is needed. Unknown declaration path: first use ci_find_declarations. A unique declaration triggers one host LSP query; multiple declarations return candidates without a query, so select a candidate and use native lsp. Results include the declaration, exact ranges, counts and bounded source. Check omissions/context limits; read only missing behavior or enclosing code. Source snippets do not establish call hierarchy. For use-site cursors or other file types use native lsp.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Known workspace-relative .ts file containing the declaration; use the selected declaration result path.' },
      name: { type: 'string', required: true, description: 'Exact declared identifier in that file, not an import alias or regex; this tool does not search for files.' },
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

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { findDeclarations } from '../search/declaration-search.js'

export function registerFindDeclarationsTool(ctx: Context): void {
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({
      name: 'tool:ci_find_declarations', order: scoped.systemPrompt.getSectionOrder('TOOL_GREP') + 2,
      text: ({ scope }) => scoped.tools.get('ci_find_declarations', scope) === undefined ? ''
        : `Use ci_find_declarations when exact known-name declaration identity, kind or coordinates are missing. Its result replaces reading those declarations; read only missing implementation/signature context.${scoped.tools.get('lsp', scope) === undefined ? '' : ' For references, pass the returned declaration coordinates to native lsp; for definition/hover use an exact surviving call/import/extends position.'}`,
    })
  })
  ctx.tools.register(defineTool({
    name: 'ci_find_declarations',
    description: 'Replace ordinary read of candidate TS/JS files when the question needs exact named declaration identity, kind, container or coordinates. Returns those facts directly; answer from them when sufficient, rather than reading files or querying already-read declarations for confirmation. Supply files already found by grep/glob/context search; common names such as run or String should use explicit files. Without files, literal grep discovers at most 20 candidate files, including references and imports; batching names expands their union and may exceed that limit. On overflow no files are parsed: confirm relevant paths from the bounded candidate clues and retry with the same names and explicit files only if identity or coordinates are still needed. Never repeat the unchanged unscoped query. Returns path, kind, container and a first-line preview capped at 240 characters, not a full signature or inferred type. Read only missing implementation/signature ranges. Select same-name declarations by path/container. For uses, pass selected declaration coordinates unchanged to native lsp findReferences; for definition/hover use an exact surviving call/import/extends symbol position, not a fragment start. Supports direct identifier names on functions, classes, interfaces, types, enums, variables and methods, not destructured bindings. Check skipped/truncated; zero results do not prove absence.',
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: '1–8 exact identifiers, not regexes. Batch related names within known files; without files prefer a small distinctive anchor because candidate files are the union of all text matches.' },
      files: { type: 'array', items: { type: 'string' }, description: '1–20 confirmed workspace-relative .ts/.tsx/.js/.jsx files, never an empty array. Reuse paths from grep/glob/context results. Omit only when paths are unknown; automatic discovery also has a hard 20-file limit. Overflow requires confirmed files, not the same unscoped retry.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          filesScanned: { type: 'integer', required: true },
          declarations: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                character: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                container: { type: 'string', required: true },
                sourceLine: { type: 'string', required: true },
              },
            },
          },
          skipped: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: [
          `${args.files === undefined ? 'Host grep discovered candidates in the Session workspace' : 'Used provided candidate files'}; scanned ${value.filesScanned}, skipped ${value.skipped.length}; found ${value.declarations.length} declaration(s)${value.truncated ? ' (result limit reached)' : ''}.`,
          ...args.names.map(requested => `${requested}: ${value.declarations.filter(item => item.name === requested).length} declaration(s) in scanned files.`),
          ...value.declarations.map(item => `${item.name} — ${item.path}:${item.line}:${item.character} ${item.kind}${item.container ? ` in ${item.container}` : ''}\n  ${item.sourceLine}`),
          ...value.skipped.map(item => `Skipped ${item.path}: ${item.reason}`),
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return findDeclarations(ctx.fs, ctx.tools, _args, exec)
    },
  }))
}

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
        : 'Use ci_find_declarations to locate exact named TS/JS declarations and cursor coordinates; batch related names. It returns a first-line preview, not a complete signature or inferred type. Read only missing implementation or signature ranges. Use native lsp at a surviving call site for definitions or hover when available; use findReferences at a selected declaration only when its uses matter. A deleted declaration cannot supply semantic evidence. Do not repeat an unchanged empty query.',
    })
  })
  ctx.tools.register(defineTool({
    name: 'ci_find_declarations',
    description: 'Locate exact named TS/JS syntax declarations and one-based UTF-16 cursor coordinates. Batch names; omit files when paths are unknown (candidate grep is built in). Returns path, kind, container and a first-line preview capped at 240 characters, not a complete signature or inferred type. Read missing signature or implementation ranges only. Same-name results can be different symbols: select by path/container. If uses matter, pass the selected path/line/character unchanged to native lsp findReferences when available. For definition or hover, query a surviving call site instead; deleted declarations cannot be resolved. Supports direct identifier names on functions, classes, interfaces, types, enums, variables and methods, not destructured bindings. Escaped spellings may require explicit files. Check skipped/truncated; zero results do not prove absence.',
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: '1–8 exact identifiers, not regexes; batch related declaration queries, e.g. ["apply", "createSession"].' },
      files: { type: 'array', items: { type: 'string' }, description: 'Omit when paths are unknown: candidate grep is built in. Otherwise provide 1–20 known workspace-relative .ts/.tsx/.js/.jsx files; never an empty array.' },
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

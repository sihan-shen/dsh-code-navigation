import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { findDeclarations } from '../search/declaration-search.js'

export function registerFindDeclarationsTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ci_find_declarations',
    description: 'Find exact-name TS/JS syntax declarations for up to 8 names in one call. Omit files for host grep candidate discovery in the Session workspace; provide workspace-relative files only when already known. Results contain path, line, kind and a line read from current source, so a separate grep/read is unnecessary for declaration location alone. Read surrounding code when its behavior matters. These are syntax facts, not resolved symbols.',
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: 'One to eight exact identifier names to find together.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional: 1–20 known workspace-relative .ts, .tsx, .js or .jsx paths. Omit to discover candidates automatically; do not pass an empty array.' },
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
          ...value.declarations.map(item => `${item.name} — ${item.path}:${item.line} ${item.kind}${item.container ? ` in ${item.container}` : ''}\n  ${item.sourceLine}`),
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

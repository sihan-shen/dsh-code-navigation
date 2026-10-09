import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { findDeclarations } from '../search/declaration-search.js'

export function registerFindDeclarationsTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ci_find_declarations',
    description: 'Locate named TS/JS syntax declarations. Start here for declaration discovery: batch names and omit files unless already known; this tool runs candidate grep itself. Each result gives path, kind, container, sourceLine and one-based UTF-16 line/character. Same-name results may be different symbols: select the intended path/container. To find semantic references, pass that result to native lsp with operation=findReferences, file_path=path and line/character unchanged. Use bounded read for behavior or enclosing code; grep finds text, not symbol identity. Check skipped/truncated before claiming complete discovery.',
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: '1–8 exact identifiers, not regexes; batch related declaration queries.' },
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

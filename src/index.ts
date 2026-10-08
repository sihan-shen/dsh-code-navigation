import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { findDeclarations } from './search.js'

export const name = 'code-intelligence'
export const inject = ['tools', 'fs']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ci_find_declarations',
    description: 'Find exact-name TS/JS syntax declarations in candidate files found with grep. Results are syntax facts, not resolved symbols.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact identifier name to find.' },
      files: { type: 'array', required: true, items: { type: 'string' }, description: 'Up to 20 workspace-relative .ts, .tsx, .js or .jsx candidate paths.' },
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
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Scanned ${value.filesScanned} file(s); found ${value.declarations.length} declaration(s)${value.truncated ? ' (result limit reached)' : ''}.`,
          ...value.declarations.map(item => `${item.path}:${item.line} ${item.kind}${item.container ? ` in ${item.container}` : ''}\n  ${item.sourceLine}`),
          ...value.skipped.map(item => `Skipped ${item.path}: ${item.reason}`),
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return findDeclarations(ctx.fs, _args, exec)
    },
  }))

  // Stage 0 still needs one real Session call before this temporary probe can go.
  ctx.tools.register(defineTool({
    name: 'ci_rc_probe',
    description: 'Return the current Harness session working directory for RC integration checks.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      if (exec.signal.aborted) throw new Error('Tool call was aborted')
      return `rc-ok:${exec.agent?.session.header.cwd ?? 'no-session'}`
    },
  }))
}

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'code-intelligence'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ci_rc_probe',
    description: 'Return the current Harness session working directory for RC integration smoke checks.',
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

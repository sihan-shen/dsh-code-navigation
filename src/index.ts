import type { Context } from '@deepseek-ai/cordis'
import { registerFindDeclarationsTool } from './tools/find-declarations.js'

export const name = 'code-intelligence'
export const inject = ['tools', 'fs']

export function apply(ctx: Context): void {
  registerFindDeclarationsTool(ctx)
}

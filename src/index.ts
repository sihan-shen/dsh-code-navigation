import type { Context } from '@deepseek-ai/cordis'
import { registerFindReferencesTool } from './tools/find-references.js'
import { registerFindDeclarationsTool } from './tools/find-declarations.js'

export const name = 'code-intelligence'
export const inject = ['tools', 'fs']

export function apply(ctx: Context, config: { enableDeclarationReferences?: boolean } = {}): void {
  registerFindDeclarationsTool(ctx)
  if (config.enableDeclarationReferences === true) {
    ctx.inject(['lsp'], scoped => registerFindReferencesTool(scoped))
  }
}

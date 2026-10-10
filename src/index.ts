import type { Context } from '@deepseek-ai/cordis'
import { registerFindReferencesTool } from './tools/find-references.js'
import { registerFindDeclarationsTool } from './tools/find-declarations.js'
import { registerSearchContextTool } from './tools/search-context.js'

export const name = 'code-intelligence'
export const inject = ['tools', 'fs']

export function apply(ctx: Context, config: { enableDeclarationReferences?: boolean; enableCodeContext?: boolean } = {}): void {
  registerFindDeclarationsTool(ctx)
  if (config.enableCodeContext === true) registerSearchContextTool(ctx)
  if (config.enableDeclarationReferences === true) {
    ctx.inject(['lsp'], scoped => registerFindReferencesTool(scoped))
  }
}

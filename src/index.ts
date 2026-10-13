import type { Context } from '@deepseek-ai/cordis'
import { registerBatchDefinitionsTool } from './tools/batch-definitions.js'
import { registerFindReferencesTool } from './tools/find-references.js'
import { registerFindDeclarationsTool } from './tools/find-declarations.js'
import { registerSearchContextTool } from './tools/search-context.js'
import { registerToolCooperationPrompt } from './tools/tool-cooperation.js'

export const name = 'code-intelligence'
export const inject = ['tools', 'fs']

export function apply(ctx: Context, config: {
  /** 批量定义导航与前置指导；默认关闭，须宿主 LSP 服务。 */
  enablePrecedingLsp?: boolean
  enableDeclarationReferences?: boolean
  enableCodeContext?: boolean
  enableToolCooperationPrompt?: boolean
} = {}): void {
  registerFindDeclarationsTool(ctx)
  if (config.enableToolCooperationPrompt === true) registerToolCooperationPrompt(ctx)
  if (config.enableCodeContext === true) registerSearchContextTool(ctx)
  if (config.enablePrecedingLsp === true) {
    ctx.inject(['lsp'], scoped => registerBatchDefinitionsTool(scoped))
  }
  if (config.enableDeclarationReferences === true) {
    ctx.inject(['lsp'], scoped => registerFindReferencesTool(scoped))
  }
}

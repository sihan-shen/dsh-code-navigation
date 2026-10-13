import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export function registerToolCooperationPrompt(ctx: Context): void {
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({
      name: 'tool:code_intelligence_cooperation',
      order: scoped.systemPrompt.getSectionOrder('TOOL_LSP') + 1,
      text: ({ scope }) => {
        const has = (name: string) => scoped.tools.get(name, scope) !== undefined
        const ast = has('ci_find_declarations'), rag = has('ci_search_context'), lsp = has('lsp'), batch = has('ci_batch_definitions')
        if (!ast && !rag && !batch) return ''
        const parts = ['Choose tools by the missing evidence; a read-only investigation can need semantic navigation. Do not call every available tool just to complete a sequence.']
        if (rag) parts.push('Use ci_search_context for implementation context and reuse its numbered source.')
        if (ast) parts.push('Use ci_find_declarations for exact identity or coordinates. Reuse confirmed paths as files, especially for common names. On candidate overflow, confirm paths from the returned clues or grep/glob, then retry once with unchanged names and explicit files only if identity or coordinates remain necessary; never repeat the unchanged unscoped query.')
        if (batch) parts.push('Use ci_batch_definitions early for remaining .ts use-site bindings: batch ready exact cursors and reuse returned coordinates, syntax metadata and bounded source. Do not repeat targets already evidenced. Unknown kinds or missing enclosing declarations need source verification; query indices are not question roles.')
        if (lsp) parts.push('Use lsp when a remaining claim needs the actual cross-file symbol target, uses or type rather than a spelling match. findReferences uses the selected declaration path/line/character unchanged. goToDefinition/hover uses an exact surviving call/import/extends symbol position, not the start of a source fragment. Missing external implementations remain unknown.')
        parts.push('Read only uncovered branches or resolved targets. Each query should resolve a remaining claim; stop when the evidence is sufficient.')
        return parts.join(' ')
      },
    })
  })
}

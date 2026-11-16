import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export function registerToolCooperationPrompt(ctx: Context): void {
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({
      name: 'tool:code_intelligence_cooperation',
      order: scoped.systemPrompt.getSectionOrder('TOOL_GREP') - 1,
      text: ({ scope }) => {
        const has = (name: string) => scoped.tools.get(name, scope) !== undefined
        const ast = has('nav_find_declarations'), rag = has('nav_search_context'), lsp = has('lsp'), batch = has('nav_batch_definitions')
        const semantic = has('nav_search_semantic_context'), refs = has('nav_find_references'), overview = has('nav_get_code_overview')
        if (!ast && !rag && !batch && !semantic && !refs && !overview) return ''
        const parts = ['Route TS/JS code navigation to dedicated tools by the needed evidence:']
        if (overview) parts.push('Use nav_get_code_overview first when a subsystem responsibility map is needed.')
        if (rag) parts.push('For 1–6 literal terms or identifiers needing surrounding implementation source (including multi-term A|B|C lookups within a directory or file), prefer nav_search_context over separate grep plus read.' + (semantic ? ' With semanticIndex, pass query and mode=hybrid for concept recall.' : ''))
        if (semantic) parts.push('For concept search inside the prepared file set without literal terms, use nav_search_semantic_context.')
        if (ast) parts.push('To locate named TS/JS declarations, signatures, containers or coordinates, prefer nav_find_declarations (with files when paths are known) over grepping or reading candidate files.')
        if (refs) parts.push('For semantic references of a known-file unique .ts declaration, use nav_find_references.')
        if (batch) parts.push('For unresolved .ts static bindings or short call chains at seen call sites, use nav_batch_definitions.')
        if (lsp) parts.push('For unresolved cross-file symbol targets, references or types, use native lsp at exact symbol coordinates.')
        parts.push('Use grep for regex-only patterns or non-TS/JS files, and use read only for unshown line ranges.')
        return parts.join(' ')
      },
    })
  })
}

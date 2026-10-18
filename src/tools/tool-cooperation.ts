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
        const semantic = has('ci_search_semantic_context')
        if (!ast && !rag && !batch && !semantic) return ''
        const parts = ['Choose tools by the missing evidence; a read-only investigation can need semantic navigation. Do not call every available tool just to complete a sequence.']
        if (rag) parts.push('When literal search needs bounded implementation source, use ci_search_context instead of separate grep and ordinary read of matching files; use its numbered evidence directly.' + (semantic ? ' When a prepared semanticIndex is visible, ci_search_context also accepts a natural-language query with mode hybrid; lexical declarations and anchors stay primary, and vector-seeded source is not semantic proof.' : ''))
        if (semantic) parts.push('For conceptual questions inside the prepared fixed file set, ci_search_semantic_context can retrieve source without guessing literal terms. Its vectors and AST containment are candidates and syntax metadata, not cross-file binding proof. Reuse displayed evidence and stop when sufficient; an absent or stale index needs operator preparation.')
        if (ast) parts.push('When only known-name declaration identity, kind or coordinates are missing, use ci_find_declarations instead of opening candidate files with read; do not query already-read declarations for confirmation. Reuse confirmed paths as files, especially for common names. On candidate overflow, confirm paths from the returned clues or grep/glob, then retry once with unchanged names and explicit files only if identity or coordinates remain necessary; never repeat the unchanged unscoped query.')
        if (batch) parts.push("Before each tool call, identify the requested fact still missing. If visible source already proves the requested identities, kinds and locations, answer now, including simple same-file declarations; no navigation or hover is required for reassurance. Otherwise ci_batch_definitions replaces target-file read for unresolved .ts bindings or supported short linked facts. Send available entry outer uses without first reading targets to find all roles; one root is valid and downstream anchors may be unknown. Omit definition_only for linked facts. Reuse returned mappings/source; another import, alternate use or target read is justified only by a still-unresolved requested binding. Unsupported/omitted facts may need focused grep/read. On file_too_large, changing path/cursor cannot help; keep existing evidence and switch method only for a remaining claim. Stop once the requested facts are supported; report only those facts and verified coordinates. Declaration/self is not another use, query numbers are not task roles, and static definitions do not prove runtime dispatch.")
        if (lsp) parts.push('Use lsp when a remaining claim needs the actual cross-file symbol target, uses or type rather than a spelling match. findReferences uses the selected declaration path/line/character unchanged. goToDefinition/hover uses an exact surviving call/import/extends symbol position, not the start of a source fragment. Missing external implementations remain unknown.')
        parts.push('Read only missing source ranges or uncovered behavior; a resolved target is not by itself a reason to read it. Each query should resolve a remaining claim; stop when the evidence is sufficient.')
        return parts.join(' ')
      },
    })
  })
}

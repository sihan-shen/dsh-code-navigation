import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { findDeclarations } from '../search/declaration-search.js'

export function registerFindDeclarationsTool(ctx: Context): void {
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({
      name: 'tool:nav_find_declarations', order: scoped.systemPrompt.getSectionOrder('TOOL_GREP') + 2,
      text: ({ scope }) => {
        if (scoped.tools.get('nav_find_declarations', scope) === undefined) return ''
        const hasBash = scoped.tools.get('bash', scope) !== undefined
        const hasLsp = scoped.tools.get('lsp', scope) !== undefined
        const hasRefs = scoped.tools.get('nav_find_references', scope) !== undefined
        return `Use nav_find_declarations to locate 1–8 named TS/JS declarations (functions, classes, interfaces, types, enums, variables, methods) and get exact 1-based coordinates, kind, container and first-line signature preview instead of grepping or reading candidate files just to find where symbols are declared.${hasBash ? ' Do not use shell grep/sed/cat.' : ''} Pass known candidate paths in files when available; read only missing implementation ranges afterwards.${hasLsp ? ' For references, pass the returned declaration coordinates to native lsp; for definition/hover use an exact surviving call/import/extends position.' : hasRefs ? ' For semantic references of a unique .ts declaration, pass its returned path and name to nav_find_references.' : ''}`
      },
    })
  })
  const baseDescription = 'Locate 1–8 named TS/JS declarations (functions, classes, interfaces, types, enums, variables, methods) across the workspace or in specified files, returning exact path, 1-based line:character, kind, enclosing container, per-name match counts, and a 240-char declaration preview instead of grepping or reading files to find declarations.'
  const tool = defineTool({
    name: 'nav_find_declarations',
    description: baseDescription,
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: '1–8 exact identifiers, not regexes. Batch related names within known files; without files prefer a small distinctive anchor because candidate files are the union of all text matches.' },
      files: { type: 'array', items: { type: 'string' }, description: '1–20 confirmed workspace-relative .ts/.tsx/.js/.jsx files, never an empty array. Reuse paths from grep/glob or prior search results. Omit only when paths are unknown; automatic discovery also has a hard 20-file limit. Overflow requires confirmed files, not the same unscoped retry.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          filesScanned: { type: 'integer', required: true },
          scanComplete: { type: 'boolean', required: true },
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
          nameResults: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                observed: { type: 'integer', required: true },
                shown: { type: 'integer', required: true },
                completeness: { type: 'string', enum: ['complete', 'partial', 'unscanned'], required: true },
                incompleteReasons: { type: 'array', items: { type: 'string' }, required: true },
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
          `${args.files === undefined ? 'Host grep discovered candidates in the Session workspace' : 'Used provided candidate files'}; scanned ${value.filesScanned}, skipped ${value.skipped.length}; AST scan ${value.scanComplete ? 'complete' : 'incomplete'}; showing ${value.declarations.length} declaration(s)${value.truncated ? ' (some results omitted or scanning incomplete; see per-name status)' : ''}.`,
          value.scanComplete
            ? 'Totals include matches omitted from display. Use these exact counts for supported named declarations in the scanned candidate files; no source read is needed just to count them or confirm a zero total. Counts do not establish workspace-wide absence, semantic binding or uniqueness.'
            : 'Scan incomplete: observed counts only the visited AST matches, not an exhaustive total. Recovery/scan gaps and skipped files may affect every name; zero does not establish absence. Read only a remaining requested source fact.',
          ...value.nameResults.map(item => `${item.name}: ${value.scanComplete ? 'total' : 'observed'}=${item.observed}; shown=${item.shown}; ${item.completeness}${value.scanComplete && item.observed === 0 ? '; no supported named declaration in these candidate files' : ''}${item.incompleteReasons.length ? `; ${item.incompleteReasons.join('; ')}` : ''}.`),
          ...value.declarations.map(item => `${item.name} — ${item.path}:${item.line}:${item.character} ${item.kind}${item.container ? ` in ${item.container}` : ''}\n  ${item.sourceLine}`),
          ...value.skipped.map(item => `Skipped ${item.path}: ${item.reason}`),
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return findDeclarations(ctx.fs, ctx.tools, _args, exec)
    },
  })
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: () => {
      const has = (name: string) => ctx.tools.get(name) !== undefined
      const hasContext = has('nav_search_context')
      const hasLsp = has('lsp')
      const hasRefs = has('nav_find_references')
      const lspNote = hasLsp
        ? 'For uses, pass selected declaration coordinates unchanged to native lsp findReferences; for definition/hover use an exact surviving call/import/extends symbol position, not a fragment start.'
        : hasRefs
          ? 'For semantic uses of a unique .ts declaration, pass its path and name to nav_find_references.'
          : ''
      return [
        baseDescription,
        `Pass known .ts/.tsx/.js/.jsx paths in files (from ${hasContext ? 'glob/grep/nav_search_context' : 'glob/grep'}), especially for common names like get or run. When files is omitted, literal grep auto-discovers up to 20 candidate files; if more than 20 files match, the error returns bounded candidate path clues—select relevant paths and retry with explicit files. Read only missing body ranges afterwards.`,
        lspNote,
        'Supports direct identifier declarations (not destructured bindings), up to 30 displayed results round-robin across names, and reports scanComplete plus per-name observed/shown/completeness in the output.',
      ].filter(Boolean).join(' ')
    },
  })
  ctx.tools.register(tool)
}

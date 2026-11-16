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
        return `Use nav_find_declarations when exact known-name TS/JS declaration identity, kind, count or coordinates are missing. Its result replaces reading${hasBash ? ' or shell-grepping' : ''} candidate files just to locate declarations; read only missing implementation/signature context.${hasLsp ? ' For references, pass the returned declaration coordinates to native lsp; for definition/hover use an exact surviving call/import/extends position.' : hasRefs ? ' For semantic references of a unique .ts declaration, pass its returned path and name to nav_find_references.' : ''}`
      },
    })
  })
  const baseDescription = 'Replace ordinary read of candidate TS/JS files when exact named declaration identity, kind, count, container or coordinates are needed. Returns those facts directly; answer from them when sufficient, rather than reading files or querying already-read declarations for confirmation.'
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
        `Supply files already found by ${hasContext ? 'grep/glob/context search' : 'grep/glob'}; common names such as run or String should use explicit files. Without files, literal grep discovers at most 20 candidate files, including references and imports; batching names expands their union and may exceed that limit. On overflow no files are parsed: confirm relevant paths from the bounded candidate clues and retry with the same names and explicit files only if identity or coordinates are still needed. Never repeat the unchanged unscoped query. Returns path, kind, container and a first-line preview capped at 240 characters, not a full signature or inferred type. Read only missing implementation/signature ranges. Select same-name declarations by path/container.`,
        lspNote,
        'Supports direct identifier names on functions, classes, interfaces, types, enums, variables and methods, not destructured bindings. Returns at most 30 declarations, shared round-robin across names with observed candidates. Check each nameResults entry: shown is the displayed count; complete means all supported declarations for that name in this candidate-file scope are displayed, partial means candidates were omitted or scanning was incomplete, and unscanned means no AST files were scanned. Skipped files, syntax recovery and AST scan limits prevent complete status. scanComplete reports whether all candidate-file AST scans finished without skipped files, syntax recovery or scan limits; output omission alone does not make it false. Each name has observed, the number of supported AST matches visited including matches omitted from the 30 displayed results. When scanComplete is true this is the exact total in these candidate files: reuse it for count and supported-name absence questions, even if that name is partial only because of display omission. Otherwise observed is only the visited AST matches, not an exhaustive total. Counts never prove workspace-wide absence, semantic binding or uniqueness.',
      ].filter(Boolean).join(' ')
    },
  })
  ctx.tools.register(tool)
}

import ts from 'typescript'

export interface ContextRange { start: number; end: number; name: string }

// Syntax boundaries only: no symbol resolution or inferred dependency edges.
export function contextDeclarations(path: string, source: string): ContextRange[] {
  const kind = /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX
    : /\.js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  // Malformed source keeps the lexical fallback rather than trusting recovered boundaries.
  if ((file as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) return []
  const ranges: ContextRange[] = []
  function visit(node: ts.Node): void {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body) {
      const start = file.getLineAndCharacterOfPosition(node.getFullStart()).line
      const end = file.getLineAndCharacterOfPosition(Math.max(node.getStart(file), node.end - 1)).line
      if (end - start < 80) ranges.push({ start, end, name: node.name?.getText(file) ?? '' })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return ranges
}

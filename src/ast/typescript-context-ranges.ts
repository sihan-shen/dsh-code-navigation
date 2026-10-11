import ts from 'typescript'

export interface ContextRange { start: number; end: number; matchStart: number; name: string }

// Syntax boundaries only: no symbol resolution or inferred dependency edges.
export function contextDeclarations(path: string, source: string,
  onFallback?: (reason: string) => void): ContextRange[] {
  const kind = /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX
    : /\.js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  // Malformed source keeps the lexical fallback rather than trusting recovered boundaries.
  if ((file as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) {
    onFallback?.('syntax diagnostics; using lexical windows instead of recovered declaration boundaries')
    return []
  }
  const ranges: ContextRange[] = []
  function callable(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return callable(node.expression)
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
  }
  function visit(node: ts.Node): void {
    // A named variable can own a direct callable or an immediate factory callback.
    // Keep the whole binding, including the factory arguments and closing syntax.
    const binding = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (callable(node.initializer) || (ts.isCallExpression(node.initializer)
        && node.initializer.arguments.some(callable))) ? node : undefined
    if (((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body) || binding) {
      const statement = binding && ts.isVariableDeclarationList(binding.parent)
        && binding.parent.declarations.length === 1 && ts.isVariableStatement(binding.parent.parent)
        ? binding.parent.parent : undefined
      // Multi-binding statements have no independent full-line boundary.
      if (binding && !statement) { ts.forEachChild(node, visit); return }
      const boundary = statement ?? node
      const matchStart = file.getLineAndCharacterOfPosition(boundary.getStart(file)).line
      const fullStart = boundary.getFullStart()
      let start = file.getLineAndCharacterOfPosition(fullStart).line
      // Leading trivia may begin after another statement on the same line.
      if (source.slice(file.getLineStarts()[start], fullStart).trim()) start = Math.min(start + 1, matchStart)
      const end = file.getLineAndCharacterOfPosition(Math.max(boundary.getStart(file), boundary.end - 1)).line
      const name = binding?.name ?? (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node.name : undefined)
      if (end - start < 80) ranges.push({ start, end, matchStart, name: name?.getText(file) ?? '' })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return ranges
}

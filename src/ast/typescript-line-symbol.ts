import ts from 'typescript'

/** Exact identifier occurrences on one visible line; no text/comment matching. */
export function lineSymbolCandidates(file: ts.SourceFile, line: number, symbol: string) {
  const candidates: { line: number; character: number; name: string }[] = []
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === symbol) {
      const at = file.getLineAndCharacterOfPosition(node.getStart(file))
      if (at.line + 1 === line) candidates.push({ line, character: at.character + 1, name: symbol })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { count: candidates.length, candidates: candidates.slice(0, 4) }
}

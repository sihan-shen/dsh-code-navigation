import ts from 'typescript'

/** Select nearby lines and short import/export statements; this does not classify references. */
export function referenceContextLines(
  path: string, source: string, positions: readonly { line: number; character: number }[],
): number[] {
  const lines = source.split(/\r\n|\n|\r/)
  const needed = new Set<number>()
  for (const { line } of positions) {
    for (let i = Math.max(0, line - 1); i <= Math.min(lines.length - 1, line + 1); i++) needed.add(i)
  }
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false,
    /\.[jt]sx$/i.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const offsets = positions.map(p => file.getPositionOfLineAndCharacter(p.line, p.character))
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)
      && !ts.isImportEqualsDeclaration(statement)) continue
    const start = statement.getStart(file), end = statement.getEnd()
    if (!offsets.some(offset => offset >= start && offset < end)) continue
    const first = file.getLineAndCharacterOfPosition(start).line
    const last = file.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line
    if (last - first + 1 > 12) continue
    for (let i = first; i <= last; i++) needed.add(i)
  }
  return [...needed].sort((a, b) => a - b)
}

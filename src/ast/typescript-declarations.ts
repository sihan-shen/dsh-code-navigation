import ts from 'typescript'

export interface Declaration {
  name: string
  path: string
  line: number
  character: number
  kind: string
  container: string
  sourceLine: string
}

function scriptKind(path: string): ts.ScriptKind {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (lower.endsWith('.js')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function declarationKind(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isVariableDeclaration(node)) return 'variable'
  if (ts.isMethodDeclaration(node)) return 'method'
  return undefined
}

function declarationName(node: ts.Node): ts.Identifier | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node)
    || ts.isMethodDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name : undefined
  }
  return undefined
}

export function extractDeclarations(path: string, source: string, names: ReadonlySet<string>, limit: number): Declaration[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path))
  const lineStarts = file.getLineStarts()
  const found: Declaration[] = []

  function visit(node: ts.Node, containers: string[]): void {
    if (found.length >= limit) return
    const identifier = declarationName(node)
    const kind = declarationKind(node)
    if (identifier !== undefined && names.has(identifier.text) && kind !== undefined) {
      const position = file.getLineAndCharacterOfPosition(identifier.getStart(file))
      const line = position.line + 1
      found.push({
        name: identifier.text,
        path,
        line,
        character: position.character + 1,
        kind,
        container: containers.join('.'),
        sourceLine: source.slice(lineStarts[position.line], lineStarts[position.line + 1] ?? source.length).trim().slice(0, 240),
      })
    }
    const next = identifier && (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      ? [...containers, identifier.text] : containers
    ts.forEachChild(node, child => visit(child, next))
  }

  visit(file, [])
  return found
}

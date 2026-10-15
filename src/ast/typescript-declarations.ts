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

export interface DeclarationNode {
  id: string
  parentId: string
  name: string
  kind: string
  line: number
  character: number
  startLine: number
  endLine: number
}

/** 单文件的命名声明包含关系；不解析绑定，也不推断调用关系。 */
export function extractDeclarationTree(path: string, source: string): {
  declarations: DeclarationNode[]; syntaxError: boolean
} {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path))
  const syntaxError = !!(file as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length
  if (syntaxError) return { declarations: [], syntaxError }
  const declarations: DeclarationNode[] = []
  function visit(node: ts.Node, parentId: string): void {
    const identifier = declarationName(node), kind = declarationKind(node)
    let nextParent = parentId
    if (identifier && kind) {
      if (declarations.length >= 4096) throw new Error('semantic index exceeds 4096 declarations')
      const position = file.getLineAndCharacterOfPosition(identifier.getStart(file))
      const id = `${path}:${position.line + 1}:${position.character + 1}`
      declarations.push({ id, parentId, name: identifier.text, kind,
        line: position.line + 1, character: position.character + 1,
        startLine: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        endLine: file.getLineAndCharacterOfPosition(Math.max(node.getStart(file), node.end - 1)).line + 1 })
      nextParent = id
    }
    ts.forEachChild(node, child => visit(child, nextParent))
  }
  visit(file, '')
  return { declarations, syntaxError }
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

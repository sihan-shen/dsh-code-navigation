import ts from 'typescript'

export interface ContextRange {
  start: number; end: number; matchStart: number
  name: string; nameLine: number; nameCharacter: number
  kind: string; container: string
}

export interface ContextDeclarationInfo {
  name: string; line: number; character: number; kind: string; container: string
}

export interface ContextAstScan {
  ranges: ContextRange[]
  declarations: ContextDeclarationInfo[]
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function declarationNameInfo(file: ts.SourceFile, node: ts.Node): { name: string; kind: string; idNode: ts.Node } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name.getText(file), kind: 'function', idNode: node.name }
  if (ts.isMethodDeclaration(node) && node.name) return { name: node.name.getText(file), kind: 'method', idNode: node.name }
  if (ts.isClassDeclaration(node) && node.name) return { name: node.name.getText(file), kind: 'class', idNode: node.name }
  if (ts.isInterfaceDeclaration(node)) return { name: node.name.getText(file), kind: 'interface', idNode: node.name }
  if (ts.isTypeAliasDeclaration(node)) return { name: node.name.getText(file), kind: 'type', idNode: node.name }
  if (ts.isEnumDeclaration(node)) return { name: node.name.getText(file), kind: 'enum', idNode: node.name }
  if (ts.isPropertyDeclaration(node) && node.name) return { name: node.name.getText(file), kind: 'property', idNode: node.name }
  if (ts.isGetAccessorDeclaration(node) && node.name) return { name: node.name.getText(file), kind: 'getter', idNode: node.name }
  if (ts.isSetAccessorDeclaration(node) && node.name) return { name: node.name.getText(file), kind: 'setter', idNode: node.name }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return { name: node.name.getText(file), kind: 'variable', idNode: node.name }
  return undefined
}

// Syntax boundaries only: no symbol resolution or inferred dependency edges.
export function scanContextAst(path: string, source: string,
  onFallback?: (reason: string) => void): ContextAstScan {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFor(path))
  // Malformed source keeps the lexical fallback rather than trusting recovered boundaries.
  if ((file as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) {
    onFallback?.('syntax diagnostics; using lexical windows instead of recovered declaration boundaries')
    return { ranges: [], declarations: [] }
  }
  const ranges: ContextRange[] = []
  const declarations: ContextDeclarationInfo[] = []
  function callable(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return callable(node.expression)
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
  }
  function visit(node: ts.Node, container: string): void {
    const info = declarationNameInfo(file, node)
    let nextContainer = container
    if (info) {
      const pos = file.getLineAndCharacterOfPosition(info.idNode.getStart(file))
      declarations.push({
        name: info.name,
        line: pos.line + 1,
        character: pos.character + 1,
        kind: info.kind,
        container,
      })
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
        nextContainer = info.name
      }
    }
    // A named variable can own a direct callable or an immediate factory callback.
    // Keep the whole binding, including the factory arguments and closing syntax.
    const binding = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (callable(node.initializer) || (ts.isCallExpression(node.initializer)
        && node.initializer.arguments.some(callable))) ? node : undefined
    const isExpandableBlock = ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body)
      || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || binding
    if (isExpandableBlock) {
      const statement = binding && ts.isVariableDeclarationList(binding.parent)
        && binding.parent.declarations.length === 1 && ts.isVariableStatement(binding.parent.parent)
        ? binding.parent.parent : undefined
      // Multi-binding statements have no independent full-line boundary.
      if (binding && !statement) { ts.forEachChild(node, child => visit(child, nextContainer)); return }
      const boundary = statement ?? node
      const matchStart = file.getLineAndCharacterOfPosition(boundary.getStart(file)).line
      const fullStart = boundary.getFullStart()
      let start = file.getLineAndCharacterOfPosition(fullStart).line
      // Leading trivia may begin after another statement on the same line.
      if (source.slice(file.getLineStarts()[start], fullStart).trim()) start = Math.min(start + 1, matchStart)
      const end = file.getLineAndCharacterOfPosition(Math.max(boundary.getStart(file), boundary.end - 1)).line
      const nameNode = binding?.name ?? info?.idNode
      const namePosition = nameNode ? file.getLineAndCharacterOfPosition(nameNode.getStart(file)) : undefined
      if (end - start < 160) ranges.push({
        start, end, matchStart,
        name: info?.name ?? nameNode?.getText(file) ?? '',
        nameLine: namePosition?.line ?? matchStart,
        nameCharacter: namePosition ? namePosition.character + 1 : 1,
        kind: info?.kind ?? 'declaration',
        container,
      })
    }
    ts.forEachChild(node, child => visit(child, nextContainer))
  }
  visit(file, '')
  return { ranges, declarations }
}

export function contextDeclarations(path: string, source: string,
  onFallback?: (reason: string) => void): ContextRange[] {
  return scanContextAst(path, source, onFallback).ranges
}

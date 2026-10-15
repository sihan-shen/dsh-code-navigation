import ts from 'typescript'
import { extractDeclarationTree } from './typescript-declarations.js'

export interface ReferenceSite {
  line: number
  character: number
  endCharacter: number
  role: 'callee' | 'argument' | 'other'
  containerId: string
}

/** 只分类精确标识符的语法位置；绑定来自宿主 findReferences，callee 不代表执行。 */
export function referenceSites(path: string, source: string): Map<string, ReferenceSite> {
  const result = new Map<string, ReferenceSite>()
  const tree = extractDeclarationTree(path, source)
  if (tree.syntaxError) return result
  const declarations = new Set(tree.declarations.map(node => node.id))
  const kind = /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX
    : /\.js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  const idAt = (node: ts.Node): string => {
    const p = file.getLineAndCharacterOfPosition(node.getStart(file))
    return `${path}:${p.line + 1}:${p.character + 1}`
  }
  function visit(node: ts.Node, containerId: string): void {
    const name = (node as ts.NamedDeclaration).name
    const nextContainer = name && ts.isIdentifier(name) && declarations.has(idAt(name)) ? idAt(name) : containerId
    if (ts.isIdentifier(node) && !declarations.has(idAt(node))) {
      const parent = node.parent
      const declarationName = (parent as ts.NamedDeclaration).name === node
        && (ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isPropertyDeclaration(parent)
          || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isEnumMember(parent)
          || ts.isPropertyAssignment(parent) || ts.isImportClause(parent) || ts.isImportSpecifier(parent)
          || ts.isNamespaceImport(parent) || ts.isFunctionExpression(parent) || ts.isClassExpression(parent))
      if (!declarationName && !ts.isImportSpecifier(parent) && !ts.isImportClause(parent) && !ts.isNamespaceImport(parent)) {
        let expression: ts.Node = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node
        while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent
        const owner = expression.parent
        const role = (ts.isCallExpression(owner) || ts.isNewExpression(owner)) && owner.expression === expression ? 'callee'
          : (ts.isCallExpression(owner) || ts.isNewExpression(owner)) && owner.arguments?.some(arg => arg === expression) ? 'argument' : 'other'
        const start = file.getLineAndCharacterOfPosition(node.getStart(file)), end = file.getLineAndCharacterOfPosition(node.end)
        if (start.line === end.line) result.set(`${start.line + 1}:${start.character + 1}`, {
          line: start.line + 1, character: start.character + 1, endCharacter: end.character + 1, role, containerId,
        })
      }
    }
    ts.forEachChild(node, child => visit(child, nextContainer))
  }
  visit(file, '')
  return result
}

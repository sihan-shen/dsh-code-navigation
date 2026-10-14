import ts from 'typescript'

export const CONTINUATION_SELECTORS = ['new_in_callback', 'returned_this_call', 'constructor_assignment_call', 'bare_call_in_array_initializer'] as const
export type ContinuationSelector = typeof CONTINUATION_SELECTORS[number]
export interface SyntaxCall { line: number; character: number; name: string }
export interface Selection { bodyKey: string; supported: boolean; count: number; candidates: SyntaxCall[] }

export function parseDefinitionSource(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}
function exactNode(file: ts.SourceFile, line: number, character: number): ts.Node | undefined {
  const position = file.getPositionOfLineAndCharacter(line - 1, character - 1)
  let selected: ts.Node | undefined
  function visit(node: ts.Node): void {
    if (position < node.getStart(file) || position >= node.end) return
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && node.name.getStart(file) === position) selected = node
    if (ts.isConstructorDeclaration(node) && node.getStart(file) === position) selected = node
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.getStart(file) === position
      && (ts.isPropertyDeclaration(node.parent) || ts.isVariableDeclaration(node.parent))
      && node.parent.initializer === node) selected = node.parent
    ts.forEachChild(node, visit)
  }
  visit(file)
  return selected
}
export function definitionIdentity(file: ts.SourceFile, line: number, character: number) {
  const node = exactNode(file, line, character)
  if (!node) return undefined
  const name = ts.isConstructorDeclaration(node) ? 'constructor' : 'name' in node && node.name ? (node.name as ts.Node).getText(file) : ''
  let kind = ts.isClassDeclaration(node) || ts.isClassExpression(node) ? 'class' : ts.isConstructorDeclaration(node) ? 'constructor'
    : ts.isFunctionDeclaration(node) ? 'function' : ts.isMethodDeclaration(node) ? 'method' : ts.isPropertyDeclaration(node) ? 'property' : 'variable'
  if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.initializer && ts.isArrowFunction(node.initializer)) kind = ts.isPropertyDeclaration(node) ? 'arrow-property' : 'arrow-variable'
  const at = file.getLineAndCharacterOfPosition(node.getStart(file))
  const containers: string[] = []
  for (let p = node.parent; p; p = p.parent) if ((ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name) containers.unshift(p.name.text)
  return { name, kind, container: containers.join('.'), line: at.line + 1, character: at.character + 1 }
}
function unparen(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression
  return node
}
function callable(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body) return node
  if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.initializer) {
    const init = unparen(node.initializer)
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init
  }
  return undefined
}
// Traverse one lexical body; enter a callback only when a selector explicitly asks.
function ownBody(node: ts.Node, visit: (node: ts.Node) => void): void {
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
  visit(node)
  ts.forEachChild(node, child => ownBody(child, visit))
}
export function selectContinuation(file: ts.SourceFile, line: number, character: number, selector: ContinuationSelector): Selection {
  const selected = exactNode(file, line, character)
  let owner = selected && callable(selected)
  if (selected && (ts.isClassDeclaration(selected) || ts.isClassExpression(selected))) {
    const constructors = selected.members.filter(ts.isConstructorDeclaration).filter(n => n.body)
    if (constructors.length === 1) owner = constructors[0]
  }
  if (!owner?.body || selector === 'constructor_assignment_call' && !ts.isConstructorDeclaration(owner)) return { bodyKey: '', supported: false, count: 0, candidates: [] }
  const matches = new Map<number, SyntaxCall>()
  function add(expression: ts.Expression): void {
    expression = unparen(expression)
    const token = ts.isIdentifier(expression) ? expression : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name) ? expression.name : undefined
    if (!token || matches.has(token.getStart(file))) return
    const at = file.getLineAndCharacterOfPosition(token.getStart(file))
    matches.set(token.getStart(file), { line: at.line + 1, character: at.character + 1, name: token.text })
  }
  ownBody(owner.body, node => {
    if (selector === 'returned_this_call' && ts.isReturnStatement(node) && node.expression) {
      const expression = unparen(node.expression)
      if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
        && expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword) add(expression.expression)
    }
    if (selector === 'constructor_assignment_call' && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const right = unparen(node.right)
      if (ts.isCallExpression(right)) add(right.expression)
    }
    if (selector === 'bare_call_in_array_initializer' && ts.isVariableDeclaration(node) && node.initializer) {
      const init = unparen(node.initializer)
      if (ts.isArrayLiteralExpression(init)) for (const element of init.elements) {
        if (ts.isCallExpression(element) && ts.isIdentifier(element.expression)) add(element.expression)
      }
    }
    if (selector === 'new_in_callback' && ts.isCallExpression(node)) for (const argument of node.arguments) {
      const arg = unparen(argument)
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) ownBody(arg.body, child => { if (ts.isNewExpression(child)) add(child.expression) })
    }
  })
  return { bodyKey: `${owner.getStart(file)}:${owner.end}`, supported: true, count: matches.size, candidates: [...matches.values()].slice(0, 4) }
}

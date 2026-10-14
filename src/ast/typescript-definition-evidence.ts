import ts from 'typescript'

export interface DefinitionCursorEvidence {
  sourceSymbol: string
  sourceRole: 'declaration' | 'reference' | 'unknown'
}

// Describe the actual token under the cursor; do not resolve names or move the cursor.
export function definitionCursorEvidence(path: string, source: string, line: number, character: number): DefinitionCursorEvidence {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const position = file.getPositionOfLineAndCharacter(line - 1, character - 1)
  let identifier: ts.Identifier | undefined
  function visit(node: ts.Node): void {
    if (position < node.getStart(file) || position >= node.end) return
    if (ts.isIdentifier(node)) identifier = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!identifier) return { sourceSymbol: '', sourceRole: 'unknown' }
  const parent = identifier.parent
  const named = 'name' in parent && parent.name === identifier
  const declaration = named && (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)
    || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
    || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent)
    || ts.isTypeAliasDeclaration(parent) || ts.isTypeParameterDeclaration(parent)
    || ts.isEnumDeclaration(parent) || ts.isEnumMember(parent) || ts.isModuleDeclaration(parent)
    || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)
    || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent))
  // Object keys and labels are not established reference positions. Import identifiers
  // remain navigation inputs: resolving an alias can legitimately lead to another file.
  const unknown = named && (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent))
    || 'label' in parent && parent.label === identifier
  return { sourceSymbol: identifier.text, sourceRole: declaration ? 'declaration' : unknown ? 'unknown' : 'reference' }
}

export interface DefinitionSyntaxEvidence {
  name: string
  kind: string
  container: string
  rows: number[]
  notes: string[]
}

// Exact syntax coordinates only: do not classify a use-site or infer a semantic target.
export function definitionSyntaxEvidence(path: string, source: string, line: number, character: number): DefinitionSyntaxEvidence | undefined {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const position = file.getPositionOfLineAndCharacter(line - 1, character - 1)
  let selected: ts.Node | undefined
  function visit(node: ts.Node): void {
    if (position < node.getFullStart() || position >= node.end) return
    if (ts.isConstructorDeclaration(node) && node.getStart(file) === position) selected = node
    else if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)
      || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))
      && ts.isIdentifier(node.name) && node.name.getStart(file) === position) selected = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!selected) return undefined
  const node = selected as ts.ConstructorDeclaration | ts.MethodDeclaration | ts.MethodSignature | ts.PropertyDeclaration | ts.PropertySignature
  const kind = ts.isConstructorDeclaration(node) ? 'constructor'
    : ts.isMethodSignature(node) ? 'method-signature'
      : ts.isPropertySignature(node) ? 'property-signature'
        : ts.isPropertyDeclaration(node) ? 'property' : 'method'
  const name = ts.isConstructorDeclaration(node) ? 'constructor' : (node.name as ts.Identifier).text
  const rows = new Set<number>(), notes: string[] = [], containers: string[] = []
  function add(first: number, last: number, label: string): void {
    const end = Math.min(last, first + 11)
    for (let n = first; n <= end; n++) rows.add(n)
    if (end < last) notes.push(`${label} clipped to 12 lines; read remaining lines ${end + 1}–${last}`)
  }
  const body = 'body' in node ? node.body : undefined
  const initializer = 'initializer' in node ? node.initializer : undefined
  const end = body?.getStart(file) ?? initializer?.getStart(file) ?? Math.max(node.getStart(file), node.end - 1)
  add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    file.getLineAndCharacterOfPosition(end).line + 1, 'Member syntax')
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent))
      && parent.name && ts.isIdentifier(parent.name)) {
      containers.unshift(parent.name.text)
      // Include the opening header, not its members or the whole container body.
      const firstMember = parent.members[0]
      const headerEnd = firstMember ? firstMember.getFullStart() : parent.end - 1
      add(file.getLineAndCharacterOfPosition(parent.getStart(file)).line + 1,
        file.getLineAndCharacterOfPosition(headerEnd).line + 1, 'Container header')
    }
  }
  return { name, kind, container: containers.join('.'), rows: [...rows].sort((a, b) => a - b), notes }
}

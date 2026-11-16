/** Literal terms are joined into one host-grep alternation; never treat them as regexes. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function literalPattern(terms: Iterable<string>, caseSensitive = true): string {
  const body = [...terms].map(escapeRegExp).join('|')
  return caseSensitive || !body ? body : `(?i)(?:${body})`
}

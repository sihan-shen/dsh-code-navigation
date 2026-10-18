/** Literal terms are joined into one host-grep alternation; never treat them as regexes. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function literalPattern(terms: Iterable<string>): string {
  return [...terms].map(escapeRegExp).join('|')
}

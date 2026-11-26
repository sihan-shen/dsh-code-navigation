/** Literal terms are joined into one host-grep alternation; never treat them as regexes. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function literalPattern(terms: Iterable<string>, caseSensitive = true): string {
  const body = [...terms].map(escapeRegExp).join('|')
  return caseSensitive || !body ? body : `(?i)(?:${body})`
}

export type ParsedTermKind = 'literal' | 'cooccurrence' | 'regex'

export interface ParsedSearchTerm {
  raw: string
  kind: ParsedTermKind
  /** For 'literal': exact literal string. For 'cooccurrence': ordered segments. For 'regex': regex source. */
  literal?: string
  segments?: string[]
  /** Ripgrep sub-pattern (without case flag). */
  rgSubpattern: string
  /** Optional JS RegExp for line matching and 1-based anchor column lookup. */
  jsRegex?: RegExp
  /** Human-readable note when a grep-style input was unescaped or interpreted. */
  interpretation?: string
}

const REGEX_BACKSLASH = /\\(?:[dDwWsSbBnrtef0]|p\{|P\{|k<)/
const CHAR_CLASS = /(?<!\\)\[(?:\^|[^\]]*-[^\]]|[^\]]{2,})\]/
const GROUP_QUANTIFIER = /(?<!\\)[)\]][*+?]|(?<!\\)\{\d+(?:,\d*)?\}/
const INLINE_FLAG_OR_GROUP_ALT = /(?<!\\)\(\?[imsx-]+[:)]|(?<!\\)\([^()]*\|[^()]*\)/
const DOT_PLUS = /(?<!\\)\.\+/
const UNESCAPED_DOT_STAR = /(?<!\\)\.\*/
const ESCAPED_META_PAIRS = /\\[.*+?^${}()|[\]\\'"]/g
const HAS_ESCAPED_META = /\\[.*+?^${}()|[\]\\]/

function hasUnescapedDotStar(value: string): boolean {
  for (let i = 0; i < value.length - 1; i++) {
    if (value[i] === '\\') { i++; continue }
    if (value[i] === '.' && value[i + 1] === '*') return true
  }
  return false
}

function splitUnescapedDotStar(value: string): string[] {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      current += value[i] + value[i + 1]
      i++
      continue
    }
    if (value[i] === '.' && value[i + 1] === '*') {
      parts.push(current)
      current = ''
      i++
      continue
    }
    current += value[i]
  }
  parts.push(current)
  return parts
}

function unescapeLiteralMetas(value: string): string {
  return value.replace(ESCAPED_META_PAIRS, match => match[1])
}

function compileJsRegex(pattern: string, caseSensitive: boolean): RegExp | undefined {
  const flags = caseSensitive ? 'u' : 'iu'
  try {
    return new RegExp(pattern, flags)
  } catch {
    try {
      return new RegExp(pattern, caseSensitive ? '' : 'i')
    } catch {
      return undefined
    }
  }
}

function isUnmistakableRegex(value: string): boolean {
  if (REGEX_BACKSLASH.test(value)) return true
  if (CHAR_CLASS.test(value)) return true
  if (GROUP_QUANTIFIER.test(value)) return true
  if (INLINE_FLAG_OR_GROUP_ALT.test(value)) return true
  if (DOT_PLUS.test(value)) return true
  if (value.startsWith('^') && value.length > 1 && !/^\^\s/.test(value)) return true
  return false
}

/**
 * Split a raw term string on top-level unescaped `|` characters (outside `(...)` and `[...]`).
 * Allows `"hsl\\(|setStyle"` to split while keeping `"U_.*(A|B)"` intact.
 */
export function splitTopLevelAlternation(raw: string): string[] {
  const parts: string[] = []
  let current = ''
  let parenDepth = 0
  let inBracket = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && i + 1 < raw.length) {
      current += ch + raw[i + 1]
      i++
      continue
    }
    if (ch === '[' && !inBracket) {
      inBracket = true
      current += ch
      continue
    }
    if (ch === ']' && inBracket) {
      inBracket = false
      current += ch
      continue
    }
    if (!inBracket) {
      if (ch === '(') parenDepth++
      else if (ch === ')' && parenDepth > 0) parenDepth--
      else if (ch === '|' && parenDepth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += ch
  }
  parts.push(current)
  return parts.length > 1 ? parts.map(p => p.trim()).filter(Boolean) : [raw]
}

export function parseSearchTerm(raw: string, caseSensitive: boolean): ParsedSearchTerm {
  if (isUnmistakableRegex(raw)) {
    return {
      raw,
      kind: 'regex',
      rgSubpattern: `(?:${raw})`,
      jsRegex: compileJsRegex(raw, caseSensitive),
      interpretation: `"${raw}" executed as regex`,
    }
  }
  if (hasUnescapedDotStar(raw)) {
    const rawParts = splitUnescapedDotStar(raw)
    if (rawParts.length >= 2 && rawParts.every(part => part.length > 0)) {
      const segments = rawParts.map(part => HAS_ESCAPED_META.test(part) ? unescapeLiteralMetas(part) : part)
      return {
        raw,
        kind: 'cooccurrence',
        segments,
        rgSubpattern: segments.map(escapeRegExp).join('.*'),
        interpretation: `"${raw}" interpreted as same-line ordered co-occurrence (${segments.map(s => JSON.stringify(s)).join(' ... ')})`,
      }
    }
    return {
      raw,
      kind: 'regex',
      rgSubpattern: `(?:${raw})`,
      jsRegex: compileJsRegex(raw, caseSensitive),
      interpretation: `"${raw}" executed as regex`,
    }
  }
  if (HAS_ESCAPED_META.test(raw)) {
    const unescaped = unescapeLiteralMetas(raw)
    return {
      raw,
      kind: 'literal',
      literal: unescaped,
      rgSubpattern: escapeRegExp(unescaped),
      interpretation: unescaped !== raw ? `"${raw}" unescaped to literal "${unescaped}"` : undefined,
    }
  }
  return {
    raw,
    kind: 'literal',
    literal: raw,
    rgSubpattern: escapeRegExp(raw),
  }
}

export function parseExplicitRegexPattern(pattern: string, caseSensitive: boolean): ParsedSearchTerm {
  return {
    raw: pattern,
    kind: 'regex',
    rgSubpattern: `(?:${pattern})`,
    jsRegex: compileJsRegex(pattern, caseSensitive),
    interpretation: `pattern ${JSON.stringify(pattern)} executed via ripgrep regex`,
  }
}

export function buildSearchPattern(terms: readonly ParsedSearchTerm[], caseSensitive: boolean): string {
  const body = terms.map(term => term.rgSubpattern).join('|')
  return caseSensitive || !body ? body : `(?i)(?:${body})`
}

export function validateIncludeGlob(include: string): string {
  const trimmed = include.trim()
  if (trimmed.length === 0) throw new Error('include must be a non-empty glob when given')
  if (trimmed.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!...") are not supported')
  let braceDepth = 0
  for (const ch of trimmed) {
    if (ch === '{') braceDepth++
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (ch === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
  return trimmed
}

export function findParsedTermIndex(haystack: string, term: ParsedSearchTerm, caseSensitive: boolean): number {
  if (term.kind === 'literal') {
    const needle = term.literal ?? term.raw
    return caseSensitive ? haystack.indexOf(needle) : haystack.toLowerCase().indexOf(needle.toLowerCase())
  }
  if (term.kind === 'cooccurrence' && term.segments?.length) {
    const source = caseSensitive ? haystack : haystack.toLowerCase()
    let cursor = 0
    let firstIdx = -1
    for (const seg of term.segments) {
      const needle = caseSensitive ? seg : seg.toLowerCase()
      const idx = source.indexOf(needle, cursor)
      if (idx < 0) return -1
      if (firstIdx < 0) firstIdx = idx
      cursor = idx + needle.length
    }
    return firstIdx
  }
  if (term.jsRegex) {
    const match = term.jsRegex.exec(haystack)
    return match ? match.index : -1
  }
  // Rust-specific regex syntax not supported by JS RegExp; ripgrep already verified the line.
  return -1
}

export function hasParsedTerm(haystack: string, term: ParsedSearchTerm, caseSensitive: boolean, trustedFromRipgrep = false): boolean {
  if (term.kind === 'regex' && !term.jsRegex) return trustedFromRipgrep
  return findParsedTermIndex(haystack, term, caseSensitive) >= 0
}

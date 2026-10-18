/** Shared workspace-relative path guard; callers keep their own extension/budget rules. */
export function isWorkspaceRelativePath(value: string, extensions?: RegExp): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  if (value.includes('\\') || value.includes('\0') || value.includes('\r') || value.includes('\n')) return false
  if (value === '..' || value.startsWith('../') || value.includes('/../') || value.endsWith('/..')) return false
  return extensions === undefined || extensions.test(value)
}

export function normalizeWorkspacePath(value: string): string {
  return value.split('/').filter(part => part && part !== '.').join('/') || '.'
}

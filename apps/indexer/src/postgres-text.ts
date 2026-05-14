export function sanitizeTokenMetadata(value: unknown, fallback: string, maxLength: number): string {
  const sanitized = String(value ?? '')
    // PostgreSQL text/varchar cannot store U+0000. Some token contracts return
    // padded or malformed metadata containing NUL bytes, which can otherwise
    // freeze the sequential indexer on that block forever.
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength)

  return sanitized.length > 0 ? sanitized : fallback
}

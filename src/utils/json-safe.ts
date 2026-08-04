/** Strip control bytes / lone surrogates so JSON responses never break mid-stream. */
export function jsonSafeString(raw: unknown, maxLen = 2000): string | null {
  if (raw == null) return null;
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\uD800-\uDFFF]/g, '')
    .slice(0, maxLen);
}

export function jsonSafeRow<T extends Record<string, unknown>>(
  row: T,
  keys: Array<keyof T>,
): T {
  const out = { ...row };
  for (const key of keys) {
    const v = out[key];
    if (typeof v === 'string' || Buffer.isBuffer(v)) {
      out[key] = jsonSafeString(v) as T[keyof T];
    }
  }
  return out;
}

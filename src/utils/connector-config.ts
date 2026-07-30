/**
 * Helpers for normalizing connector JSON values persisted from the UI.
 */

export function parseConnectorBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return fallback;
}

export function parseConnectorPort(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  return fallback;
}

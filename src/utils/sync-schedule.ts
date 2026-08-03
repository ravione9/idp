/**
 * Connector sync schedule parsing and due checks.
 *
 * Stored values:
 *   manual | null | ''     — no automatic sync
 *   every:15m | every:1h   — fixed interval (also accepts legacy 15m / 1h)
 *   0 3 * * *              — standard 5-field cron (custom time-of-day)
 */

export type SyncScheduleKind = 'manual' | 'interval' | 'cron';

export interface ParsedSyncSchedule {
  kind: SyncScheduleKind;
  /** Canonical storage value (null = manual). */
  raw: string | null;
  intervalMs?: number;
  cronExpr?: string;
}

const INTERVAL_PRESETS: Record<string, number> = {
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

const EVERY_PREFIX = /^every:(\d+)(m|h)$/i;
const LEGACY_INTERVAL = /^(\d+)(m|h)$/i;

export function parseSyncSchedule(raw: string | null | undefined): ParsedSyncSchedule {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'manual') {
    return { kind: 'manual', raw: null };
  }

  const everyMatch = trimmed.match(EVERY_PREFIX);
  if (everyMatch) {
    const ms = intervalTokenToMs(`${everyMatch[1]}${everyMatch[2]!.toLowerCase()}`);
    if (ms) return { kind: 'interval', raw: trimmed.toLowerCase(), intervalMs: ms };
  }

  const legacyMatch = trimmed.match(LEGACY_INTERVAL);
  if (legacyMatch && !trimmed.includes(' ')) {
    const token = `${legacyMatch[1]}${legacyMatch[2]!.toLowerCase()}`;
    const ms = intervalTokenToMs(token);
    if (ms) {
      return { kind: 'interval', raw: `every:${token}`, intervalMs: ms };
    }
  }

  if (INTERVAL_PRESETS[trimmed]) {
    return { kind: 'interval', raw: `every:${trimmed}`, intervalMs: INTERVAL_PRESETS[trimmed] };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    return { kind: 'cron', raw: trimmed, cronExpr: trimmed };
  }

  return { kind: 'manual', raw: null };
}

function intervalTokenToMs(token: string): number | null {
  const m = token.match(/^(\d+)(m|h)$/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === 'm') {
    if (n > 10_080) return null; // max 7 days in minutes
    return n * 60_000;
  }
  if (n > 168) return null; // max 7 days in hours
  return n * 60 * 60_000;
}

/** Build a stored schedule string from UI parts. */
export function buildSyncSchedule(
  mode: string,
  customInterval?: { value: number; unit: 'm' | 'h' },
  customCron?: string,
): string | null {
  if (!mode || mode === 'manual') return null;
  if (mode === 'custom-interval') {
    const v = customInterval?.value ?? 0;
    const unit = customInterval?.unit ?? 'm';
    if (v <= 0) throw new Error('Custom interval must be greater than zero');
    return `every:${v}${unit}`;
  }
  if (mode === 'custom-cron') {
    const cron = (customCron ?? '').trim();
    if (!cron) throw new Error('Enter a cron expression or choose Manual');
    const parsed = parseSyncSchedule(cron);
    if (parsed.kind !== 'cron') throw new Error('Cron must be five fields: minute hour day month weekday');
    return cron;
  }
  if (mode.startsWith('every:')) return mode;
  return mode;
}

export function isValidSyncSchedule(raw: string | null | undefined): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'manual') return true;
  const parsed = parseSyncSchedule(trimmed);
  if (parsed.kind === 'manual' && trimmed) return false;
  return parsed.kind !== 'manual';
}

export function formatSyncScheduleLabel(raw: string | null | undefined): string {
  const parsed = parseSyncSchedule(raw);
  if (parsed.kind === 'manual') return 'Manual';

  if (parsed.kind === 'interval' && parsed.intervalMs) {
    const mins = parsed.intervalMs / 60_000;
    if (mins % (24 * 60) === 0 && mins >= 24 * 60) return `Every ${mins / (24 * 60)} day(s)`;
    if (mins % 60 === 0 && mins >= 60) return `Every ${mins / 60} hour(s)`;
    return `Every ${mins} minute(s)`;
  }

  if (parsed.kind === 'cron' && parsed.cronExpr) {
    const parts = parsed.cronExpr.split(/\s+/);
    const [min, hour, dom, , dow] = parts;
    if (dom === '*' && hour !== '*' && min !== '*' && !hour.includes('/') && !min.includes('/')) {
      const hh = hour.padStart(2, '0');
      const mm = min.padStart(2, '0');
      const dowLabel = dow === '*' ? 'Daily' : `Weekdays (${dow})`;
      return `${dowLabel} at ${hh}:${mm} UTC`;
    }
    if (min?.startsWith('*/')) {
      const step = min.slice(2);
      return `Every ${step} minute(s) (cron)`;
    }
    if (hour?.startsWith('*/')) {
      const step = hour.slice(2);
      return `Every ${step} hour(s) (cron)`;
    }
    return parsed.cronExpr;
  }

  return 'Manual';
}

export function connectorSyncIsDue(
  raw: string | null | undefined,
  lastSyncAt: string | Date | null | undefined,
  now = new Date(),
): boolean {
  const parsed = parseSyncSchedule(raw);
  if (parsed.kind === 'manual') return false;

  const last = lastSyncAt ? new Date(lastSyncAt) : null;
  const lastMs = last && Number.isFinite(last.getTime()) ? last.getTime() : null;

  if (parsed.kind === 'interval' && parsed.intervalMs) {
    if (lastMs == null) return true;
    return now.getTime() - lastMs >= parsed.intervalMs;
  }

  if (parsed.kind === 'cron' && parsed.cronExpr) {
    if (!cronMatches(parsed.cronExpr, now)) return false;
    if (lastMs == null) return true;
    const bucketStart = new Date(now);
    bucketStart.setUTCSeconds(0, 0);
    return lastMs < bucketStart.getTime();
  }

  return false;
}

function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return (
    fieldMatches(parts[0]!, date.getUTCMinutes(), 0, 59)
    && fieldMatches(parts[1]!, date.getUTCHours(), 0, 23)
    && fieldMatches(parts[2]!, date.getUTCDate(), 1, 31)
    && fieldMatches(parts[3]!, date.getUTCMonth() + 1, 1, 12)
    && fieldMatches(parts[4]!, date.getUTCDay(), 0, 6)
  );
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  return field.split(',').some((part) => {
    const stepSplit = part.split('/');
    const base = stepSplit[0] ?? '*';
    const step = stepSplit.length > 1 ? parseInt(stepSplit[1]!, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) return false;

    let start = min;
    let end = max;
    if (base !== '*') {
      if (base.includes('-')) {
        const [a, b] = base.split('-').map((x) => parseInt(x, 10));
        if (!Number.isFinite(a!) || !Number.isFinite(b!)) return false;
        start = a!;
        end = b!;
      } else {
        const exact = parseInt(base, 10);
        if (!Number.isFinite(exact)) return false;
        start = exact;
        end = exact;
      }
    }

    for (let n = start; n <= end; n += step) {
      if (n === value) return true;
    }
    return false;
  });
}

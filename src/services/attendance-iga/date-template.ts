import type { SftpConfig } from './types.js';

export interface DateParts {
  yyyy: string;
  mm: string;
  dd: string;
}

export function getDateParts(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return { yyyy: pick('year'), mm: pick('month'), dd: pick('day') };
}

/** Local calendar date / clock in a timezone (avoids UTC weekend/cutoff bugs). */
export function nowInTimezone(timeZone = 'Asia/Kolkata'): {
  dateStr: string;
  dayOfWeek: number;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  const weekday = pick('weekday');
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateStr: `${pick('year')}-${pick('month')}-${pick('day')}`,
    dayOfWeek: dayMap[weekday] ?? 0,
    minutes: parseInt(pick('hour'), 10) * 60 + parseInt(pick('minute'), 10),
  };
}

/** Expand {YYYY-MM-DD}, {YYYYMMDD}, {DD-MM-YYYY}, {date}, etc. in a path or filename. */
export function expandDateTemplate(
  template: string,
  options?: { offsetDays?: number | undefined; timeZone?: string | undefined },
): string {
  const offsetDays = options?.offsetDays ?? 0;
  const timeZone = options?.timeZone ?? 'Asia/Kolkata';
  const shifted = new Date(Date.now() + offsetDays * 86_400_000);
  const { yyyy, mm, dd } = getDateParts(shifted, timeZone);

  return template
    .replace(/\{YYYY-MM-DD\}/gi, `${yyyy}-${mm}-${dd}`)
    .replace(/\{YYYYMMDD\}/gi, `${yyyy}${mm}${dd}`)
    .replace(/\{DD-MM-YYYY\}/gi, `${dd}-${mm}-${yyyy}`)
    .replace(/\{DD\/MM\/YYYY\}/gi, `${dd}/${mm}/${yyyy}`)
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd)
    .replace(/\{date\}/gi, `${yyyy}-${mm}-${dd}`);
}

export function resolveSftpRemotePath(config: SftpConfig, offsetDays?: number): string | null {
  const tz = config.timezone ?? 'Asia/Kolkata';
  const offset = offsetDays ?? config.dateOffsetDays ?? 0;
  const dir = config.remoteDir?.trim().replace(/\/$/, '');

  if (config.fileNameTemplate?.trim()) {
    const fileName = expandDateTemplate(config.fileNameTemplate.trim(), {
      offsetDays: offset,
      timeZone: tz,
    });
    if (fileName.startsWith('/')) return fileName;
    if (dir) return `${dir}/${fileName}`;
    return fileName;
  }

  if (config.remotePath?.trim()) {
    return expandDateTemplate(config.remotePath.trim(), { offsetDays: offset, timeZone: tz });
  }

  if (dir && config.filePattern?.trim()) {
    const pattern = expandDateTemplate(config.filePattern.trim(), { offsetDays: offset, timeZone: tz });
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return `${dir}/${pattern}`;
    }
  }

  return null;
}

export function previewSftpPaths(config: SftpConfig | null | undefined): {
  today: string | null;
  candidates: string[];
} {
  if (!config) return { today: null, candidates: [] };
  const lookback = config.lookbackDays ?? 1;
  const baseOffset = config.dateOffsetDays ?? 0;
  const candidates: string[] = [];
  for (let i = 0; i <= lookback; i++) {
    const path = resolveSftpRemotePath(config, baseOffset - i);
    if (path && !candidates.includes(path)) candidates.push(path);
  }
  return { today: candidates[0] ?? null, candidates };
}

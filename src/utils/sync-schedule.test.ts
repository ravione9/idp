import {
  buildSyncSchedule,
  connectorSyncIsDue,
  formatSyncScheduleLabel,
  parseSyncSchedule,
} from './sync-schedule.js';

describe('parseSyncSchedule', () => {
  it('treats blank as manual', () => {
    expect(parseSyncSchedule(null).kind).toBe('manual');
    expect(parseSyncSchedule('manual').kind).toBe('manual');
  });

  it('parses every: presets', () => {
    const p = parseSyncSchedule('every:15m');
    expect(p.kind).toBe('interval');
    expect(p.intervalMs).toBe(15 * 60_000);
  });

  it('normalizes legacy 1h', () => {
    const p = parseSyncSchedule('1h');
    expect(p.kind).toBe('interval');
    expect(p.raw).toBe('every:1h');
  });

  it('parses cron', () => {
    const p = parseSyncSchedule('0 3 * * *');
    expect(p.kind).toBe('cron');
    expect(p.cronExpr).toBe('0 3 * * *');
  });
});

describe('connectorSyncIsDue', () => {
  it('interval due when elapsed', () => {
    const last = new Date(Date.now() - 16 * 60_000).toISOString();
    expect(connectorSyncIsDue('every:15m', last)).toBe(true);
  });

  it('interval not due when recent', () => {
    const last = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(connectorSyncIsDue('every:15m', last)).toBe(false);
  });

  it('cron due at matching minute', () => {
    const now = new Date('2026-08-03T03:00:00.000Z');
    const last = new Date('2026-08-02T03:00:00.000Z').toISOString();
    expect(connectorSyncIsDue('0 3 * * *', last, now)).toBe(true);
  });
});

describe('formatSyncScheduleLabel', () => {
  it('labels presets', () => {
    expect(formatSyncScheduleLabel('every:15m')).toBe('Every 15 minute(s)');
    expect(formatSyncScheduleLabel('every:1h')).toBe('Every 1 hour(s)');
  });

  it('labels daily cron', () => {
    expect(formatSyncScheduleLabel('0 3 * * *')).toBe('Daily at 03:00 UTC');
  });
});

describe('buildSyncSchedule', () => {
  it('builds custom interval', () => {
    expect(buildSyncSchedule('custom-interval', { value: 45, unit: 'm' })).toBe('every:45m');
  });

  it('builds preset mode', () => {
    expect(buildSyncSchedule('every:30m')).toBe('every:30m');
  });
});

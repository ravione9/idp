import type { AttendanceIgaConfig, StagingRow, TrueinApiConfig } from './types.js';
import { getDateParts } from './date-template.js';
import { fetchAttendanceFromApi } from './fetcher.js';
import logger from '../../utils/logger.js';

/** Default field mapping for Truein daily attendance exports. */
export const TRUIN_DEFAULT_MAPPING: Record<string, string> = {
  identifier: 'emp_id',
  email: 'email',
  username: 'username',
  punchDate: 'attendance_date',
  punchTime: 'in_time',
};

function formatApiDate(date: Date, timeZone: string, format: TrueinApiConfig['dateFormat']): string {
  const { yyyy, mm, dd } = getDateParts(date, timeZone);
  switch (format) {
    case 'DD-MM-YYYY': return `${dd}-${mm}-${yyyy}`;
    case 'YYYYMMDD': return `${yyyy}${mm}${dd}`;
    default: return `${yyyy}-${mm}-${dd}`;
  }
}

function buildTrueinUrl(base: string, endpoint: string, query: Record<string, string>): string {
  const root = base.replace(/\/$/, '');
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = new URL(`${root}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v) url.searchParams.set(k, v);
  }
  return url.toString();
}

export function previewTrueinRequest(config: AttendanceIgaConfig, offsetDays = 0): {
  url: string;
  method: 'GET' | 'POST';
  date: string;
  body: Record<string, unknown>;
} {
  const tc = (config.api_config ?? {}) as TrueinApiConfig;
  const tz = tc.timezone ?? 'Asia/Kolkata';
  const date = formatApiDate(new Date(Date.now() + offsetDays * 86_400_000), tz, tc.dateFormat ?? 'YYYY-MM-DD');
  const base = (config.api_url ?? tc.baseUrl ?? '').trim();
  const endpoint = (tc.endpoint ?? '/api/attendance/daily').trim();
  const dateParam = tc.dateParam ?? 'date';
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};

  if (tc.fromDateParam && tc.toDateParam) {
    query[tc.fromDateParam] = date;
    query[tc.toDateParam] = date;
    body[tc.fromDateParam] = date;
    body[tc.toDateParam] = date;
  } else {
    query[dateParam] = date;
    body[dateParam] = date;
  }
  if (tc.siteId) {
    query['site_id'] = tc.siteId;
    body['site_id'] = tc.siteId;
  }
  if (tc.clientId) {
    query['client_id'] = tc.clientId;
    body['client_id'] = tc.clientId;
  }

  const method = tc.method ?? config.api_method ?? 'GET';
  const url = base ? buildTrueinUrl(base, endpoint, method === 'GET' ? query : {}) : endpoint;
  return { url, method, date, body: method === 'POST' ? body : {} };
}

export async function fetchAttendanceFromTruein(config: AttendanceIgaConfig): Promise<StagingRow[]> {
  const tc = (config.api_config ?? {}) as TrueinApiConfig;
  const token = String(config.api_auth_config?.['token'] ?? '').trim();
  if (!token) throw new Error('Truein API token is not configured');

  const base = (config.api_url ?? tc.baseUrl ?? '').trim();
  if (!base && !(config.api_url ?? '').includes('http')) {
    throw new Error('Truein base URL is not configured');
  }

  const lookback = tc.lookbackDays ?? 1;
  const baseOffset = tc.dateOffsetDays ?? 0;
  const mapping = { ...TRUIN_DEFAULT_MAPPING, ...(config.file_mapping_json ?? {}) };
  const allRows: StagingRow[] = [];
  const seen = new Set<string>();

  for (let i = 0; i <= lookback; i++) {
    const offset = baseOffset - i;
    const preview = previewTrueinRequest(config, offset);
    logger.info({ date: preview.date, url: preview.url, offset }, 'Fetching Truein attendance');

    const rows = await fetchAttendanceFromApi({
      apiUrl: preview.url,
      apiMethod: preview.method,
      apiAuthType: 'BEARER',
      apiAuthConfig: { token },
      apiHeaders: {
        ...(config.api_headers ?? {}),
        Accept: 'application/json',
      },
      apiBodyTemplate: preview.method === 'POST' ? preview.body : null,
      fileMapping: mapping,
      ...(tc.recordsPath ? { recordsPath: tc.recordsPath } : {}),
    });

    for (const row of rows) {
      const key = `${row.raw_identifier}|${row.raw_email}|${row.punch_ts ?? row.punch_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allRows.push(row);
    }

    if (rows.length > 0) break;
  }

  // Empty feed is not a hard failure — orchestrator skips rule evaluation safely.
  if (allRows.length === 0) {
    logger.warn({ lookback, baseOffset }, 'Truein returned no attendance records for date range');
  }

  return allRows;
}

export async function testTrueinConnection(config: AttendanceIgaConfig): Promise<{
  ok: boolean;
  recordCount: number;
  date: string;
  requestUrl: string;
  message: string;
}> {
  const preview = previewTrueinRequest(config, (config.api_config as TrueinApiConfig)?.dateOffsetDays ?? 0);
  const rows = await fetchAttendanceFromTruein(config);
  return {
    ok: true,
    recordCount: rows.length,
    date: preview.date,
    requestUrl: preview.url,
    message: rows.length > 0
      ? `Connected — ${rows.length} attendance record(s) for ${preview.date}`
      : `Connected — API reachable but 0 records for ${preview.date} (rules will not suspend users)`,
  };
}

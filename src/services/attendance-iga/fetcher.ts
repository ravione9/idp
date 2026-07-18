import axios from 'axios';
import logger from '../../utils/logger.js';
import { expandDateTemplate } from './date-template.js';
import type { StagingRow } from './types.js';

const MAX_RETRIES = 5;

function parseJsonField<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as T;
  try { return JSON.parse(String(raw)) as T; } catch { return null; }
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export function extractApiRecords(payload: unknown, recordsPath?: string | null): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (!payload || typeof payload !== 'object') return [];

  const obj = payload as Record<string, unknown>;
  const paths = recordsPath
    ? [recordsPath]
    : ['records', 'data', 'attendance', 'result', 'staff', 'employees', 'attendance_data', 'attendance_list'];

  for (const p of paths) {
    const val = p.includes('.') ? getByPath(obj, p) : obj[p];
    if (Array.isArray(val)) return val as Record<string, unknown>[];
  }

  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) return val as Record<string, unknown>[];
  }
  return [];
}

function expandUrlDates(
  url: string,
  options?: { offsetDays?: number | undefined; timeZone?: string | undefined },
): string {
  if (!url.includes('{')) return url;
  return expandDateTemplate(url, options);
}

export async function fetchAttendanceFromApi(params: {
  apiUrl: string;
  apiMethod: 'GET' | 'POST';
  apiAuthType: string;
  apiAuthConfig: Record<string, unknown> | null;
  apiHeaders: Record<string, string> | null;
  apiBodyTemplate: Record<string, unknown> | null;
  fileMapping: Record<string, string> | null;
  recordsPath?: string | null;
  dateOffsetDays?: number | undefined;
  timeZone?: string | undefined;
}): Promise<StagingRow[]> {
  const headers: Record<string, string> = { ...(params.apiHeaders ?? {}) };
  const auth = params.apiAuthConfig ?? {};

  if (params.apiAuthType === 'BEARER' && auth['token']) {
    headers['Authorization'] = `Bearer ${String(auth['token'])}`;
  } else if (params.apiAuthType === 'BASIC' && auth['username'] && auth['password']) {
    const token = Buffer.from(`${String(auth['username'])}:${String(auth['password'])}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  } else if (params.apiAuthType === 'API_KEY' && auth['headerName'] && auth['apiKey']) {
    headers[String(auth['headerName'])] = String(auth['apiKey']);
  }

  const dateOpts = {
    offsetDays: params.dateOffsetDays ?? 0,
    timeZone: params.timeZone ?? 'Asia/Kolkata',
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const url = expandUrlDates(params.apiUrl, dateOpts);
      let body = params.apiMethod === 'POST' ? { ...(params.apiBodyTemplate ?? {}) } : undefined;
      if (body && typeof body === 'object') {
        body = JSON.parse(expandDateTemplate(JSON.stringify(body), dateOpts)) as Record<string, unknown>;
      }

      const resp = await axios.request({
        url,
        method: params.apiMethod,
        headers,
        data: body,
        timeout: 60_000,
      });

      const mapping = params.fileMapping ?? {
        identifier: 'employee_id',
        email: 'email',
        username: 'username',
        punchDate: 'date',
        punchTime: 'in_time',
      };

      const records = extractApiRecords(resp.data, params.recordsPath ?? null);
      return records.map((row, idx) => mapApiRecord(row, mapping, idx + 1));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const delayMs = Math.min(60_000, 1000 * 2 ** attempt);
      logger.warn({ attempt: attempt + 1, delayMs, err: lastError.message }, 'Attendance API fetch failed — retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError ?? new Error('Attendance API unavailable after retries');
}

function pickField(row: Record<string, unknown>, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const val = key.includes('.') ? getByPath(row, key) : row[key];
  return val === undefined || val === null ? undefined : String(val).trim();
}

function mapApiRecord(
  row: Record<string, unknown>,
  mapping: Record<string, string>,
  rowNumber: number,
): StagingRow {
  const punchDate = pickField(row, mapping['punchDate'] ?? mapping['date']);
  const punchTime = pickField(row, mapping['punchTime'] ?? mapping['in_time'] ?? mapping['punch_time']);
  let punchTs: string | undefined;
  if (punchDate && punchTime) punchTs = `${punchDate} ${punchTime.length === 5 ? `${punchTime}:00` : punchTime}`;
  else if (pickField(row, mapping['punch_ts'] ?? mapping['event_ts'])) {
    punchTs = pickField(row, mapping['punch_ts'] ?? mapping['event_ts']);
  }

  const staging: StagingRow = { source_row: rowNumber, raw_json: row };
  const rawId = pickField(row, mapping['identifier'] ?? mapping['employee_id'] ?? mapping['employee_code']);
  const rawEmail = pickField(row, mapping['email']);
  const rawUsername = pickField(row, mapping['username']);
  if (rawId) staging.raw_identifier = rawId;
  if (rawEmail) staging.raw_email = rawEmail;
  if (rawUsername) staging.raw_username = rawUsername;
  if (punchDate) staging.punch_date = punchDate;
  if (punchTime) staging.punch_time = punchTime;
  if (punchTs) staging.punch_ts = punchTs;
  return staging;
}

export function parseCsvToStaging(csvText: string, mapping: Record<string, string> | null): StagingRow[] {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const headerLine = lines[0]!;
  const delimiter = headerLine.includes('\t') ? '\t' : ',';
  const headers = headerLine.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''));
  const map = mapping ?? inferMapping(headers);

  const rows: StagingRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''));
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ''; });
    rows.push(mapApiRecord(obj, map, i));
  }
  return rows;
}

function inferMapping(headers: string[]): Record<string, string> {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (...candidates: string[]) => {
    for (const c of candidates) {
      const idx = lower.indexOf(c);
      if (idx >= 0) return headers[idx]!;
    }
    return undefined;
  };
  return {
    identifier: find('emp_id', 'employee_id', 'employee_code', 'employee code', 'staff_id', 'id') ?? headers[0]!,
    email: find('email', 'email_address', 'work_email') ?? 'email',
    username: find('username', 'user_name', 'login') ?? 'username',
    punchDate: find('date', 'punch_date', 'attendance_date', 'attnd_date') ?? 'date',
    punchTime: find('in_time', 'punch_time', 'punch_in', 'check_in', 'first_in', 'time') ?? 'in_time',
  };
}

export { parseJsonField };

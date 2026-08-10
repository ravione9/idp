/**
 * Connector run export — per-user sync results as CSV (opens in Excel).
 */
import { queryOne } from '../db/connection.js';

export interface ConnectorRunUserResult {
  email: string;
  fullName?: string;
  empId?: string;
  employeeNumber?: string;
  department?: string;
  status: 'OK' | 'FAILED' | 'WARNING';
  action?: string;
  error?: string;
}

export interface ConnectorRunPayload {
  phase?: string;
  detail?: string | null;
  progressAt?: string;
  partial?: boolean;
  userResults?: ConnectorRunUserResult[];
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function connectorRunUserResultsToCsv(
  run: { id: string; started_at?: string; status?: string; userResults: ConnectorRunUserResult[] },
): string {
  const headers = ['email', 'full_name', 'emp_id', 'employee_number', 'department', 'status', 'action', 'error'];
  const lines = [
    headers.join(','),
    ...run.userResults.map((u) => [
      u.email,
      u.fullName ?? '',
      u.empId ?? '',
      u.employeeNumber ?? '',
      u.department ?? '',
      u.status,
      u.action ?? '',
      u.error ?? '',
    ].map(csvEscape).join(',')),
  ];
  const meta = `# run_id=${run.id}, started=${run.started_at ?? ''}, status=${run.status ?? ''}, rows=${run.userResults.length}`;
  return `${meta}\n${lines.join('\n')}`;
}

export async function loadConnectorRunExport(
  connectorId: string,
  runId: string,
): Promise<{ filename: string; csv: string; rowCount: number } | null> {
  const row = await queryOne<{
    id: string;
    connector_id: string;
    started_at: string;
    status: string;
    payload: string | ConnectorRunPayload | null;
    error_summary: string | null;
  }>(
    `SELECT id, connector_id, started_at, status, payload, error_summary
       FROM connector_runs WHERE id = ? AND connector_id = ?`,
    [runId, connectorId],
  );
  if (!row) return null;

  let payload: ConnectorRunPayload | null = null;
  if (row.payload) {
    payload = typeof row.payload === 'string'
      ? JSON.parse(row.payload) as ConnectorRunPayload
      : row.payload;
  }

  let userResults = payload?.userResults ?? [];
  if (!userResults.length && row.error_summary) {
    userResults = parseErrorsFromSummary(row.error_summary);
  }

  const csv = connectorRunUserResultsToCsv({
    id: row.id,
    started_at: row.started_at,
    status: row.status,
    userResults,
  });

  const stamp = row.started_at ? row.started_at.slice(0, 10) : 'run';
  return {
    filename: `sync-run-${stamp}-${runId.slice(0, 8)}.csv`,
    csv,
    rowCount: userResults.length,
  };
}

/** Best-effort parse of legacy error_summary lines like "email: reason". */
function parseErrorsFromSummary(summary: string): ConnectorRunUserResult[] {
  const out: ConnectorRunUserResult[] = [];
  for (const part of summary.split(/;\s*/)) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const email = trimmed.slice(0, idx).trim().toLowerCase();
    if (!email.includes('@')) continue;
    out.push({
      email,
      status: 'FAILED',
      error: trimmed.slice(idx + 1).trim(),
    });
  }
  return out;
}

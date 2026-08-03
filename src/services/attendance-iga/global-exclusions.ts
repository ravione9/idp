import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../../db/connection.js';

export interface GlobalExclusionRow {
  id:         string;
  email:      string;
  emp_id:     string | null;
  notes:      string | null;
  active:     number;
  created_by: string | null;
  created_at: string;
  full_name?: string | null;
}

export interface GlobalExclusionLookup {
  emails:  Set<string>;
  empIds:  Set<string>;
}

function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export async function resolveEmailToEmpId(email: string): Promise<string | null> {
  const row = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees
      WHERE LOWER(email_corp) = ? OR LOWER(email_personal) = ?
      LIMIT 1`,
    [email, email],
  );
  return row?.emp_id ?? null;
}

export async function listGlobalExclusions(): Promise<GlobalExclusionRow[]> {
  return query<GlobalExclusionRow>(
    `SELECT g.id, g.email, g.emp_id, g.notes, g.active, g.created_by, g.created_at,
            e.full_name
       FROM attendance_iga_global_exclusions g
       LEFT JOIN employees e ON e.emp_id = g.emp_id
      WHERE g.active = 1
      ORDER BY g.email ASC`,
    [],
  );
}

export async function loadGlobalExclusionLookup(): Promise<GlobalExclusionLookup> {
  const rows = await query<{ email: string; emp_id: string | null }>(
    `SELECT email, emp_id FROM attendance_iga_global_exclusions WHERE active = 1`,
    [],
  );
  const emails = new Set<string>();
  const empIds = new Set<string>();
  for (const row of rows) {
    emails.add(row.email.toLowerCase());
    if (row.emp_id) empIds.add(row.emp_id);
  }
  return { emails, empIds };
}

export function isGloballyExcluded(
  emp: { emp_id: string; email_corp?: string | null },
  lookup: GlobalExclusionLookup,
): boolean {
  if (lookup.empIds.has(emp.emp_id)) return true;
  const email = emp.email_corp?.trim().toLowerCase();
  return !!email && lookup.emails.has(email);
}

export async function addGlobalExclusion(
  emailRaw: string,
  notes: string | null,
  createdBy: string,
): Promise<{ id: string; email: string; emp_id: string | null; unknownEmail: boolean }> {
  const email = normalizeEmail(emailRaw);
  if (!email) throw new Error('Valid email address required');

  const empId = await resolveEmailToEmpId(email);
  const id = uuidv4();
  await execute(
    `INSERT INTO attendance_iga_global_exclusions (id, email, emp_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       active = 1,
       emp_id = COALESCE(VALUES(emp_id), emp_id),
       notes = COALESCE(VALUES(notes), notes),
       updated_at = UTC_TIMESTAMP()`,
    [id, email, empId, notes, createdBy],
  );
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM attendance_iga_global_exclusions WHERE email = ? LIMIT 1`,
    [email],
  );
  return { id: row?.id ?? id, email, emp_id: empId, unknownEmail: !empId };
}

export async function removeGlobalExclusion(id: string): Promise<void> {
  await execute(
    `UPDATE attendance_iga_global_exclusions SET active = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [id],
  );
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
      continue;
    }
    if (ch === ',' && !inQ) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseGlobalExclusionCsv(csvText: string): string[] {
  const emails: string[] = [];
  const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return emails;

  const headerCells = splitCsvLine(lines[0]!).map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  const emailIdx = headerCells.findIndex((h) =>
    h === 'email' || h === 'email_id' || h === 'email id' || h === 'email_corp' || h === 'corporate_email',
  );
  const looksLikeHeader = emailIdx >= 0 || headerCells.some((h) => h.includes('email'));
  const start = looksLikeHeader ? 1 : 0;

  for (let li = start; li < lines.length; li++) {
    const cells = splitCsvLine(lines[li]!).map((c) => c.replace(/^"|"$/g, '').trim());
    if (looksLikeHeader && emailIdx >= 0) {
      const email = normalizeEmail(cells[emailIdx] ?? '');
      if (email) emails.push(email);
    } else {
      for (const cell of cells) {
        const email = normalizeEmail(cell);
        if (email) emails.push(email);
      }
    }
  }
  return [...new Set(emails)];
}

export async function importGlobalExclusionsCsv(
  csvText: string,
  createdBy: string,
): Promise<{ added: number; skipped: number; unknownEmails: string[] }> {
  const emails = parseGlobalExclusionCsv(csvText);
  let added = 0;
  let skipped = 0;
  const unknownEmails: string[] = [];

  for (const email of emails) {
    try {
      const r = await addGlobalExclusion(email, null, createdBy);
      added++;
      if (r.unknownEmail) unknownEmails.push(email);
    } catch {
      skipped++;
    }
  }

  return { added, skipped, unknownEmails: [...new Set(unknownEmails)] };
}

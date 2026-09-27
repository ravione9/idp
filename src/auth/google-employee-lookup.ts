/**
 * Resolve an active employee for Google portal sign-in.
 * Exact email first, then Google identity link, then unique local-part
 * across configured Workspace hosted domains (lenskart.com / .in, etc.).
 */
import { query, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';

export interface GoogleLoginEmployee {
  emp_id: string;
  role: string;
  matchedVia: 'email_corp' | 'email_personal' | 'local_account' | 'google_link' | 'domain_alias';
}

function localPart(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at).toLowerCase() : '';
}

export async function resolveEmployeeForGoogleLogin(params: {
  email: string;
  googleSub: string;
  hostedDomains: string[];
}): Promise<GoogleLoginEmployee | null> {
  const email = params.email.trim().toLowerCase();
  if (!email) return null;

  const byCorp = await queryOne<{ emp_id: string; role: string }>(
    `SELECT emp_id, role FROM employees
      WHERE LOWER(email_corp) = ? AND ilg_state IN ('ACTIVE', 'REACTIVATED')
      LIMIT 1`,
    [email],
  );
  if (byCorp) return { ...byCorp, matchedVia: 'email_corp' };

  const byPersonal = await queryOne<{ emp_id: string; role: string }>(
    `SELECT emp_id, role FROM employees
      WHERE email_personal IS NOT NULL
        AND LOWER(email_personal) = ?
        AND ilg_state IN ('ACTIVE', 'REACTIVATED')
      LIMIT 1`,
    [email],
  );
  if (byPersonal) return { ...byPersonal, matchedVia: 'email_personal' };

  const byLocal = await queryOne<{ emp_id: string; role: string }>(
    `SELECT e.emp_id, e.role
       FROM local_accounts la
       JOIN employees e ON e.emp_id = la.emp_id
      WHERE la.active = 1
        AND LOWER(la.email) = ?
        AND e.ilg_state IN ('ACTIVE', 'REACTIVATED')
      LIMIT 1`,
    [email],
  );
  if (byLocal) return { ...byLocal, matchedVia: 'local_account' };

  const sub = String(params.googleSub || '').trim();
  if (sub) {
    const byLink = await queryOne<{ emp_id: string; role: string }>(
      `SELECT e.emp_id, e.role
         FROM identity_links il
         JOIN employees e ON e.emp_id = il.emp_id
        WHERE il.\`system\` = 'GOOGLE'
          AND il.status != 'DELETED'
          AND (il.external_id = ? OR LOWER(il.external_id) = ?)
          AND e.ilg_state IN ('ACTIVE', 'REACTIVATED')
        LIMIT 1`,
      [sub, email],
    );
    if (byLink) return { ...byLink, matchedVia: 'google_link' };
  }

  const lp = localPart(email);
  const domains = [...new Set(
    params.hostedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean),
  )];
  if (lp && domains.length > 0) {
    const placeholders = domains.map(() => '?').join(', ');
    const aliases = await query<{ emp_id: string; role: string; email_corp: string }>(
      `SELECT emp_id, role, email_corp FROM employees
        WHERE ilg_state IN ('ACTIVE', 'REACTIVATED')
          AND LOWER(SUBSTRING_INDEX(email_corp, '@', 1)) = ?
          AND LOWER(SUBSTRING_INDEX(email_corp, '@', -1)) IN (${placeholders})
        LIMIT 3`,
      [lp, ...domains],
    );
    if (aliases.length === 1 && aliases[0]) {
      logger.info(
        { googleEmail: email, empId: aliases[0].emp_id, emailCorp: aliases[0].email_corp },
        'Google login: matched employee via Workspace domain alias',
      );
      return {
        emp_id: aliases[0].emp_id,
        role: aliases[0].role,
        matchedVia: 'domain_alias',
      };
    }
    if (aliases.length > 1) {
      logger.warn(
        { googleEmail: email, candidates: aliases.map((a) => a.email_corp) },
        'Google login: ambiguous domain-alias match — refusing guess',
      );
    }
  }

  return null;
}

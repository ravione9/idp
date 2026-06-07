/**
 * Self-service endpoints for the authenticated user:
 *   - change own password
 *   - list active sessions
 *   - revoke a session
 *   - MFA status / enrollment / disable
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import qrcode from 'qrcode';
import { requireAuth } from '../auth/middleware.js';
import { query, queryOne } from '../db/connection.js';
import { hashPassword, verifyLocalPassword } from '../services/local-admin.js';
import { COOKIE_NAME, SESSION_REDIS_PREFIX } from '../auth/session.js';
import { redis } from '../auth/session-store.js';
import {
  confirmEnrollment,
  disableMfa,
  getMfaStatus,
  regenerateBackupCodes,
  startEnrollment,
} from '../auth/mfa.js';
import logger from '../utils/logger.js';
import { sanitizeDeviceContext } from '../utils/device-context.js';
import { findClientLocalIp, enrichSessionHostname } from '../utils/request-context.js';

const router = Router();

router.use(requireAuth);

// ---------------------------------------------------------------------------
// PUT /password — change own password (local accounts only)
// ---------------------------------------------------------------------------
const changePwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(10).max(128),
});

router.put('/password', async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const parsed = changePwSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const account = await queryOne<{ id: number; password_hash: string }>(
    'SELECT id, password_hash FROM local_accounts WHERE emp_id = ? AND active = 1',
    [user.empId],
  );
  if (!account) {
    res.status(403).json({ error: 'Password change is only available for local accounts' });
    return;
  }

  const ok = await verifyLocalPassword(parsed.data.currentPassword, account.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  if (parsed.data.currentPassword === parsed.data.newPassword) {
    res.status(400).json({ error: 'New password must differ from current' });
    return;
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  await query(
    `INSERT INTO local_password_history (account_id, password_hash, changed_by)
     VALUES (?, ?, ?)`,
    [account.id, account.password_hash, user.empId],
  );
  await query('UPDATE local_accounts SET password_hash = ? WHERE id = ?', [newHash, account.id]);

  logger.info({ empId: user.empId }, 'Password changed');
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /sessions — list active sessions for current user
// ---------------------------------------------------------------------------
router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const rows = await query<Record<string, unknown>>(
    `SELECT session_id, iss, created_at, last_active_at, expires_at, ip, user_agent,
            client_hostname, client_local_ip, client_mac, revoked_at
       FROM idp_sessions
      WHERE emp_id = ? AND expires_at > UTC_TIMESTAMP() AND revoked_at IS NULL
      ORDER BY last_active_at DESC`,
    [user.empId],
  );
  const data = rows.map((r) => ({
    ...r,
    isCurrent: r['session_id'] === user.sessionId,
  }));
  res.json({ data });
});

// ---------------------------------------------------------------------------
// POST /sessions/device-context — attach client hostname / local IP to session
// ---------------------------------------------------------------------------
router.post('/sessions/device-context', async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;

  // Client may send nothing or a partial object — fall back to server-side header detection.
  const device = sanitizeDeviceContext(req.body);
  const headerLocalIp = findClientLocalIp(req);

  const effectiveLocalIp   = device?.localIp   ?? headerLocalIp ?? null;
  const effectiveHostname   = device?.hostname  ?? null;
  const effectiveMac        = device?.macAddress ?? null;

  await query(
    `UPDATE idp_sessions
        SET client_hostname = COALESCE(client_hostname, ?),
            client_local_ip  = COALESCE(client_local_ip, ?),
            client_mac       = COALESCE(client_mac, ?)
      WHERE session_id = ? AND emp_id = ? AND revoked_at IS NULL`,
    [effectiveHostname, effectiveLocalIp, effectiveMac, user.sessionId, user.empId],
  );

  // Background: reverse-DNS on internal IP for hostname (fires even if client sent nothing)
  if (!effectiveHostname) {
    enrichSessionHostname(user.sessionId, effectiveLocalIp, (sid, hostname) =>
      query(
        'UPDATE idp_sessions SET client_hostname = ? WHERE session_id = ? AND client_hostname IS NULL',
        [hostname, sid],
      ).then(() => {}),
    );
  }

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// DELETE /sessions/:id — revoke a session
// ---------------------------------------------------------------------------
router.delete('/sessions/:id', async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const id = req.params['id'];
  if (!id) {
    res.status(400).json({ error: 'Missing session id' });
    return;
  }

  const row = await queryOne<{ session_id: string }>(
    'SELECT session_id FROM idp_sessions WHERE session_id = ? AND emp_id = ?',
    [id, user.empId],
  );
  if (!row) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  await query(
    'UPDATE idp_sessions SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ?',
    [id],
  );
  await redis.del(`${SESSION_REDIS_PREFIX}${id}`);

  // If revoking the current session, clear cookie too
  if (id === user.sessionId) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
  }

  logger.info({ empId: user.empId, sessionId: id }, 'Session revoked by user');
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// MFA endpoints
// ---------------------------------------------------------------------------

router.get('/mfa', async (req: Request, res: Response): Promise<void> => {
  const status = await getMfaStatus(req.user!.empId);
  res.json(status);
});

router.post('/mfa/enroll', async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const result = await startEnrollment(user.empId, user.email);
  const qrDataUrl = await qrcode.toDataURL(result.otpauthUrl, { margin: 1, width: 220 });
  res.json({
    secret:     result.secret,
    otpauthUrl: result.otpauthUrl,
    qrDataUrl,
  });
});

const confirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

router.post('/mfa/confirm', async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Code must be 6 digits' });
    return;
  }
  try {
    const { backupCodes } = await confirmEnrollment(user.empId, parsed.data.code);
    res.json({ success: true, backupCodes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Verification failed' });
  }
});

router.post('/mfa/disable', async (req: Request, res: Response): Promise<void> => {
  await disableMfa(req.user!.empId);
  res.json({ success: true });
});

router.post('/mfa/regenerate-codes', async (req: Request, res: Response): Promise<void> => {
  try {
    const codes = await regenerateBackupCodes(req.user!.empId);
    res.json({ backupCodes: codes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' });
  }
});

export default router;

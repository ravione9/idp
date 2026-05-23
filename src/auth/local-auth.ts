/**
 * Local email + password login for administrators
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { createSession, setSessionCookie } from './session.js';
import {
  findLocalAccountByEmail,
  touchLocalLogin,
  verifyLocalPassword,
} from '../services/local-admin.js';

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8),
});

export async function localLoginHandler(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid email or password format' });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const account = await findLocalAccountByEmail(email);
    if (!account) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await verifyLocalPassword(password, account.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const sessionId = await createSession({
      empId:     account.emp_id,
      email:     account.email,
      role:      account.role,
      iss:       'local',
      sub:       `local:${account.id}`,
      ttlHours:  config.session.ttlCorporateHours,
      ip:        req.ip ?? '',
      userAgent: req.get('user-agent') ?? '',
    });

    await touchLocalLogin(account.id);
    setSessionCookie(res, sessionId, config.session.ttlCorporateHours);

    logger.info({ empId: account.emp_id, email: account.email }, 'Local admin login');
    res.json({ success: true, redirect: '/' });
  } catch (err) {
    logger.error({ err }, 'Local login failed');
    res.status(500).json({ error: 'Login failed' });
  }
}

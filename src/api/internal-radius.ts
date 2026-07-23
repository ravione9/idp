/**
 * Internal RADIUS authenticate — FreeRADIUS rlm_rest / custom AAA agents.
 * Gated by X-Internal-Token. Mounted at /api/internal/radius
 *
 * FreeRADIUS rest module example:
 *   url = "https://idp.example/api/internal/radius/authenticate"
 *   method = "post"
 *   body = '{"username":"%{User-Name}","password":"%{User-Password}","nasIp":"%{NAS-IP-Address}","callingStationId":"%{Calling-Station-Id}"}'
 *   header = "Content-Type: application/json"
 *   header = "X-Internal-Token: <INTERNAL_TOKEN>"
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { timingSafeEqualString } from '../utils/timing-safe.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticateRadius } from '../services/radius-auth.js';
import { getClientIp } from '../utils/request-context.js';

const router = Router();

function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-internal-token'];
  const token = typeof header === 'string' ? header : '';
  if (!token || !timingSafeEqualString(token, config.app.internalToken)) {
    res.status(403).json({ error: 'Invalid or missing X-Internal-Token' });
    return;
  }
  next();
}

router.use(requireInternalToken);

const AuthBody = z.object({
  username: z.string().min(1).optional(),
  UserName: z.string().min(1).optional(),
  'User-Name': z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  UserPassword: z.string().min(1).optional(),
  'User-Password': z.string().min(1).optional(),
  nasIp: z.string().optional(),
  NasIpAddress: z.string().optional(),
  'NAS-IP-Address': z.string().optional(),
  callingStationId: z.string().optional(),
  CallingStationId: z.string().optional(),
  'Calling-Station-Id': z.string().optional(),
  clientIp: z.string().optional(),
});

router.post('/authenticate', asyncHandler(async (req: Request, res: Response) => {
  // FreeRADIUS may send JSON or x-www-form-urlencoded
  const raw = { ...(req.body || {}) };
  if (typeof raw === 'object' && raw !== null) {
    // flatten common FreeRADIUS control attrs if nested
  }
  const parsed = AuthBody.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ result: 'reject', reason: 'invalid-body' });
    return;
  }
  const b = parsed.data;
  const username = b.username || b.UserName || b['User-Name'] || '';
  const password = b.password || b.UserPassword || b['User-Password'] || '';
  const nasIp = b.nasIp || b.NasIpAddress || b['NAS-IP-Address'];
  const callingStationId = b.callingStationId || b.CallingStationId || b['Calling-Station-Id'];

  const result = await authenticateRadius({
    username,
    password,
    nasIp: nasIp ?? null,
    callingStationId: callingStationId ?? null,
    clientSourceIp: b.clientIp || getClientIp(req),
    protocol: 'REST',
  });

  if (result.result === 'ACCEPT') {
    // FreeRADIUS rlm_rest: 2xx + JSON body with reply attributes
    res.status(200).json({
      result: 'accept',
      empId: result.empId,
      reply: result.reply || {},
      // Convenience: also expand as FreeRADIUS-style keys
      ...Object.fromEntries(
        Object.entries(result.reply || {}).map(([k, v]) => [`reply:${k}`, v]),
      ),
    });
    return;
  }

  res.status(401).json({
    result: 'reject',
    reason: result.reason || 'rejected',
  });
}));

router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, udpEnabled: config.radius.udpEnabled, udpPort: config.radius.udpPort });
});

export default router;

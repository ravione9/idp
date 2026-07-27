/**
 * Self-service personal credential vault.
 * Mounted at /api/me — any authenticated user; rows scoped to emp_id.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  listUserVaultEntries,
  createUserVaultEntry,
  updateUserVaultEntry,
  deleteUserVaultEntry,
  revealUserVaultEntry,
} from '../services/user-vault.js';

const router = Router();
router.use(requireAuth);

function httpErr(res: Response, err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status: number }).status) || 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Error' });
    return true;
  }
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ZodError') {
    res.status(400).json({ error: 'Invalid body', details: err });
    return true;
  }
  return false;
}

router.get('/vault', asyncHandler(async (req: Request, res: Response) => {
  res.json({ data: await listUserVaultEntries(req.user!.empId) });
}));

router.post('/vault', asyncHandler(async (req: Request, res: Response) => {
  try {
    const created = await createUserVaultEntry(req.user!.empId, req.body);
    res.status(201).json(created);
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.put('/vault/:id', asyncHandler(async (req: Request, res: Response) => {
  try {
    await updateUserVaultEntry(req.user!.empId, req.params['id']!, req.body);
    res.json({ success: true });
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.delete('/vault/:id', asyncHandler(async (req: Request, res: Response) => {
  try {
    await deleteUserVaultEntry(req.user!.empId, req.params['id']!);
    res.json({ success: true });
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.post('/vault/:id/reveal', asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await revealUserVaultEntry(req.user!.empId, req.params['id']!);
    res.json(result);
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

export default router;

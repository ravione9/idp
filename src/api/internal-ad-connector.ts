/**
 * Internal AD Connector API — on-prem Windows agent over HTTPS :443.
 *
 * Auth: X-Connector-Id + X-Agent-Token (per-connector bearer token).
 * AD LDAP credentials never leave the agent host.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler.js';
import { rateLimit } from '../auth/rate-limit.js';
import { getClientIp } from '../utils/request-context.js';
import {
  loadAdAgentConnector,
  verifyAgentToken,
  recordAgentHeartbeat,
  getPendingAgentJob,
  claimAgentJob,
  processAgentInbound,
  getAgentOutboundPlan,
  applyAgentOutboundResults,
  completeAgentJob,
  failAgentJob,
  processAgentGroups,
} from '../services/ad-agent-sync.js';
import type { AdOutboundResult } from '../services/ad-sync.js';

const router = Router();

interface AgentAuth {
  connectorId: string;
  cfg: Record<string, unknown>;
}

function requireAgentAuth(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const connectorId = String(req.headers['x-connector-id'] ?? '').trim();
    const token = String(req.headers['x-agent-token'] ?? '').trim();

    if (!connectorId || !token) {
      res.status(403).json({ error: 'Missing X-Connector-Id or X-Agent-Token' });
      return;
    }

    const row = await loadAdAgentConnector(connectorId);
    if (!row) {
      res.status(404).json({ error: 'AD Agent connector not found' });
      return;
    }

    const cfg = typeof row.config_json === 'string'
      ? JSON.parse(row.config_json || '{}') as Record<string, unknown>
      : (row.config_json ?? {});

    if (!verifyAgentToken(cfg, token)) {
      res.status(403).json({ error: 'Invalid agent token' });
      return;
    }

    (req as Request & { agentAuth: AgentAuth }).agentAuth = { connectorId, cfg };
    next();
  })().catch(next);
}

router.use(requireAgentAuth);
router.use(rateLimit({
  max: 300,
  windowMs: 60_000,
  keyFn: (req) => `ad-agent:${getClientIp(req)}:${req.headers['x-connector-id'] ?? 'unknown'}`,
}));

function auth(req: Request): AgentAuth {
  return (req as Request & { agentAuth: AgentAuth }).agentAuth;
}

const HeartbeatBody = z.object({
  adReachable: z.boolean(),
  adMessage: z.string().max(2000).optional(),
  agentVersion: z.string().max(50).optional(),
});

router.post('/heartbeat', asyncHandler(async (req: Request, res: Response) => {
  const { connectorId } = auth(req);
  const parsed = HeartbeatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }
  await recordAgentHeartbeat(
    connectorId,
    parsed.data.adReachable,
    parsed.data.adMessage ?? '',
    parsed.data.agentVersion,
  );
  res.json({ ok: true });
}));

router.get('/jobs/next', asyncHandler(async (req: Request, res: Response) => {
  const { connectorId } = auth(req);
  const job = await getPendingAgentJob(connectorId);
  if (!job) {
    res.status(204).end();
    return;
  }
  res.json({
    runId: job.runId,
    runType: job.runType,
    direction: job.direction,
    runInbound: job.runInbound,
    runOutbound: job.runOutbound,
    dirConfig: job.dirConfig,
    upnDomain: job.upnDomain,
    syncGroups: job.syncGroups,
  });
}));

router.post('/jobs/:runId/claim', asyncHandler(async (req: Request, res: Response) => {
  const { connectorId } = auth(req);
  const runId = req.params['runId']!;
  const claimed = await claimAgentJob(runId, connectorId);
  if (!claimed) {
    res.status(409).json({ error: 'Job not available or already claimed' });
    return;
  }
  res.json({ ok: true, runId });
}));

const InboundBody = z.object({
  users: z.array(z.record(z.unknown())).max(50_000),
});

router.post('/jobs/:runId/inbound', asyncHandler(async (req: Request, res: Response) => {
  const { connectorId } = auth(req);
  const runId = req.params['runId']!;
  const parsed = InboundBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }

  const { inbound, errors } = await processAgentInbound(runId, connectorId, parsed.data.users);
  res.json({
    ok: true,
    inbound,
    errors,
    summary:
      `Inbound: ${inbound.found} users, ${inbound.imported} imported, ${inbound.linked} linked, ${inbound.skipped} skipped`,
  });
}));

router.get('/jobs/:runId/outbound-plan', asyncHandler(async (req: Request, res: Response) => {
  const { connectorId } = auth(req);
  const plan = await getAgentOutboundPlan(connectorId);
  res.json({ actions: plan });
}));

const OutboundBody = z.object({
  results: z.array(z.object({
    empId: z.string().min(1),
    action: z.string().min(1),
    success: z.boolean(),
    externalId: z.string().optional(),
    error: z.string().optional(),
  })).max(50_000),
});

router.post('/jobs/:runId/outbound', asyncHandler(async (req: Request, res: Response) => {
  const parsed = OutboundBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }
  const outcome = await applyAgentOutboundResults(parsed.data.results as AdOutboundResult[]);
  res.json({ ok: true, ...outcome });
}));

const GroupsBody = z.object({
  groups: z.array(z.object({
    dn: z.string().min(1),
    name: z.string().min(1),
    sam: z.string().optional(),
    members: z.array(z.object({
      sam: z.string().min(1),
      mail: z.string().optional(),
      upn: z.string().optional(),
      employeeId: z.string().optional(),
    })).max(10_000),
  })).max(500),
});

router.post('/jobs/:runId/groups', asyncHandler(async (req: Request, res: Response) => {
  const { connectorId } = auth(req);
  const parsed = GroupsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }
  const summary = await processAgentGroups(connectorId, parsed.data.groups);
  res.json({
    ok: true,
    groupsSynced: summary.groupsSynced,
    membersSynced: summary.membersSynced,
    errors: summary.errors,
    summary: `Groups: ${summary.groupsSynced} synced, ${summary.membersSynced} members`,
  });
}));

const CompleteBody = z.object({
  itemsProcessed: z.number().int().min(0),
  itemsSucceeded: z.number().int().min(0),
  itemsFailed: z.number().int().min(0),
  errorSummary: z.string().max(8000).optional().nullable(),
  inboundSummary: z.string().max(8000).optional(),
});

router.post('/jobs/:runId/complete', asyncHandler(async (req: Request, res: Response) => {
  const { connectorId } = auth(req);
  const runId = req.params['runId']!;
  const parsed = CompleteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }
  await completeAgentJob(runId, connectorId, {
    itemsProcessed: parsed.data.itemsProcessed,
    itemsSucceeded: parsed.data.itemsSucceeded,
    itemsFailed: parsed.data.itemsFailed,
    errorSummary: parsed.data.errorSummary ?? null,
    ...(parsed.data.inboundSummary ? { inboundSummary: parsed.data.inboundSummary } : {}),
  });
  res.json({ ok: true });
}));

const FailBody = z.object({
  message: z.string().min(1).max(4000),
});

router.post('/jobs/:runId/fail', asyncHandler(async (req: Request, res: Response) => {
  const { connectorId } = auth(req);
  const runId = req.params['runId']!;
  const parsed = FailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }
  await failAgentJob(runId, connectorId, parsed.data.message);
  res.json({ ok: true });
}));

router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'ad-connector-agent-api' });
});

export default router;

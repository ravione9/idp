import type { AgentConfig } from './config.js';
import { AdLdapClient, getAttr, getObjectGuidAttr, USER_IMPORT_ATTRS } from './ad-ldap.js';
import { IdpClient, type OutboundAction, type OutboundResult } from './idp-client.js';

function slimAdUser(u: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of USER_IMPORT_ATTRS) {
    if (key.toLowerCase() === 'objectguid') {
      const guid = getObjectGuidAttr(u);
      if (guid) out.objectGUID = guid;
      continue;
    }
    const v = getAttr(u, key);
    if (v) out[key] = v;
  }
  return out;
}

export async function runSyncJob(cfg: AgentConfig, idp: IdpClient, job: Awaited<ReturnType<IdpClient['fetchNextJob']>> & object): Promise<void> {
  const ldap = new AdLdapClient(cfg.ad);
  let itemsProcessed = 0;
  let itemsSucceeded = 0;
  let itemsFailed = 0;
  const errors: string[] = [];
  let inboundSummary = '';

  try {
    await idp.claimJob(job.runId);

    if (job.runInbound) {
      const users = await ldap.listUsers();
      const normalized = users.map((u) => slimAdUser(u));
      const inboundRes = await idp.postInbound(job.runId, normalized);
      inboundSummary = inboundRes.summary ?? '';
      itemsProcessed += Number(inboundRes.inbound?.processed ?? normalized.length);
      itemsSucceeded += Number(inboundRes.inbound?.succeeded ?? normalized.length);
      itemsFailed += Number(inboundRes.inbound?.failed ?? 0);

      // Group sync runs after user import so members can resolve to emp_id
      const groupData = await ldap.collectGroupsForSync(job.syncGroups ?? '');
      if (groupData.errors.length) errors.push(...groupData.errors);
      if (groupData.groups.length) {
        const gs = await idp.postGroups(job.runId, groupData.groups);
        inboundSummary += inboundSummary ? ` | ${gs.summary ?? ''}` : (gs.summary ?? '');
        itemsProcessed += gs.groupsSynced ?? groupData.groups.length;
        itemsSucceeded += gs.groupsSynced ?? groupData.groups.length;
        if (gs.errors?.length) {
          itemsFailed += gs.errors.length;
          errors.push(...gs.errors);
        }
      }
    }

    if (job.runOutbound) {
      const plan = await idp.fetchOutboundPlan(job.runId);
      const results: OutboundResult[] = [];

      for (const action of plan) {
        if (action.action === 'NOOP') {
          results.push({ empId: action.empId, action: 'NOOP', success: true });
          itemsProcessed++;
          itemsSucceeded++;
          continue;
        }

        itemsProcessed++;
        try {
          const result = await executeOutboundAction(ldap, action, job.upnDomain);
          results.push(result);
          if (result.success) itemsSucceeded++;
          else {
            itemsFailed++;
            if (result.error) errors.push(`${action.empId}: ${result.error}`);
          }
        } catch (err) {
          itemsFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${action.empId}: ${msg}`);
          results.push({ empId: action.empId, action: action.action, success: false, error: msg });
        }
      }

      await idp.postOutboundResults(job.runId, results);
    }

    await idp.completeJob(job.runId, {
      itemsProcessed,
      itemsSucceeded,
      itemsFailed,
      inboundSummary,
      errorSummary: errors.length ? errors.slice(0, 8).join('; ') : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await idp.failJob(job.runId, msg).catch(() => undefined);
    throw err;
  } finally {
    await ldap.disconnect().catch(() => undefined);
  }
}

async function executeOutboundAction(
  ldap: AdLdapClient,
  action: OutboundAction,
  jobUpnDomain?: string,
): Promise<OutboundResult> {
  if (action.action === 'DISABLE') {
    const sam = action.externalId?.trim();
    if (!sam) throw new Error('missing externalId for disable');
    await ldap.disableUser(sam);
    return { empId: action.empId, action: 'DISABLE', success: true, externalId: sam };
  }

  if (action.action === 'ENABLE') {
    const sam = action.externalId?.trim();
    if (!sam) throw new Error('missing externalId for enable');
    await ldap.enableUser(sam);
    return { empId: action.empId, action: 'ENABLE', success: true, externalId: sam };
  }

  if (action.action === 'PROVISION') {
    const existing = await ldap.findByEmployeeId(action.empId)
      ?? await ldap.findByEmail(action.emailCorp);
    if (existing) {
      const sam = getAttr(existing, 'sAMAccountName');
      return { empId: action.empId, action: 'LINK', success: true, externalId: sam };
    }

    const sam = await ldap.createUser({
      empId: action.empId,
      fullName: action.fullName,
      emailCorp: action.emailCorp,
      sAMAccountName: action.suggestedSam ?? action.empId.slice(0, 20),
      department: action.deptId ?? undefined,
      title: action.role ?? undefined,
      targetOuRdn: action.provisionOuRdn,
      upnDomain: action.upnDomain ?? jobUpnDomain,
    });
    return { empId: action.empId, action: 'PROVISION', success: true, externalId: sam };
  }

  return { empId: action.empId, action: action.action, success: true };
}

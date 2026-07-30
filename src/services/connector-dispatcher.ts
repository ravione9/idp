/**
 * Connector Dispatcher
 * --------------------
 * Resolves a connector by ID and fires its sync job asynchronously.
 * Returns immediately with a "STARTED" reference — callers poll connector_runs for progress.
 */

import { queryOne } from '../db/connection.js';
import { runAdSync } from './ad-sync.js';
import { runGoogleSync } from './google-sync.js';
import { isConnectorSyncEligible } from './connector-health.js';
import type { SyncResult } from './ad-sync.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ConnectorRunRef {
  runId?: string;
  connectorId: string;
  connectorName: string;
  status: string;
  message?: string;
}

interface ConnectorRow {
  id: string;
  name: string;
  slug: string;
  connector_type: string;
  status: string;
}

// ---------------------------------------------------------------------------
// triggerConnectorSync
// ---------------------------------------------------------------------------
export async function triggerConnectorSync(
  connectorId: string,
  triggeredBy: string,
): Promise<ConnectorRunRef> {
  const connector = await queryOne<ConnectorRow>(
    `SELECT id, name, slug, connector_type, status FROM connectors WHERE id = ?`,
    [connectorId],
  );

  if (!connector) {
    throw new Error('Connector not found');
  }

  if (!isConnectorSyncEligible(connector.status)) {
    throw new Error('Connector is not connected — run Test Connection successfully first');
  }

  logger.info(
    { connectorId, connectorName: connector.name, triggeredBy },
    'Connector sync triggered',
  );

  let syncPromise: Promise<SyncResult>;

  const type = (connector.connector_type || '').toUpperCase();
  const slug = (connector.slug || '').toLowerCase();

  if (type === 'AD' || type === 'LDAP' || slug === 'active-directory') {
    syncPromise = runAdSync(connectorId);
  } else if (
    type === 'GOOGLE'
    || type === 'GOOGLE_WORKSPACE'
    || slug === 'google-workspace'
  ) {
    syncPromise = runGoogleSync(connectorId);
  } else {
    throw new Error(
      `No sync/provisioning handler for connector type: ${connector.connector_type}. `
      + 'Supported: AD, LDAP, GOOGLE / GOOGLE_WORKSPACE.',
    );
  }

  // Fire and forget — callers poll connector_runs for the outcome
  syncPromise.catch((err) =>
    logger.error({ connectorId, err }, 'Connector sync failed'),
  );

  return {
    connectorId,
    connectorName: connector.name,
    status: 'STARTED',
    message: 'Sync initiated asynchronously',
  };
}

/**
 * Connector Dispatcher
 * --------------------
 * Resolves a connector by ID and fires its sync job asynchronously.
 * Returns immediately with a "STARTED" reference — callers poll connector_runs for progress.
 */

import { queryOne } from '../db/connection.js';
import { runAdSync } from './ad-sync.js';
import { runGoogleSync } from './google-sync.js';
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

  if (connector.status !== 'ACTIVE') {
    throw new Error('Connector is not active');
  }

  logger.info(
    { connectorId, connectorName: connector.name, triggeredBy },
    'Connector sync triggered',
  );

  let syncPromise: Promise<SyncResult>;

  if (connector.connector_type === 'LDAP' || connector.slug === 'active-directory') {
    syncPromise = runAdSync(connectorId);
  } else if (connector.connector_type === 'GOOGLE' || connector.slug === 'google-workspace') {
    syncPromise = runGoogleSync(connectorId);
  } else {
    throw new Error(`No sync handler for connector type: ${connector.connector_type}`);
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

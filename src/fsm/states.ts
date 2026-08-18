// =============================================================================
// LILG — FSM States, Transitions and Adapter Operations
// =============================================================================

export enum ILGState {
  ACTIVE            = 'ACTIVE',
  SUSPENDED_AUTO    = 'SUSPENDED_AUTO',
  PENDING_MGR       = 'PENDING_MGR',
  ESCALATED_HRBP    = 'ESCALATED_HRBP',
  REACTIVATED       = 'REACTIVATED',
  SUSPENDED_HR      = 'SUSPENDED_HR',
  DEPARTED          = 'DEPARTED',
  DEPROVISIONED     = 'DEPROVISIONED',
}

export enum HRMSStatus {
  ACTIVE     = 'ACTIVE',
  ON_NOTICE  = 'ON_NOTICE',
  DEPARTED   = 'DEPARTED',
}

export enum EmploymentType {
  CORPORATE = 'CORPORATE',
  STORE     = 'STORE',
  PLANT     = 'PLANT',
  DC        = 'DC',
}

export enum TransitionActor {
  SYSTEM      = 'SYSTEM',
  MANAGER     = 'MANAGER',
  HRBP        = 'HRBP',
  ADMIN       = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum TransitionOrigin {
  HRMS_SYNC = 'HRMS_SYNC',
  LILG      = 'LILG',
  EXTERNAL  = 'EXTERNAL',
}

export enum AdapterOp {
  DISABLE           = 'DISABLE',
  ENABLE            = 'ENABLE',
  DELETE            = 'DELETE',
  REVOKE_TOKENS     = 'REVOKE_TOKENS',
  REVOKE_BINDINGS   = 'REVOKE_BINDINGS',
  LIST_BINDINGS     = 'LIST_BINDINGS',
  TERMINATE_HRMS    = 'TERMINATE_HRMS',
  REINSTATE_HRMS    = 'REINSTATE_HRMS',
  CREATE_USER       = 'CREATE_USER',
  UPDATE_USER       = 'UPDATE_USER',
}

// ---------------------------------------------------------------------------
// Valid state transitions
// ---------------------------------------------------------------------------
export const VALID_TRANSITIONS: Record<ILGState, ILGState[]> = {
  [ILGState.ACTIVE]: [
    ILGState.SUSPENDED_AUTO,
    ILGState.SUSPENDED_HR,
    ILGState.DEPARTED,
    ILGState.PENDING_MGR,
  ],
  [ILGState.SUSPENDED_AUTO]: [
    ILGState.ACTIVE,
    ILGState.PENDING_MGR,
    ILGState.REACTIVATED,
    ILGState.SUSPENDED_HR,
    ILGState.ESCALATED_HRBP,
    ILGState.DEPROVISIONED,
  ],
  [ILGState.PENDING_MGR]: [
    ILGState.REACTIVATED,
    ILGState.ESCALATED_HRBP,
    ILGState.SUSPENDED_HR,
  ],
  [ILGState.ESCALATED_HRBP]: [
    ILGState.REACTIVATED,
    ILGState.SUSPENDED_HR,
    ILGState.DEPARTED,
  ],
  [ILGState.REACTIVATED]: [
    ILGState.ACTIVE,
    ILGState.SUSPENDED_AUTO,
    ILGState.SUSPENDED_HR,
    ILGState.DEPARTED,
  ],
  [ILGState.SUSPENDED_HR]: [
    ILGState.REACTIVATED,
    ILGState.DEPARTED,
    ILGState.DEPROVISIONED,
  ],
  [ILGState.DEPARTED]: [
    ILGState.DEPROVISIONED,
    // Edge case: HRMS correction reverting a departure
    ILGState.ACTIVE,
  ],
  [ILGState.DEPROVISIONED]: [
    // Terminal state — no further transitions allowed
  ],
};

// ---------------------------------------------------------------------------
// Portal access — login and Universal Directory visibility
// ---------------------------------------------------------------------------
export const PORTAL_ACCESSIBLE_STATES: readonly ILGState[] = [
  ILGState.ACTIVE,
  ILGState.REACTIVATED,
];

export function isPortalAccessible(state: string): boolean {
  return (PORTAL_ACCESSIBLE_STATES as readonly string[]).includes(state);
}

// ---------------------------------------------------------------------------
// Validate a transition
// ---------------------------------------------------------------------------
export function isValidTransition(from: ILGState, to: ILGState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Determine which adapter operations to enqueue for a target state
// ---------------------------------------------------------------------------
export function getOutboxOpsForTransition(to: ILGState): AdapterOp[] {
  switch (to) {
    case ILGState.SUSPENDED_AUTO:
    case ILGState.PENDING_MGR:
      // Soft-suspend: disable accounts and revoke active sessions
      return [AdapterOp.DISABLE, AdapterOp.REVOKE_TOKENS];

    case ILGState.ESCALATED_HRBP:
      // Keep suspended, snapshot current bindings for audit
      return [AdapterOp.DISABLE, AdapterOp.REVOKE_TOKENS, AdapterOp.LIST_BINDINGS];

    case ILGState.SUSPENDED_HR:
      // Hard-suspend: revoke bindings (group memberships, roles)
      return [AdapterOp.DISABLE, AdapterOp.REVOKE_TOKENS, AdapterOp.REVOKE_BINDINGS];

    case ILGState.REACTIVATED:
    case ILGState.ACTIVE:
      // Re-enable and let tokens be refreshed on next login
      return [AdapterOp.ENABLE];

    case ILGState.DEPARTED:
      // Signal HRMS official termination, disable all adapters
      return [AdapterOp.DISABLE, AdapterOp.REVOKE_TOKENS, AdapterOp.REVOKE_BINDINGS, AdapterOp.TERMINATE_HRMS];

    case ILGState.DEPROVISIONED:
      // Full deletion from all systems
      return [AdapterOp.REVOKE_BINDINGS, AdapterOp.DELETE];

    default:
      return [];
  }
}

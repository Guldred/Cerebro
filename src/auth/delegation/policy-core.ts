import { authorizeAction, type Args } from '../../totem-sdk';
import type { DelegationContext } from '../identity.types';

export interface DelegatedActionContext {
  /** Totem command path for the call, e.g. `/cerebro/search`. */
  cmd: string;
  /** Concrete invocation args (evaluated against the grant's scalar policy). */
  args?: Args;
  /** Source systems the call will touch (for the sources_allow over-scope check). */
  sourceSystems?: string[];
}

export interface DelegatedActionDecision {
  ok: boolean;
  reasons: string[];
}

/**
 * The ONE delegated-action policy core (docs/Totem_Integration.md §4): command
 * narrowing + scalar policy (via the SDK's `authorizeAction`) plus the
 * `sources_allow` over-scope check. BOTH the RetrievalService enforcement point
 * AND the Phase-2 MCP PDP call THIS — there is no second policy implementation
 * (hard invariant #1: no separate, bypassable path). Principal-set narrowing is
 * applied only at the SQL pre-filter, so it is not part of this allow/deny
 * decision — it cannot leak, only further restrict.
 */
export function decideDelegatedAction(
  delegation: Pick<DelegationContext, 'grant' | 'sourcesAllow'>,
  action: DelegatedActionContext,
): DelegatedActionDecision {
  const reasons = [...authorizeAction(delegation.grant, { cmd: action.cmd, args: action.args }).reasons];

  if (
    delegation.sourcesAllow &&
    delegation.sourcesAllow.length > 0 &&
    action.sourceSystems &&
    action.sourceSystems.length > 0
  ) {
    // An explicit request for ONLY disallowed sources is over-scope.
    const allow = new Set(delegation.sourcesAllow);
    if (!action.sourceSystems.some((s) => allow.has(s))) {
      reasons.push('delegation/source-not-allowed');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

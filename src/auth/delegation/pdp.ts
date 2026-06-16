import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, CerebroConfig } from '../../config/config';
import { CallerIdentity } from '../identity.types';
import { LocalAppendOnlyAnchor } from './local-anchor';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { decideDelegatedAction, DelegatedActionContext } from './policy-core';

export type PdpDecisionKind = 'allow' | 'deny' | 'needs-approval';

/** AARP-style prerequisite: what must be satisfied before this can be authorized. */
export interface PdpPrerequisite {
  type: 'membership-reverification' | 'consent';
  sourceSystem?: string;
  message: string;
}

export interface PdpDecision {
  decision: PdpDecisionKind;
  reasons: string[];
  prerequisites?: PdpPrerequisite[];
}

/**
 * Phase-2 Policy Decision Point (docs/Totem_Integration.md §11). Runs at the
 * SINGLE MCP tool choke point, per call, BEFORE retrieval, when
 * DELEGATION_PDP_ENABLED. It only ADDS an earlier, structured decision —
 * RetrievalService's SQL pre-filter stays the ultimate fail-closed backstop, so
 * PDP-off changes nothing and PDP-on can only deny earlier (never widen).
 *
 * Net-new vs Phase 1: (a) a structured allow / deny / needs-approval at the
 * boundary with the tool + args in hand, and (b) the sensitive-source
 * late-binding membership re-check with an AuthZEN-AARP step-up. Token freshness
 * and delegation revocation are ALREADY re-checked per MCP call in Phase 1; the
 * PDP re-confirms revocation only as cheap defense-in-depth.
 */
@Injectable()
export class PolicyDecisionPoint {
  constructor(
    @Inject(CONFIG) private readonly config: CerebroConfig,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    private readonly anchor: LocalAppendOnlyAnchor,
  ) {}

  async decide(identity: CallerIdentity, action: DelegatedActionContext): Promise<PdpDecision> {
    const d = identity.delegation;
    // Non-delegated callers are not subject to the delegation PDP — their access
    // is the plain ACL path, unchanged.
    if (!d) return { decision: 'allow', reasons: [] };

    // 1. Defense-in-depth revocation re-confirm (already enforced per call at
    //    identity resolution; cheap to re-affirm here with the action in hand).
    const reasons: string[] = [];
    if (d.delegationId) {
      const status = await this.anchor.isRevoked(identity.subject, d.delegationId);
      if (status.revoked) reasons.push('delegation/revoked');
    }

    // 2. Action scope — the SAME policy core RetrievalService uses.
    reasons.push(...decideDelegatedAction(d, action).reasons);
    if (reasons.length > 0) return this.record(identity, action, { decision: 'deny', reasons });

    // 3. Sensitive-source late-binding membership re-check (+ AARP step-up).
    const prerequisites: PdpPrerequisite[] = [];
    for (const source of this.sensitiveTouched(action)) {
      const status = await this.membership.check(identity, source);
      if (status === 'revoked') {
        reasons.push(`delegation/membership-revoked:${source}`);
      } else if (status === 'unknown') {
        prerequisites.push({
          type: 'membership-reverification',
          sourceSystem: source,
          message:
            `Live membership for sensitive source "${source}" could not be confirmed — ` +
            `step-up re-verification required before access.`,
        });
      }
    }
    if (reasons.length > 0) return this.record(identity, action, { decision: 'deny', reasons });
    if (prerequisites.length > 0) {
      return this.record(identity, action, {
        decision: 'needs-approval',
        reasons: prerequisites.map((p) => `needs:${p.type}`),
        prerequisites,
      });
    }
    return this.record(identity, action, { decision: 'allow', reasons: [] });
  }

  /** Configured sensitive sources this call could actually touch. */
  private sensitiveTouched(action: DelegatedActionContext): string[] {
    const sensitive = this.config.delegation.sensitiveSources;
    if (sensitive.length === 0) return [];
    // A scoped call touches the intersection; an unscoped call could touch ANY.
    return action.sourceSystems && action.sourceSystems.length > 0
      ? action.sourceSystems.filter((s) => sensitive.includes(s))
      : [...sensitive];
  }

  private async record(
    identity: CallerIdentity,
    action: DelegatedActionContext,
    decision: PdpDecision,
  ): Promise<PdpDecision> {
    const digest = createHash('sha256').update(JSON.stringify(action.args ?? {})).digest('hex');
    await this.anchor.record({
      ts: new Date().toISOString(),
      subject: identity.subject,
      actor: identity.delegation?.agent,
      action: action.cmd,
      argsDigest: `sha256:${digest}`,
      decision: decision.decision,
      reasons: decision.reasons,
      delegationId: identity.delegation?.delegationId,
    });
    return decision;
  }
}

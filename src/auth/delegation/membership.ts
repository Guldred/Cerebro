import { Injectable } from '@nestjs/common';
import type { CallerIdentity } from '../identity.types';

export type MembershipStatus = 'confirmed' | 'revoked' | 'unknown';

export const MEMBERSHIP_CHECKER = Symbol('MEMBERSHIP_CHECKER');

/**
 * Late-binding, call-time membership oracle for sensitive sources
 * (docs/Totem_Integration.md §11, Phase 2).
 *
 * HONEST SCOPE — read this before assuming it adds freshness. Cerebro's
 * `principal_mappings` is ALREADY read live on every query
 * (`PRINCIPAL_MAPPING_CACHE_TTL_MS=0`), and the caller's Entra membership comes
 * from the per-call token — both are already call-time fresh. The ONLY stale
 * layer is the CHUNK's source ACL (`acl_principals`), captured at ingest and
 * refreshed only by `acl:refresh`. Truly closing that window means re-resolving
 * the document's permissions from the SOURCE at call time — connector-specific
 * and key-gated.
 *
 * So the default below does NOT pretend to confirm what it cannot: it returns
 * `unknown` for any sensitive source, and the PDP maps `unknown` → a
 * needs-approval step-up (AARP) and `revoked` → deny. Wire a connector-backed
 * checker (with source credentials) to get real call-time confirmation; that is
 * the piece that actually closes the chunk-ACL window.
 */
export interface MembershipChecker {
  /** Is `identity` still entitled to `sourceSystem` RIGHT NOW? */
  check(identity: CallerIdentity, sourceSystem: string): Promise<MembershipStatus>;
}

/** The honest default: no live source oracle, so membership is `unknown` → step up. */
@Injectable()
export class UnverifiedMembershipChecker implements MembershipChecker {
  async check(_identity: CallerIdentity, _sourceSystem: string): Promise<MembershipStatus> {
    return 'unknown';
  }
}

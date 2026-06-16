import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { decodeJwt } from 'jose';
import { CONFIG, CerebroConfig } from '../config/config';
import { DELEGATION_VERIFIER, DelegationVerifier } from './delegation/delegation-verifier';
import {
  ALL_USERS_PRINCIPAL,
  CallerIdentity,
  ENTRA_GROUP_PREFIX,
  ENTRA_USER_PREFIX,
  IdentityError,
} from './identity.types';
import { OidcTokenVerifier, TokenVerifier } from './token-verifier';

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** What the transport layer hands over for identity resolution. */
export interface IdentityInput {
  /** `Authorization: Bearer <jwt>` header value (oidc modes). */
  authorization?: string;
  /** x-cerebro-principals header value (dev-header mode ONLY). */
  devHeader?: string;
}

/**
 * The SOLE minting point for CallerIdentity (Plan_Review P1.2). Every consumer
 * path — REST guard, MCP tool call, eval harness — funnels through resolve(),
 * so there is exactly one place where "who is asking" is decided.
 *
 * Fail-closed semantics per mode:
 *   oidc / local-oidc — no token, bad token, or groups overage → IdentityError
 *                       (mapped to 401/403). The dev header is NEVER read.
 *   dev-header        — the MVP stub: principals come from the header verbatim;
 *                       no header → empty principals (public-only retrieval).
 */
@Injectable()
export class IdentityService {
  private readonly log = new Logger(IdentityService.name);
  private readonly verifier: TokenVerifier;

  constructor(
    @Inject(CONFIG) private readonly config: CerebroConfig,
    @Optional() @Inject(TOKEN_VERIFIER) verifier?: TokenVerifier,
    @Optional() @Inject(DELEGATION_VERIFIER) private readonly delegationVerifier?: DelegationVerifier,
  ) {
    this.verifier = verifier ?? new OidcTokenVerifier(config.auth);
  }

  async resolve(input: IdentityInput): Promise<CallerIdentity> {
    if (this.config.auth.mode === 'dev-header') {
      return this.fromDevHeader(input.devHeader);
    }
    // Delegation OFF (default) ⇒ the existing path runs UNCHANGED — backward compat.
    if (!this.config.delegation?.enabled) {
      return this.fromBearer(input.authorization);
    }
    return this.fromBearerRoutingDelegation(input.authorization);
  }

  /**
   * oidc-mode resolution with delegation ENABLED: route by token shape. A token
   * carrying an `act` claim is verified against the DELEGATION trust root and
   * yields a delegated identity; a plain OIDC token takes the existing path —
   * unless DELEGATION_REQUIRE makes a delegated token mandatory.
   */
  private async fromBearerRoutingDelegation(authorization?: string): Promise<CallerIdentity> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      throw new IdentityError('TOKEN_MISSING', 'Authorization: Bearer <token> is required');
    }
    let isDelegated = false;
    try {
      // Unverified decode for ROUTING ONLY — the chosen path then fully verifies.
      isDelegated = (decodeJwt(token) as { act?: unknown }).act !== undefined;
    } catch {
      // Not a decodable JWT — fall through to fromBearer, which raises TOKEN_INVALID.
    }
    if (isDelegated) return this.fromDelegatedBearer(token);
    if (this.config.delegation?.require) {
      throw new IdentityError(
        'DELEGATION_REQUIRED',
        'DELEGATION_REQUIRE=true: a delegated token (with an act claim) is required',
      );
    }
    return this.fromBearer(authorization);
  }

  private async fromDelegatedBearer(token: string): Promise<CallerIdentity> {
    if (!this.delegationVerifier) {
      // Enabled in config but not wired — fail closed rather than silently allow.
      throw new IdentityError('TOKEN_INVALID', 'delegation enabled but no delegation verifier is configured');
    }
    const result = await this.delegationVerifier.verifyToken(token);
    if (!result.ok || !result.delegated || !result.human) {
      throw new IdentityError(
        'TOKEN_INVALID',
        `Delegated token rejected: ${result.reasons.join(', ') || 'no human identity'}`,
      );
    }
    const h = result.human;
    // Entitlement is the HUMAN's — exactly as fromBearer. Delegation only narrows.
    return {
      subject: h.oid,
      principals: [
        `${ENTRA_USER_PREFIX}${h.oid}`,
        ...h.groups.map((g) => `${ENTRA_GROUP_PREFIX}${g}`),
        ALL_USERS_PRINCIPAL,
      ],
      mode: this.config.auth.mode as 'oidc' | 'local-oidc',
      delegation: {
        agent: result.agent ?? 'unknown',
        scope: result.scope,
        grant: result.grant,
        principalsAllow: result.principalsAllow,
        sourcesAllow: result.sourcesAllow,
        delegationId: result.delegationId,
      },
    };
  }

  private async fromBearer(authorization?: string): Promise<CallerIdentity> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      throw new IdentityError('TOKEN_MISSING', 'Authorization: Bearer <token> is required');
    }
    const claims = await this.verifier.verify(token);

    if (claims.hasOverage) {
      // A partial group set is indistinguishable from a lookup failure. The
      // invariant is "no resolved groups → empty result"; the deterministic
      // form of that is a hard 403. A Graph-backed GroupResolver is the
      // documented escape hatch when a tenant actually hits this.
      throw new IdentityError(
        'GROUPS_UNRESOLVED',
        'Token signals groups overage; the full group set cannot be resolved offline',
      );
    }

    return {
      subject: claims.oid,
      principals: [
        `${ENTRA_USER_PREFIX}${claims.oid}`,
        ...claims.groups.map((g) => `${ENTRA_GROUP_PREFIX}${g}`),
        ALL_USERS_PRINCIPAL,
      ],
      mode: this.config.auth.mode as 'oidc' | 'local-oidc',
    };
  }

  /** MVP stub, isolated here. Seed-demo principals pass through verbatim. */
  private fromDevHeader(header?: string): CallerIdentity {
    const principals = (header ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      subject: principals[0] ?? 'anonymous',
      principals,
      mode: 'dev-header',
    };
  }
}

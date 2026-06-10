import { promises as fs } from 'fs';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  JWTPayload,
  JSONWebKeySet,
} from 'jose';
import { CerebroConfig } from '../config/config';
import { IdentityError } from './identity.types';

/** The Entra-shaped claims IdentityService consumes. */
export interface VerifiedClaims {
  /** Entra object id of the user. */
  oid: string;
  /** Transitive security-group object ids (Entra emits them directly in v2
   *  access tokens — no Graph call needed for nesting). */
  groups: string[];
  /** True when the token signals groups overage (claim omitted because the
   *  user is in too many groups) — the group set is NOT complete. */
  hasOverage: boolean;
}

export interface TokenVerifier {
  verify(jwt: string): Promise<VerifiedClaims>;
}

type KeyGetter = Parameters<typeof jwtVerify>[1];

/**
 * OIDC bearer-token validation with jose (Plan_Review P1.2). The SAME verifier
 * runs in production (remote JWKS) and CI/local (JWKS file with locally
 * generated keys) — only the trust-root source differs, selected by AUTH_MODE,
 * never by env-var precedence. Algorithms are pinned to RS256, which kills
 * alg:none and HS256 key-confusion outright.
 */
export class OidcTokenVerifier implements TokenVerifier {
  private keyGetter: KeyGetter | null = null;

  constructor(private readonly auth: CerebroConfig['auth']) {}

  async verify(jwt: string): Promise<VerifiedClaims> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(jwt, await this.getKeyGetter(), {
        issuer: this.auth.issuer,
        audience: this.auth.audience,
        algorithms: ['RS256'],
        clockTolerance: this.auth.clockToleranceS,
      });
      payload = result.payload;
    } catch (err) {
      throw new IdentityError('TOKEN_INVALID', `Bearer token rejected: ${String(err)}`);
    }
    return this.toClaims(payload);
  }

  private toClaims(payload: JWTPayload): VerifiedClaims {
    const oid = payload.oid;
    if (typeof oid !== 'string' || oid.length === 0) {
      throw new IdentityError('TOKEN_INVALID', 'Token has no oid claim');
    }

    // Entra overage markers: `hasgroups: true` or `_claim_names.groups`
    // mean the groups claim was omitted — the token does NOT carry the full set.
    const claimNames = payload._claim_names as Record<string, unknown> | undefined;
    const hasOverage = payload.hasgroups === true || claimNames?.groups !== undefined;

    const raw = payload[this.auth.groupsClaim];
    const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : [];

    return { oid, groups, hasOverage };
  }

  /** Lazily build the key getter; local-oidc reads the JWKS file fresh once. */
  private async getKeyGetter(): Promise<KeyGetter> {
    if (this.keyGetter) return this.keyGetter;
    if (this.auth.mode === 'oidc') {
      this.keyGetter = createRemoteJWKSet(new URL(this.auth.jwksUrl));
    } else {
      const jwks = JSON.parse(await fs.readFile(this.auth.jwksFile, 'utf8')) as JSONWebKeySet;
      this.keyGetter = createLocalJWKSet(jwks);
    }
    return this.keyGetter;
  }
}

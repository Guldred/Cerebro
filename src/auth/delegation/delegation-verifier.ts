import { promises as fs } from 'fs';
import { createLocalJWKSet, createRemoteJWKSet, type JSONWebKeySet } from 'jose';
import { CerebroConfig } from '../../config/config';
import {
  verifyDelegationToken,
  type DelegationResult,
  type KeyInput,
  type RevocationRegistry,
} from '../../totem-sdk';

export const DELEGATION_VERIFIER = Symbol('DELEGATION_VERIFIER');

/** Stage-1 delegation verification (no action) — wired into IdentityService. */
export interface DelegationVerifier {
  verifyToken(token: string): Promise<DelegationResult>;
}

/**
 * JOSE-backed delegation verifier. Mirrors OidcTokenVerifier exactly — the SAME
 * validation Cerebro already trusts — but against the DELEGATION trust root
 * (config.delegation): remote JWKS in production, a local JWKS file in
 * dev/local/CI, selected by which is configured (never by env-var precedence).
 * Algorithms are pinned (RS256/EdDSA). Revocation reads route through the
 * injected registry (the AttestationAnchor), fail-closed.
 */
export class JoseDelegationVerifier implements DelegationVerifier {
  private keyGetter: KeyInput | null = null;

  constructor(
    private readonly cfg: CerebroConfig['delegation'],
    private readonly registry?: RevocationRegistry,
  ) {}

  async verifyToken(token: string): Promise<DelegationResult> {
    return verifyDelegationToken(token, {
      keys: await this.getKeyGetter(),
      issuer: this.cfg.issuer,
      audience: this.cfg.audience,
      algorithms: ['RS256', 'EdDSA'],
      maxTtlS: this.cfg.maxTtlS,
      registry: this.registry,
    });
  }

  /** Lazily build the key getter; local mode reads the JWKS file fresh once. */
  private async getKeyGetter(): Promise<KeyInput> {
    if (this.keyGetter) return this.keyGetter;
    if (this.cfg.jwksUrl) {
      this.keyGetter = createRemoteJWKSet(new URL(this.cfg.jwksUrl));
    } else {
      const jwks = JSON.parse(await fs.readFile(this.cfg.jwksFile, 'utf8')) as JSONWebKeySet;
      this.keyGetter = createLocalJWKSet(jwks);
    }
    return this.keyGetter;
  }
}

import { SignJWT, exportJWK, generateKeyPair, JSONWebKeySet } from 'jose';
import { mintDelegation, type DelegationGrant } from '../../totem-sdk';

/**
 * Offline Entra-shaped token mint for tests, the eval harness and the
 * auth:dev-jwks script. Generates an RS256 keypair, exposes its public JWKS
 * (write it to a file and point AUTH_OIDC_JWKS_FILE at it), and signs tokens
 * the REAL OidcTokenVerifier validates — every production branch (iss, aud,
 * exp, alg, kid, signature) runs for real with zero network.
 */
export interface LocalIdp {
  jwks: JSONWebKeySet;
  issuer: string;
  audience: string;
  signToken(claims: {
    oid?: string;
    groups?: string[];
    hasgroups?: boolean;
    claimNames?: Record<string, unknown>;
    /** Override iss/aud or add/remove arbitrary claims for negative tests. */
    overrides?: Record<string, unknown>;
    /** Timespan string ('10m'), absolute epoch seconds (for expired tokens),
     *  or 'none' to OMIT exp entirely (negative test for requiredClaims). */
    expiresIn?: string | number | 'none';
  }): Promise<string>;
  /**
   * Sign a DELEGATED token (RFC 8693 actor shape) with this IdP's key — the
   * delegation trust root in tests/eval. Same issuer/audience/key as signToken,
   * so one local IdP can be both the OIDC and the delegation trust root.
   */
  signDelegation(opts: {
    humanOid: string;
    groups?: string[];
    agent: string;
    grant: DelegationGrant;
    scope?: string;
    expiresInS?: number;
    jti?: string;
    /** Injectable clock (Unix seconds) — set in the past to mint an expired token. */
    nowS?: number;
  }): Promise<string>;
}

export async function createLocalIdp(
  issuer = 'https://login.microsoftonline.com/local-test-tenant/v2.0',
  audience = 'api://cerebro-local',
): Promise<LocalIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'local-test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  return {
    jwks: { keys: [jwk] },
    issuer,
    audience,
    async signToken({ oid = 'user-0000', groups, hasgroups, claimNames, overrides, expiresIn = '10m' }) {
      const payload: Record<string, unknown> = { oid };
      if (groups !== undefined) payload.groups = groups;
      if (hasgroups !== undefined) payload.hasgroups = hasgroups;
      if (claimNames !== undefined) payload._claim_names = claimNames;
      Object.assign(payload, overrides);

      const builder = new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
        .setIssuer((overrides?.iss as string) ?? issuer)
        .setAudience((overrides?.aud as string) ?? audience)
        .setIssuedAt();
      if (expiresIn !== 'none') builder.setExpirationTime(expiresIn);
      return builder.sign(privateKey);
    },
    async signDelegation({ humanOid, groups, agent, grant, scope, expiresInS, jti, nowS }) {
      return mintDelegation({
        signKey: privateKey,
        alg: 'RS256',
        kid: 'local-test-key',
        issuer,
        audience,
        humanOid,
        groups,
        agent,
        grant,
        scope,
        expiresInS,
        jti,
        nowS,
      });
    },
  };
}

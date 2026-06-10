import { SignJWT, exportJWK, generateKeyPair, JSONWebKeySet } from 'jose';

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
  };
}

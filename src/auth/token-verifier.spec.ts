import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SignJWT } from 'jose';
import { CerebroConfig } from '../config/config';
import { IdentityError } from './identity.types';
import { OidcTokenVerifier } from './token-verifier';
import { createLocalIdp, LocalIdp } from './testing/token-factory';

/**
 * Verifier rejection suite (Phase-2 exit gate). The SAME OidcTokenVerifier runs
 * in production; here it validates against a local JWKS file, so every branch —
 * signature, issuer, audience, exp, alg pinning, kid lookup — is pinned offline.
 */
describe('OidcTokenVerifier', () => {
  let idp: LocalIdp;
  let rogue: LocalIdp; // second IdP: same shape, different keys → unknown kid / bad signature
  let verifier: OidcTokenVerifier;

  beforeAll(async () => {
    idp = await createLocalIdp();
    rogue = await createLocalIdp();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebro-verifier-spec-'));
    const jwksFile = path.join(dir, 'jwks.json');
    await fs.writeFile(jwksFile, JSON.stringify(idp.jwks));

    const auth: CerebroConfig['auth'] = {
      mode: 'local-oidc',
      issuer: idp.issuer,
      audience: idp.audience,
      jwksUrl: '',
      jwksFile,
      clockToleranceS: 5,
      groupsClaim: 'groups',
    };
    verifier = new OidcTokenVerifier(auth);
  });

  it('accepts a valid token and extracts oid + transitive groups', async () => {
    const token = await idp.signToken({ oid: 'u-1', groups: ['g-1', 'g-2'] });
    await expect(verifier.verify(token)).resolves.toEqual({
      oid: 'u-1',
      groups: ['g-1', 'g-2'],
      hasOverage: false,
    });
  });

  it('rejects a token signed by an unknown key (kid not in the JWKS)', async () => {
    const token = await rogue.signToken({ oid: 'u-1' });
    await expect(verifier.verify(token)).rejects.toThrow(IdentityError);
  });

  it('rejects a tampered payload (signature mismatch)', async () => {
    const token = await idp.signToken({ oid: 'u-1', groups: [] });
    const [h, payload, sig] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    decoded.groups = ['entra-admins']; // privilege-escalation attempt
    const forged = [h, Buffer.from(JSON.stringify(decoded)).toString('base64url'), sig].join('.');
    await expect(verifier.verify(forged)).rejects.toThrow(IdentityError);
  });

  it('rejects a wrong issuer', async () => {
    const token = await idp.signToken({ oid: 'u-1', overrides: { iss: 'https://evil.example' } });
    await expect(verifier.verify(token)).rejects.toThrow(IdentityError);
  });

  it('rejects a wrong audience', async () => {
    const token = await idp.signToken({ oid: 'u-1', overrides: { aud: 'api://other-app' } });
    await expect(verifier.verify(token)).rejects.toThrow(IdentityError);
  });

  it('rejects an expired token (beyond clock tolerance)', async () => {
    const token = await idp.signToken({
      oid: 'u-1',
      expiresIn: Math.floor(Date.now() / 1000) - 600,
    });
    await expect(verifier.verify(token)).rejects.toThrow(IdentityError);
  });

  it('rejects HS256 key-confusion (HMAC-signed token, algorithms pinned to RS256)', async () => {
    // Attacker signs with a symmetric secret hoping the verifier accepts HS256.
    const secret = new TextEncoder().encode('a'.repeat(32));
    const token = await new SignJWT({ oid: 'u-1' })
      .setProtectedHeader({ alg: 'HS256', kid: 'local-test-key' })
      .setIssuer(idp.issuer)
      .setAudience(idp.audience)
      .setExpirationTime('10m')
      .sign(secret);
    await expect(verifier.verify(token)).rejects.toThrow(IdentityError);
  });

  it('rejects a token with no oid claim', async () => {
    // overrides with undefined removes the claim (JSON serialization drops it)
    const stripped = await idp.signToken({ overrides: { oid: undefined } });
    await expect(verifier.verify(stripped)).rejects.toThrow('no oid claim');
  });

  it('flags groups overage via hasgroups:true', async () => {
    const token = await idp.signToken({ oid: 'u-1', hasgroups: true });
    await expect(verifier.verify(token)).resolves.toMatchObject({ hasOverage: true });
  });

  it('flags groups overage via _claim_names.groups', async () => {
    const token = await idp.signToken({
      oid: 'u-1',
      claimNames: { groups: 'src1' },
    });
    await expect(verifier.verify(token)).resolves.toMatchObject({ hasOverage: true });
  });
});

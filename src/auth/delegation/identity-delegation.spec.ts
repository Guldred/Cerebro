import { CerebroConfig } from '../../config/config';
import { IdentityService } from '../identity.service';
import { TokenVerifier, VerifiedClaims } from '../token-verifier';
import { DelegationVerifier } from './delegation-verifier';
import type { DelegationResult } from '../../totem-sdk';

/**
 * IdentityService delegation routing. Uses fake OIDC + delegation verifiers, so
 * no real keys are needed — the routing logic and the fail-closed denials are
 * pinned offline. Real JOSE verification is covered by the totem-sdk suite.
 */
const b64url = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
// decodeJwt only base64-decodes the payload (no verification) — a fake JWT suffices for routing.
const fakeJwt = (payload: object): string => `${b64url({ alg: 'RS256' })}.${b64url(payload)}.sig`;

function configFor(over: Partial<CerebroConfig['delegation']> & { enabled: boolean }): CerebroConfig {
  return {
    auth: { mode: 'oidc' },
    delegation: {
      require: false,
      issuer: 'https://totem.local/v2.0',
      audience: 'api://cerebro',
      jwksUrl: '',
      jwksFile: '',
      maxTtlS: 300,
      auditBackend: 'local',
      pdpEnabled: false,
      sensitiveSources: [],
      ...over,
    },
  } as unknown as CerebroConfig;
}

const fakeOidc = (claims: VerifiedClaims): TokenVerifier => ({ verify: jest.fn(async () => claims) });
const fakeDelegation = (result: DelegationResult): DelegationVerifier => ({
  verifyToken: jest.fn(async () => result),
});

const HUMAN_RESULT: DelegationResult = {
  ok: true,
  reasons: [],
  delegated: true,
  human: { oid: 'human-1', sub: 'human-1', groups: ['hr'] },
  agent: 'agent:x',
  scope: 'cerebro.search',
  grant: { cmd: '/cerebro/search', pol: [] },
  principalsAllow: ['entra-group:hr'],
  sourcesAllow: ['confluence'],
  delegationId: 'jti-1',
};

const OIDC_CLAIMS: VerifiedClaims = { oid: 'human-2', groups: [], hasOverage: false };

describe('IdentityService delegation routing', () => {
  it('delegation OFF: a token carrying act still takes the plain OIDC path (backward compatible)', async () => {
    const dv = fakeDelegation(HUMAN_RESULT);
    const svc = new IdentityService(configFor({ enabled: false }), fakeOidc(OIDC_CLAIMS), dv);
    const id = await svc.resolve({
      authorization: `Bearer ${fakeJwt({ act: { sub: 'agent:x' }, oid: 'human-2' })}`,
    });
    expect(id.delegation).toBeUndefined();
    expect(dv.verifyToken).not.toHaveBeenCalled();
    expect(id.principals).toContain('entra-user:human-2');
  });

  it('delegation ON + act token: delegated identity = HUMAN principals + delegation context', async () => {
    const dv = fakeDelegation(HUMAN_RESULT);
    const svc = new IdentityService(configFor({ enabled: true }), fakeOidc(OIDC_CLAIMS), dv);
    const id = await svc.resolve({
      authorization: `Bearer ${fakeJwt({ act: { sub: 'agent:x' }, oid: 'human-1' })}`,
    });
    expect(dv.verifyToken).toHaveBeenCalled();
    expect(id.subject).toBe('human-1');
    expect(id.principals).toEqual(['entra-user:human-1', 'entra-group:hr', 'all-users']);
    expect(id.delegation?.agent).toBe('agent:x');
    expect(id.delegation?.grant?.cmd).toBe('/cerebro/search');
    expect(id.delegation?.sourcesAllow).toEqual(['confluence']);
  });

  it('delegation ON + plain token + require=false: plain OIDC path (no delegation context)', async () => {
    const svc = new IdentityService(
      configFor({ enabled: true, require: false }),
      fakeOidc(OIDC_CLAIMS),
      fakeDelegation(HUMAN_RESULT),
    );
    const id = await svc.resolve({ authorization: `Bearer ${fakeJwt({ oid: 'human-2' })}` });
    expect(id.delegation).toBeUndefined();
    expect(id.subject).toBe('human-2');
  });

  it('delegation ON + plain token + require=true: DELEGATION_REQUIRED', async () => {
    const svc = new IdentityService(
      configFor({ enabled: true, require: true }),
      fakeOidc(OIDC_CLAIMS),
      fakeDelegation(HUMAN_RESULT),
    );
    await expect(
      svc.resolve({ authorization: `Bearer ${fakeJwt({ oid: 'human-2' })}` }),
    ).rejects.toMatchObject({ code: 'DELEGATION_REQUIRED' });
  });

  it('delegation ON + act token but verifier denies → TOKEN_INVALID (fail-closed)', async () => {
    const denied: DelegationResult = {
      ok: false,
      reasons: ['delegation/revoked'],
      delegated: true,
      human: { oid: 'human-1', groups: [] },
    };
    const svc = new IdentityService(configFor({ enabled: true }), fakeOidc(OIDC_CLAIMS), fakeDelegation(denied));
    await expect(
      svc.resolve({ authorization: `Bearer ${fakeJwt({ act: { sub: 'a' }, oid: 'human-1' })}` }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('delegation ON but no verifier wired + act token → fails closed (TOKEN_INVALID)', async () => {
    const svc = new IdentityService(configFor({ enabled: true }), fakeOidc(OIDC_CLAIMS));
    await expect(
      svc.resolve({ authorization: `Bearer ${fakeJwt({ act: { sub: 'a' }, oid: 'human-1' })}` }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});

import { generateKeyPair, type KeyLike } from 'jose';
import { mintDelegation } from './mint';
import { authorizeAction, verifyDelegation, verifyDelegationToken } from './verify';
import { commandPermits, normalizeCommand } from './command';
import { evaluatePolicy } from './policy';
import type { DelegationGrant, NonceStore, RevocationRegistry, RevocationStatus } from './types';

/**
 * @dreamshare/totem-sdk unit suite. Exercises the real JOSE sign/verify path
 * plus every fail-closed branch of the lifted attenuation logic. No DB, no
 * network — the same keys sign and verify in-process.
 */
describe('totem-sdk', () => {
  const ISSUER = 'https://totem-mint.local/v2.0';
  const AUDIENCE = 'api://cerebro-local';
  let publicKey: KeyLike;
  let privateKey: KeyLike;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('RS256'));
  });

  // Grant policy uses SCALAR predicates (the faithful Totem lift). Array-subset
  // narrowing of sourceSystems / principals is a Cerebro enforcement concern
  // (a set intersection), not a single `pol` predicate — see Totem_Integration §4.
  const baseGrant: DelegationGrant = {
    cmd: '/cerebro/search',
    pol: [['<=', '.topK', 10]],
  };

  async function mint(over: Partial<Parameters<typeof mintDelegation>[0]> = {}) {
    return mintDelegation({
      signKey: privateKey,
      kid: 'k1',
      issuer: ISSUER,
      audience: AUDIENCE,
      humanOid: 'human-1',
      groups: ['entra-group:hr'],
      agent: 'agent:acme-copilot/instance-7',
      grant: baseGrant,
      scope: 'cerebro.search',
      ...over,
    });
  }

  const verifyOpts = (over: Partial<Parameters<typeof verifyDelegation>[1]> = {}) => ({
    keys: publicKey,
    issuer: ISSUER,
    audience: AUDIENCE,
    action: { cmd: '/cerebro/search', args: { topK: 5 } },
    ...over,
  });

  describe('command algebra (lifted)', () => {
    it('parent permits self and sub-paths, denies siblings and escapes', () => {
      expect(commandPermits('/cerebro', '/cerebro/search')).toBe(true);
      expect(commandPermits('/cerebro/search', '/cerebro/search')).toBe(true);
      expect(commandPermits('/cerebro/search', '/cerebro')).toBe(false);
      expect(commandPermits('/cerebro/search', '/cerebro/admin')).toBe(false);
      expect(commandPermits('/', '/anything')).toBe(true);
      // path-escape fails closed
      expect(commandPermits('/cerebro/search', '/cerebro/search/../../admin')).toBe(false);
    });
    it('normalizeCommand rejects malformed segments', () => {
      expect(() => normalizeCommand('/a/../b')).toThrow();
      expect(() => normalizeCommand('')).toThrow();
      expect(normalizeCommand('cerebro/search')).toBe('/cerebro/search');
    });
  });

  describe('policy (lifted, fail-closed)', () => {
    it('absent selector fails == and !=', () => {
      expect(evaluatePolicy([['==', '.x', 1]], {})).toHaveLength(1);
      expect(evaluatePolicy([['!=', '.x', 1]], {})).toHaveLength(1);
    });
    it('in / like / numeric comparisons', () => {
      expect(evaluatePolicy([['in', '.s', ['a', 'b']]], { s: 'a' })).toHaveLength(0);
      expect(evaluatePolicy([['in', '.s', ['a', 'b']]], { s: 'c' })).toHaveLength(1);
      expect(evaluatePolicy([['like', '.s', 'conf*']], { s: 'confluence' })).toHaveLength(0);
      expect(evaluatePolicy([['<=', '.n', 5]], { n: 6 })).toHaveLength(1);
    });
  });

  describe('happy path', () => {
    it('valid delegated token, in-scope action → ok with human + agent + scope', async () => {
      const token = await mint();
      const res = await verifyDelegation(token, verifyOpts());
      expect(res.ok).toBe(true);
      expect(res.reasons).toEqual([]);
      expect(res.delegated).toBe(true);
      expect(res.human).toEqual({ oid: 'human-1', sub: 'human-1', groups: ['entra-group:hr'] });
      expect(res.agent).toBe('agent:acme-copilot/instance-7');
      expect(res.scope).toBe('cerebro.search');
      expect(res.delegationId).toBeDefined();
    });

    it('grant parent command permits a narrower action', async () => {
      const token = await mint({ grant: { cmd: '/cerebro' } });
      const res = await verifyDelegation(token, verifyOpts({ action: { cmd: '/cerebro/search' } }));
      expect(res.ok).toBe(true);
    });

    it('surfaces principals_allow + sources_allow when the grant narrows them', async () => {
      const token = await mint({
        grant: { ...baseGrant, principals_allow: ['entra-group:hr'], sources_allow: ['confluence'] },
      });
      const res = await verifyDelegation(token, verifyOpts());
      expect(res.principalsAllow).toEqual(['entra-group:hr']);
      expect(res.sourcesAllow).toEqual(['confluence']);
    });

    it('a non-delegated token (no act) verifies as a plain bearer with no scope', async () => {
      // mint without act by signing a bare token via the same key.
      const { SignJWT } = await import('jose');
      const token = await new SignJWT({ oid: 'human-1', groups: ['entra-group:hr'] })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('5m')
        .sign(privateKey);
      const res = await verifyDelegation(token, verifyOpts());
      expect(res.ok).toBe(true);
      expect(res.delegated).toBe(false);
      expect(res.human?.oid).toBe('human-1');
    });
  });

  describe('fail-closed denials', () => {
    it('over-scope: action outside grant.cmd → command-not-permitted', async () => {
      const token = await mint(); // grant /cerebro/search
      const res = await verifyDelegation(
        token,
        verifyOpts({ action: { cmd: '/cerebro/admin', args: { topK: 5 } } }),
      );
      expect(res.ok).toBe(false);
      expect(res.reasons).toContain('delegation/command-not-permitted');
    });

    it('policy unsatisfied: args outside grant.pol → policy-unsatisfied', async () => {
      const token = await mint();
      const res = await verifyDelegation(
        token,
        verifyOpts({ action: { cmd: '/cerebro/search', args: { topK: 50 } } }),
      );
      expect(res.ok).toBe(false);
      expect(res.reasons).toContain('delegation/policy-unsatisfied');
    });

    it('expired token → token/invalid', async () => {
      const token = await mint({ expiresInS: 60, nowS: 1_000 });
      const res = await verifyDelegation(token, verifyOpts({ nowS: 10_000 }));
      expect(res.ok).toBe(false);
      expect(res.reasons[0]).toMatch(/token\/invalid/);
    });

    it('wrong audience → token/invalid', async () => {
      const token = await mint();
      const res = await verifyDelegation(token, verifyOpts({ audience: 'api://someone-else' }));
      expect(res.ok).toBe(false);
      expect(res.reasons[0]).toMatch(/token\/invalid/);
    });

    it('wrong issuer → token/invalid', async () => {
      const token = await mint();
      const res = await verifyDelegation(token, verifyOpts({ issuer: 'https://evil.local/v2.0' }));
      expect(res.ok).toBe(false);
      expect(res.reasons[0]).toMatch(/token\/invalid/);
    });

    it('token signed by a different key → token/invalid', async () => {
      const rogue = await generateKeyPair('RS256');
      const token = await mintDelegation({
        signKey: rogue.privateKey,
        issuer: ISSUER,
        audience: AUDIENCE,
        humanOid: 'human-1',
        agent: 'agent:x',
        grant: baseGrant,
      });
      const res = await verifyDelegation(token, verifyOpts());
      expect(res.ok).toBe(false);
      expect(res.reasons[0]).toMatch(/token\/invalid/);
    });

    it('ttl too long → token/ttl-too-long', async () => {
      const token = await mint({ expiresInS: 3600 });
      const res = await verifyDelegation(token, verifyOpts({ maxTtlS: 300 }));
      expect(res.ok).toBe(false);
      expect(res.reasons).toContain('token/ttl-too-long');
    });

    it('revoked delegation → delegation/revoked', async () => {
      const token = await mint();
      const registry: RevocationRegistry = {
        async isRevoked(): Promise<RevocationStatus> {
          return { revoked: true };
        },
      };
      const res = await verifyDelegation(token, verifyOpts({ registry }));
      expect(res.ok).toBe(false);
      expect(res.reasons).toContain('delegation/revoked');
    });

    it('replay: a re-presented jti → delegation/replayed', async () => {
      const token = await mint();
      const seen = new Set<string>();
      const nonceStore: NonceStore = {
        checkAndSet(n: string): boolean {
          if (seen.has(n)) return false;
          seen.add(n);
          return true;
        },
      };
      const first = await verifyDelegation(token, verifyOpts({ nonceStore }));
      expect(first.ok).toBe(true);
      const second = await verifyDelegation(token, verifyOpts({ nonceStore }));
      expect(second.ok).toBe(false);
      expect(second.reasons).toContain('delegation/replayed');
    });

    it('two-stage: verifyDelegationToken accepts the token (no action) and surfaces the grant', async () => {
      const token = await mint();
      const res = await verifyDelegationToken(token, {
        keys: publicKey,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      // Token verification passes regardless of the (absent) action; grant is surfaced.
      expect(res.ok).toBe(true);
      expect(res.delegated).toBe(true);
      expect(res.grant?.cmd).toBe('/cerebro/search');
      expect(res.human?.oid).toBe('human-1');

      // Stage 2 is a separate, pure decision over the surfaced grant.
      expect(authorizeAction(res.grant, { cmd: '/cerebro/search', args: { topK: 5 } }).ok).toBe(true);
      const denied = authorizeAction(res.grant, { cmd: '/cerebro/admin', args: { topK: 5 } });
      expect(denied.ok).toBe(false);
      expect(denied.reasons).toContain('delegation/command-not-permitted');
    });

    it('two-stage: an expired token is denied at stage 1 (before any action check)', async () => {
      const token = await mint({ expiresInS: 60, nowS: 1_000 });
      const res = await verifyDelegationToken(token, {
        keys: publicKey,
        issuer: ISSUER,
        audience: AUDIENCE,
        nowS: 10_000,
      });
      expect(res.ok).toBe(false);
      expect(res.reasons[0]).toMatch(/token\/invalid/);
    });

    it('authorizeAction fails closed on a missing grant', () => {
      expect(authorizeAction(undefined, { cmd: '/cerebro/search' }).ok).toBe(false);
      expect(authorizeAction(undefined, { cmd: '/cerebro/search' }).reasons).toContain(
        'delegation/missing-grant',
      );
    });

    it('a registry with no jti to check fails closed', async () => {
      const token = await mint({ jti: '' }); // setJti('') is falsy → treated as absent
      const registry: RevocationRegistry = {
        async isRevoked(): Promise<RevocationStatus> {
          return { revoked: false };
        },
      };
      const res = await verifyDelegation(token, verifyOpts({ registry }));
      expect(res.ok).toBe(false);
      expect(res.reasons).toContain('delegation/no-jti-for-revocation');
    });
  });
});

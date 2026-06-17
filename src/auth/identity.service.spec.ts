import { CerebroConfig } from '../config/config';
import { GroupResolver } from './group-resolver';
import { IdentityService } from './identity.service';
import { IdentityError } from './identity.types';
import { TokenVerifier, VerifiedClaims } from './token-verifier';

function configFor(mode: CerebroConfig['auth']['mode']): CerebroConfig {
  // Only the auth block matters to IdentityService.
  return { auth: { mode } } as CerebroConfig;
}

function fakeVerifier(result: VerifiedClaims | Error): TokenVerifier {
  return {
    verify: jest.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function fakeResolver(result: string[] | Error): GroupResolver {
  return {
    resolveGroups: jest.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('IdentityService (dev-header mode) — MVP stub parity', () => {
  const service = new IdentityService(configFor('dev-header'), fakeVerifier(new Error('unused')));

  it('parses a comma-separated header, trimming blanks (parity with the MVP resolvePrincipals)', async () => {
    const identity = await service.resolve({ devHeader: 'hr, engineering ,public' });
    expect(identity.principals).toEqual(['hr', 'engineering', 'public']);
    expect(identity.mode).toBe('dev-header');
  });

  it('yields no principals when the header is absent or empty (fail-closed → public-only downstream)', async () => {
    expect((await service.resolve({})).principals).toEqual([]);
    expect((await service.resolve({ devHeader: '' })).principals).toEqual([]);
    expect((await service.resolve({ devHeader: '  ,  ' })).principals).toEqual([]);
  });

  it('ignores any Authorization header — dev-header mode never validates tokens', async () => {
    const identity = await service.resolve({ authorization: 'Bearer junk', devHeader: 'hr' });
    expect(identity.principals).toEqual(['hr']);
  });
});

describe('IdentityService (oidc modes)', () => {
  const claims: VerifiedClaims = { oid: 'oid-123', groups: ['g-a', 'g-b'], hasOverage: false };

  it('mints namespaced principals from validated claims (+ the all-users reserved principal)', async () => {
    const service = new IdentityService(configFor('local-oidc'), fakeVerifier(claims));
    const identity = await service.resolve({ authorization: 'Bearer token' });
    expect(identity.subject).toBe('oid-123');
    expect(identity.principals).toEqual([
      'entra-user:oid-123',
      'entra-group:g-a',
      'entra-group:g-b',
      'all-users',
    ]);
    expect(identity.mode).toBe('local-oidc');
  });

  it('NEVER reads the dev header in oidc mode — client-asserted principals are dead', async () => {
    const service = new IdentityService(configFor('oidc'), fakeVerifier(claims));
    await expect(
      service.resolve({ devHeader: 'entra-group:hr,confluence-group:board-secret' }),
    ).rejects.toMatchObject({ code: 'TOKEN_MISSING' });
  });

  it('rejects a missing bearer token with TOKEN_MISSING', async () => {
    const service = new IdentityService(configFor('oidc'), fakeVerifier(claims));
    await expect(service.resolve({})).rejects.toMatchObject({ code: 'TOKEN_MISSING' });
    await expect(service.resolve({ authorization: 'Basic abc' })).rejects.toMatchObject({
      code: 'TOKEN_MISSING',
    });
  });

  it('propagates verifier rejection as IdentityError', async () => {
    const service = new IdentityService(
      configFor('oidc'),
      fakeVerifier(new IdentityError('TOKEN_INVALID', 'bad signature')),
    );
    await expect(service.resolve({ authorization: 'Bearer x' })).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('hard-fails on groups overage (GROUPS_UNRESOLVED — a partial group set is a lookup failure)', async () => {
    const service = new IdentityService(
      configFor('oidc'),
      fakeVerifier({ oid: 'oid-123', groups: [], hasOverage: true }),
    );
    await expect(service.resolve({ authorization: 'Bearer x' })).rejects.toMatchObject({
      code: 'GROUPS_UNRESOLVED',
    });
  });
});

describe('IdentityService overage group resolution', () => {
  const overage: VerifiedClaims = { oid: 'oid-9', groups: ['partial-g'], hasOverage: true };

  it('a NON-overage token never calls the resolver (token groups are already transitive)', async () => {
    const resolver = fakeResolver(['should-not-be-used']);
    const service = new IdentityService(
      configFor('oidc'),
      fakeVerifier({ oid: 'o', groups: ['g-a'], hasOverage: false }),
      undefined,
      resolver,
    );
    const id = await service.resolve({ authorization: 'Bearer x' });
    expect(id.principals).toContain('entra-group:g-a');
    expect(resolver.resolveGroups).not.toHaveBeenCalled();
  });

  it('overage + resolver success → the token PARTIAL groups are ignored, principals from the resolver set', async () => {
    const resolver = fakeResolver(['full-a', 'full-b']);
    const service = new IdentityService(configFor('oidc'), fakeVerifier(overage), undefined, resolver);
    const id = await service.resolve({ authorization: 'Bearer x' });
    expect(id.principals).toEqual([
      'entra-user:oid-9',
      'entra-group:full-a',
      'entra-group:full-b',
      'all-users',
    ]);
    expect(id.principals).not.toContain('entra-group:partial-g'); // the token's partial set is dropped
    expect(resolver.resolveGroups).toHaveBeenCalledWith('oid-9');
  });

  it('overage + resolver throws → GROUPS_UNRESOLVED (fail-closed; never a partial set)', async () => {
    const resolver = fakeResolver(new Error('Graph getMemberGroups 429'));
    const service = new IdentityService(configFor('oidc'), fakeVerifier(overage), undefined, resolver);
    await expect(service.resolve({ authorization: 'Bearer x' })).rejects.toMatchObject({
      code: 'GROUPS_UNRESOLVED',
    });
  });

  it('overage + no resolver (null) → GROUPS_UNRESOLVED (unchanged default behavior)', async () => {
    const service = new IdentityService(configFor('oidc'), fakeVerifier(overage), undefined, null);
    await expect(service.resolve({ authorization: 'Bearer x' })).rejects.toMatchObject({
      code: 'GROUPS_UNRESOLVED',
    });
  });
});

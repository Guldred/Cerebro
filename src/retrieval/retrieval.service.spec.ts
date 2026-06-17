import { CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import { EmbeddingProvider } from '../embedding/embedding.interface';
import { PrincipalMappingService } from './principal-mapping.service';
import { RetrievalService } from './retrieval.service';

/**
 * Defense-in-depth exit gate (P1.2): in oidc modes an EMPTY principal set can
 * only mean some code path minted an identity without token validation (every
 * authenticated caller holds at least entra-user:<oid>). The service must
 * refuse loudly, never degrade to a public-only query.
 */
describe('RetrievalService identity invariant', () => {
  function service(): RetrievalService {
    const config = {
      retrieval: { topK: 8, candidates: 40, rrfK: 60, ftsConfig: 'simple', efSearch: 100, iterativeScan: true },
      acl: { enforced: true, publicPrincipal: 'public' },
      observability: { logQueryText: false },
    } as CerebroConfig;
    const db = { transaction: jest.fn(), query: jest.fn() } as unknown as DatabaseService;
    const embedder = { model: 'fake', dim: 4, embed: jest.fn() } as unknown as EmbeddingProvider;
    const mapping = { expand: jest.fn() } as unknown as PrincipalMappingService;
    return new RetrievalService(config, db, embedder, mapping);
  }

  it('throws on an authenticated identity with an empty principal set', async () => {
    await expect(
      service().search('q', { identity: { subject: 'u', principals: [], mode: 'oidc' } }),
    ).rejects.toThrow(/Invariant violation/);
  });

  it('allows an empty principal set only for the dev-header stub (public-only path)', async () => {
    const s = service();
    // dev-header with no principals proceeds into expansion + SQL — stub the
    // failure boundary so the test stops before the (mocked) DB.
    const err = new Error('reached expansion');
    (s as unknown as { mapping: { expand: jest.Mock } }).mapping.expand = jest
      .fn()
      .mockRejectedValue(err);
    await expect(
      s.search('q', { identity: { subject: 'anon', principals: [], mode: 'dev-header' } }),
    ).rejects.toThrow('reached expansion');
  });
});

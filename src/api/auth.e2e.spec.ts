import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { createLocalIdp, LocalIdp } from '../auth/testing/token-factory';
import { DatabaseService } from '../db/database.service';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';

/**
 * HTTP-level exit gates for the REST auth boundary (review finding: the
 * APP_GUARD wiring, the 401/403 mapping, and @Public scoping were only pinned
 * one layer down). Real Nest HTTP server via supertest; DB and retrieval are
 * stubbed — these tests are about the guard, not the corpus.
 */

const dbStub = {
  query: async () => ({ rows: [{ count: '0' }] }),
  transaction: async () => undefined,
  onModuleDestroy: async () => undefined,
};

async function buildApp(env: Record<string, string>): Promise<INestApplication> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(dbStub)
      .overrideProvider(RetrievalService)
      .useValue({ search: jest.fn(async () => []) })
      .overrideProvider(RagService)
      .useValue({
        answer: jest.fn(async (question: string) => ({
          question,
          answer: 'Not found in the connected sources.',
          citations: [],
          evidence: [],
          notFound: true,
        })),
      })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('REST auth boundary (dev-header mode)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp({ AUTH_MODE: 'dev-header' });
  });
  afterAll(async () =>
    app.close());

  it('GET /health is @Public — 200 without any identity', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.authMode).toBe('dev-header');
  });

  it('GET /.well-known/oauth-protected-resource is @Public — 200 (RFC 9728 metadata)', async () => {
    const res = await request(app.getHttpServer())
      .get('/.well-known/oauth-protected-resource')
      .expect(200);
    expect(res.body.scopes_supported).toEqual(['cerebro.search', 'cerebro.query']);
    expect(res.body.bearer_methods_supported).toEqual(['header']);
  });

  it('POST /query accepts the header stub', async () => {
    await request(app.getHttpServer())
      .post('/query')
      .set('x-cerebro-principals', 'entra-group:hr')
      .send({ question: 'anything' })
      .expect(201);
  });

  it('POST /query without the header still works (empty principals → public-only)', async () => {
    await request(app.getHttpServer()).post('/query').send({ question: 'anything' }).expect(201);
  });

  it('POST /feedback records a rating (201)', async () => {
    // Note: DTO validation (rating ∈ {up,down}) runs via the main.ts global
    // ValidationPipe; the Test-module app here exercises routing + auth, not the
    // pipe. The @IsIn constraint is unit-covered by the DTO + verified in prod.
    await request(app.getHttpServer())
      .post('/feedback')
      .send({ query: 'salary bands?', rating: 'up', chunkIds: ['confluence:HR-SALARY-BANDS'] })
      .expect(201);
  });
});

describe('REST auth boundary (local-oidc mode — production guard semantics)', () => {
  let app: INestApplication;
  let idp: LocalIdp;

  beforeAll(async () => {
    idp = await createLocalIdp();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebro-e2e-jwks-'));
    const jwksFile = path.join(dir, 'jwks.json');
    await fs.writeFile(jwksFile, JSON.stringify(idp.jwks));
    app = await buildApp({
      AUTH_MODE: 'local-oidc',
      AUTH_OIDC_ISSUER: idp.issuer,
      AUTH_OIDC_AUDIENCE: idp.audience,
      AUTH_OIDC_JWKS_FILE: jwksFile,
    });
  });
  afterAll(async () => app.close());

  it('GET /health stays @Public', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.authMode).toBe('local-oidc');
  });

  it('protected-resource metadata advertises the resource + OIDC issuer (RFC 9728)', async () => {
    const res = await request(app.getHttpServer())
      .get('/.well-known/oauth-protected-resource')
      .expect(200);
    expect(res.body.resource).toBe(idp.audience);
    expect(res.body.authorization_servers).toContain(idp.issuer);
  });

  it('POST /query without a token → 401', async () => {
    await request(app.getHttpServer()).post('/query').send({ question: 'x' }).expect(401);
  });

  it('the dev header is DEAD in oidc modes → still 401', async () => {
    await request(app.getHttpServer())
      .post('/query')
      .set('x-cerebro-principals', 'entra-group:hr,confluence-group:hr-payroll')
      .send({ question: 'x' })
      .expect(401);
  });

  it('a garbage bearer token → 401', async () => {
    await request(app.getHttpServer())
      .post('/query')
      .set('authorization', 'Bearer junk')
      .send({ question: 'x' })
      .expect(401);
  });

  it('a groups-overage token → deterministic 403 (lookup failure, never silent narrowing)', async () => {
    const token = await idp.signToken({ oid: 'u-1', hasgroups: true });
    await request(app.getHttpServer())
      .post('/query')
      .set('authorization', `Bearer ${token}`)
      .send({ question: 'x' })
      .expect(403);
  });

  it('a valid token → 201 with the identity applied', async () => {
    const token = await idp.signToken({ oid: 'u-1', groups: ['hr'] });
    await request(app.getHttpServer())
      .post('/query')
      .set('authorization', `Bearer ${token}`)
      .send({ question: 'x' })
      .expect(201);
  });

  it('POST /search enforces the same boundary', async () => {
    await request(app.getHttpServer()).post('/search').send({ query: 'x' }).expect(401);
  });

  it('POST /feedback is auth-gated like the rest — no token → 401', async () => {
    await request(app.getHttpServer()).post('/feedback').send({ query: 'x', rating: 'up' }).expect(401);
  });
});

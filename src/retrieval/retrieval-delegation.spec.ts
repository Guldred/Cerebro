import { ForbiddenException } from '@nestjs/common';
import { CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import { EmbeddingProvider } from '../embedding/embedding.interface';
import { CallerIdentity, DelegationContext } from '../auth/identity.types';
import type { AttestationAnchor, AuthorizationDecisionRecord } from '../totem-sdk';
import { PrincipalMappingService } from './principal-mapping.service';
import { RetrievalService } from './retrieval.service';
import { RetrievalOptions } from './retrieval.types';

/**
 * Delegation enforcement at the retrieval choke point. A delegated caller's
 * scope can only NARROW: the action is authorized against the grant, sources and
 * ACL principals are set-intersected with the allow-lists, and over-scope DENIES
 * (403) with no data. Drives the real search() with a fake DB that captures the
 * emitted SQL params; no live DB.
 */
function makeService() {
  const config = {
    retrieval: { topK: 8, candidates: 40, rrfK: 60, ftsConfig: 'simple', efSearch: 100, iterativeScan: true },
    acl: { enforced: true, publicPrincipal: 'public' },
  } as CerebroConfig;

  const captured: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      return { rows: [] };
    }),
  };
  const db = {
    transaction: jest.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
    query: jest.fn(),
  } as unknown as DatabaseService;
  const embedder = { model: 'fake', dim: 4, embed: jest.fn(async () => [[0, 0, 0, 0]]) } as unknown as EmbeddingProvider;
  const mapping = { expand: jest.fn(async (id: CallerIdentity) => [...id.principals]) } as unknown as PrincipalMappingService;
  const anchor = {
    record: jest.fn(async (_rec: AuthorizationDecisionRecord) => ({ handle: 'audit:1' })),
    isRevoked: jest.fn(async (_ns: string, _id: string) => ({ revoked: false })),
  };
  const svc = new RetrievalService(config, db, embedder, mapping, anchor as unknown as AttestationAnchor);
  return { svc, captured, anchor };
}

function delegatedIdentity(delegation: DelegationContext): CallerIdentity {
  return {
    subject: 'human-1',
    principals: ['entra-user:human-1', 'entra-group:hr'],
    mode: 'oidc',
    delegation,
  };
}

/** The main hybrid query is the captured statement that carries the ACL filter. */
function mainQuery(captured: { sql: string; params: unknown[] }[]) {
  return captured.find((c) => c.sql.includes('acl_principals'));
}
function aclParam(captured: { sql: string; params: unknown[] }[]): string[] | undefined {
  return mainQuery(captured)?.params.find(
    (p): p is string[] => Array.isArray(p) && p.some((x) => typeof x === 'string' && x.startsWith('entra-')),
  );
}

const baseOpts = (delegation: DelegationContext, over: Partial<RetrievalOptions> = {}): RetrievalOptions => ({
  identity: delegatedIdentity(delegation),
  command: '/cerebro/search',
  ...over,
});

describe('RetrievalService delegation enforcement', () => {
  it('in-scope: proceeds, audits an allow, ACL set = human principals + public floor', async () => {
    const { svc, captured, anchor } = makeService();
    await svc.search('q', baseOpts({ agent: 'agent:x', grant: { cmd: '/cerebro/search', pol: [] } }));
    expect(aclParam(captured)).toEqual(['entra-user:human-1', 'entra-group:hr', 'public']);
    expect(anchor.record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow' }));
  });

  it('over-scope command: denies (403), no DB query, audits a deny', async () => {
    const { svc, captured, anchor } = makeService();
    await expect(
      svc.search('q', baseOpts({ agent: 'agent:x', grant: { cmd: '/cerebro/admin', pol: [] } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mainQuery(captured)).toBeUndefined();
    expect(anchor.record).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reasons: expect.arrayContaining(['delegation/command-not-permitted']) }),
    );
  });

  it('over-scope policy: a grant capping topK denies a larger request', async () => {
    const { svc } = makeService();
    await expect(
      svc.search('q', baseOpts({ agent: 'a', grant: { cmd: '/cerebro/search', pol: [['<=', '.topK', 5]] } }, { topK: 20 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('principals_allow narrows the ACL set AND the public floor (Decision E)', async () => {
    const { svc, captured } = makeService();
    await svc.search(
      'q',
      baseOpts({ agent: 'a', grant: { cmd: '/cerebro/search' }, principalsAllow: ['entra-group:hr'] }),
    );
    // human-1 user principal AND public are dropped — only the allowed group remains.
    expect(mainQuery(captured)?.params).toContainEqual(['entra-group:hr']);
  });

  it('sources_allow with a request for a disallowed source denies (over-scope)', async () => {
    const { svc } = makeService();
    await expect(
      svc.search(
        'q',
        baseOpts({ agent: 'a', grant: { cmd: '/cerebro/search' }, sourcesAllow: ['confluence'] }, { sourceSystems: ['github'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sources_allow with no explicit request narrows to the allowed subset', async () => {
    const { svc, captured } = makeService();
    await svc.search('q', baseOpts({ agent: 'a', grant: { cmd: '/cerebro/search' }, sourcesAllow: ['confluence'] }));
    expect(mainQuery(captured)?.params).toContainEqual(['confluence']);
  });
});

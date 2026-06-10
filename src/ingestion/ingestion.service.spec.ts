import { DatabaseService } from '../db/database.service';
import { EmbeddingProvider } from '../embedding/embedding.interface';
import { SourceDocument } from '../documents/document.model';
import { IngestionService } from './ingestion.service';

/**
 * Exit gates for the fail-closed ingestion semantics: quarantine on ACL
 * resolution failure, and the ACL-only rewrite path (permission change on
 * unchanged content must NEVER re-embed).
 */

function doc(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    sourceSystem: 'confluence',
    externalId: 'P-1',
    sourceUrl: 'https://conf.example/p1',
    title: 'Page One',
    breadcrumb: 'Space > Page One',
    contentType: 'text/markdown',
    aclPrincipals: ['confluence-group:eng'],
    body: '# Page One\n\nSome content.',
    ...overrides,
  };
}

interface Harness {
  service: IngestionService;
  queries: { sql: string; params?: unknown[] }[];
  embedCalls: string[][];
  setStored(row: Record<string, unknown> | null): void;
}

function harness(): Harness {
  const queries: { sql: string; params?: unknown[] }[] = [];
  let stored: Record<string, unknown> | null = null;

  const exec = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes('SELECT d.content_hash')) return { rows: stored ? [stored] : [] };
    return { rows: [] };
  };
  const db = {
    query: exec,
    transaction: async (cb: (client: { query: typeof exec }) => Promise<unknown>) =>
      cb({ query: exec }),
  } as unknown as DatabaseService;

  const embedCalls: string[][] = [];
  const embedder: EmbeddingProvider = {
    model: 'fake-test',
    dim: 4,
    embed: async (texts: string[]) => {
      embedCalls.push(texts);
      return texts.map(() => [0, 0, 0, 0]);
    },
  };

  return {
    service: new IngestionService(db, embedder),
    queries,
    embedCalls,
    setStored: (row) => (stored = row),
  };
}

describe('IngestionService quarantine (P1.1 fail-closed)', () => {
  it('a document with aclStatus=failed is stored with ZERO principals and acl_status=failed', async () => {
    const h = harness();
    const result = await h.service.ingestDocument(
      doc({ aclStatus: 'failed', aclPrincipals: ['confluence-group:eng'] }),
    );
    expect(result.quarantined).toBe(true);

    const docInsert = h.queries.find((q) => q.sql.includes('INSERT INTO documents'));
    expect(docInsert).toBeDefined();
    // acl ($10) must be empty — the connector-reported principals must NOT survive.
    expect(docInsert!.params![9]).toEqual([]);
    expect(docInsert!.params![10]).toBe('failed');

    const chunkInserts = h.queries.filter((q) => q.sql.includes('INSERT INTO chunks'));
    for (const ins of chunkInserts) expect(ins.params![11]).toEqual([]);
  });
});

describe('IngestionService.refreshAcls (revocation path, decoupled from content sync)', () => {
  function refreshHarness(storedDocs: Record<string, unknown>[]) {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const exec = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT id, external_id')) return { rows: storedDocs };
      return { rows: [] };
    };
    const db = {
      query: exec,
      transaction: async (cb: (client: { query: typeof exec }) => Promise<unknown>) =>
        cb({ query: exec }),
    } as unknown as DatabaseService;
    const embedder: EmbeddingProvider = {
      model: 'fake-test',
      dim: 4,
      embed: jest.fn(async () => {
        throw new Error('refreshAcls must NEVER embed');
      }),
    };
    return { service: new IngestionService(db, embedder), queries };
  }

  const storedRow = {
    id: 'confluence:P-1',
    external_id: 'P-1',
    acl_principals: ['confluence-group:eng'],
    acl_status: 'resolved',
  };

  const connectorWith = (resolvePermissions: (id: string) => Promise<string[]>) => ({
    sourceSystem: 'confluence',
    initialCrawl: jest.fn(),
    deltaSync: jest.fn(),
    resolvePermissions,
  });

  it('a tightened source ACL is rewritten on documents AND chunks, without embedding', async () => {
    const h = refreshHarness([storedRow]);
    const stats = await h.service.refreshAcls(
      connectorWith(async () => ['confluence-group:eng-leads']),
    );
    expect(stats).toEqual({ checked: 1, updated: 1, quarantined: 0, unchanged: 0 });
    expect(h.queries.some((q) => q.sql.includes('UPDATE documents SET acl_principals'))).toBe(true);
    expect(h.queries.some((q) => q.sql.includes('UPDATE chunks SET acl_principals'))).toBe(true);
  });

  it('an unchanged ACL is left alone', async () => {
    const h = refreshHarness([storedRow]);
    const stats = await h.service.refreshAcls(
      connectorWith(async () => ['confluence-group:eng']),
    );
    expect(stats).toEqual({ checked: 1, updated: 0, quarantined: 0, unchanged: 1 });
  });

  it('FAIL-CLOSED: a resolution failure quarantines (zero principals), never keeps the stale allow-set', async () => {
    const h = refreshHarness([storedRow]);
    const stats = await h.service.refreshAcls(
      connectorWith(async () => {
        throw new Error('source API down');
      }),
    );
    expect(stats).toEqual({ checked: 1, updated: 0, quarantined: 1, unchanged: 0 });
    const docUpdate = h.queries.find((q) => q.sql.includes('UPDATE documents SET acl_principals'));
    expect(docUpdate!.params).toEqual(['confluence:P-1', [], 'failed']);
  });
});

describe('IngestionService ACL-only rewrite (no re-embed)', () => {
  it('a permission change on unchanged content rewrites ACLs without calling the embedder', async () => {
    const h = harness();

    // First ingest to learn the content hash this body produces.
    await h.service.ingestDocument(doc());
    const firstInsert = h.queries.find((q) => q.sql.includes('INSERT INTO documents'));
    const hash = firstInsert!.params![11] as string;
    expect(h.embedCalls).toHaveLength(1);

    // Same content already stored, but the source tightened the ACL.
    h.setStored({
      content_hash: hash,
      acl_principals: ['confluence-group:eng'],
      acl_status: 'resolved',
      embedding_model: 'fake-test',
    });
    h.queries.length = 0;

    const result = await h.service.ingestDocument(
      doc({ aclPrincipals: ['confluence-group:eng-leads'] }),
    );
    expect(result).toMatchObject({ skipped: false, aclOnly: true });
    expect(h.embedCalls).toHaveLength(1); // STILL one — no re-embedding

    const updates = h.queries.filter((q) => q.sql.startsWith('UPDATE'));
    expect(updates.some((q) => q.sql.includes('UPDATE documents SET acl_principals'))).toBe(true);
    expect(updates.some((q) => q.sql.includes('UPDATE chunks SET acl_principals'))).toBe(true);
    expect(h.queries.some((q) => q.sql.includes('INSERT INTO chunks'))).toBe(false);
  });

  it('unchanged content AND unchanged ACL skips entirely', async () => {
    const h = harness();
    await h.service.ingestDocument(doc());
    const firstInsert = h.queries.find((q) => q.sql.includes('INSERT INTO documents'));
    const hash = firstInsert!.params![11] as string;

    h.setStored({
      content_hash: hash,
      acl_principals: ['confluence-group:eng'],
      acl_status: 'resolved',
      embedding_model: 'fake-test',
    });
    await expect(h.service.ingestDocument(doc())).resolves.toMatchObject({ skipped: true });
  });

  it('an embedding-model switch still forces a full re-embed (idempotency stays model-aware)', async () => {
    const h = harness();
    await h.service.ingestDocument(doc());
    const firstInsert = h.queries.find((q) => q.sql.includes('INSERT INTO documents'));
    const hash = firstInsert!.params![11] as string;

    h.setStored({
      content_hash: hash,
      acl_principals: ['confluence-group:eng'],
      acl_status: 'resolved',
      embedding_model: 'other-model',
    });
    const result = await h.service.ingestDocument(doc());
    expect(result).toMatchObject({ skipped: false });
    expect(h.embedCalls).toHaveLength(2);
  });
});

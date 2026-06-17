import { CerebroConfig } from '../config/config';
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
  setSuppressed(v: boolean): void;
}

function harness(embedMaxBatch = 96): Harness {
  const queries: { sql: string; params?: unknown[] }[] = [];
  let stored: Record<string, unknown> | null = null;
  let suppressed = false;

  const exec = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes('suppressed_documents')) {
      return { rows: suppressed ? [{ ok: 1 }] : [], rowCount: suppressed ? 1 : 0 };
    }
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

  const config = { ingestion: { embedMaxBatch } } as CerebroConfig;
  return {
    service: new IngestionService(config, db, embedder),
    queries,
    embedCalls,
    setStored: (row) => (stored = row),
    setSuppressed: (v) => (suppressed = v),
  };
}

describe('IngestionService erasure suppression (P1.4 — the line that makes erasure stick)', () => {
  it('an erasure-suppressed document is skipped: no embed, no content lookup, no write', async () => {
    const h = harness();
    h.setSuppressed(true);
    const result = await h.service.ingestDocument(doc());

    expect(result).toEqual({ skipped: true, chunks: 0 });
    expect(h.embedCalls).toHaveLength(0);
    // Short-circuits BEFORE the content-hash read and any document/chunk write —
    // a re-crawl can never resurrect the erased document.
    expect(h.queries.some((q) => q.sql.includes('SELECT d.content_hash'))).toBe(false);
    expect(h.queries.some((q) => q.sql.includes('INSERT INTO documents'))).toBe(false);
  });

  it('a non-suppressed document ingests normally (the check does not block live content)', async () => {
    const h = harness();
    const result = await h.service.ingestDocument(doc());
    expect(result.skipped).toBe(false);
    expect(h.embedCalls.length).toBeGreaterThan(0);
  });
});

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

describe('IngestionService embed batch cap (P1.5 — a large doc cannot blow the per-request limit)', () => {
  const multiSection = '# Doc\n\nIntro paragraph.\n\n## A\n\nAlpha content.\n\n## B\n\nBeta content.\n\n## C\n\nGamma content.';

  it('embeds a whole document in ONE call when it fits the cap', async () => {
    const h = harness(96);
    await h.service.ingestDocument(doc({ body: multiSection }));
    expect(h.embedCalls).toHaveLength(1);
    expect(h.embedCalls[0].length).toBeGreaterThan(1); // multiple chunks, one batch
  });

  it('splits the embed into capped batches for a large document (one call per chunk at cap=1)', async () => {
    const baseline = harness(96);
    await baseline.service.ingestDocument(doc({ body: multiSection }));
    const chunkCount = baseline.embedCalls[0].length;

    const capped = harness(1);
    await capped.service.ingestDocument(doc({ body: multiSection }));
    expect(capped.embedCalls).toHaveLength(chunkCount); // one call per chunk
    expect(capped.embedCalls.every((c) => c.length === 1)).toBe(true);
  });
});

describe('IngestionService empty-body leak guard (review finding: stale chunks under old ACL)', () => {
  it('a STORED doc whose body empties + ACL tightens deletes the old chunks and persists the new ACL', async () => {
    const h = harness();
    // Previously ingested broadly readable version exists.
    h.setStored({
      content_hash: 'old-hash-of-nonempty-body',
      acl_principals: ['public'],
      acl_status: 'resolved',
      embedding_model: 'fake-test',
    });

    const result = await h.service.ingestDocument(
      doc({ body: '', aclStatus: 'failed', aclPrincipals: ['public'] }),
    );
    // NOT a silent skip: the stale chunks must be removed and the quarantine persisted.
    expect(result).toMatchObject({ skipped: false, aclOnly: true, quarantined: true });
    expect(h.queries.some((q) => q.sql.includes('DELETE FROM chunks'))).toBe(true);
    const update = h.queries.find((q) => q.sql.includes('UPDATE documents'));
    expect(update!.params![1]).toEqual([]); // zero principals
    expect(update!.params![2]).toBe('failed');
    expect(h.embedCalls).toHaveLength(0); // nothing to embed
  });

  it('a NEW doc with an empty body still skips (nothing stored, nothing to leak)', async () => {
    const h = harness();
    const result = await h.service.ingestDocument(doc({ body: '' }));
    expect(result).toMatchObject({ skipped: true });
    expect(h.queries.some((q) => q.sql.startsWith('DELETE') || q.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('a still-quarantined unchanged doc reports quarantined on the skip path (stats integrity)', async () => {
    const h = harness();
    // First ingest the quarantined doc to learn its content hash.
    await h.service.ingestDocument(doc({ aclStatus: 'failed' }));
    const firstInsert = h.queries.find((q) => q.sql.includes('INSERT INTO documents'));
    const hash = firstInsert!.params![11] as string;

    h.setStored({
      content_hash: hash,
      acl_principals: [],
      acl_status: 'failed',
      embedding_model: 'fake-test',
    });
    await expect(h.service.ingestDocument(doc({ aclStatus: 'failed' }))).resolves.toMatchObject({
      skipped: true,
      quarantined: true,
    });
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
    const config = { ingestion: { embedMaxBatch: 96 } } as CerebroConfig;
    return { service: new IngestionService(config, db, embedder), queries };
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

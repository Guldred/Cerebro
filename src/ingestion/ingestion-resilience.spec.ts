import { DatabaseService } from '../db/database.service';
import { EmbeddingProvider } from '../embedding/embedding.interface';
import { SourceDocument } from '../documents/document.model';
import { Connector, SyncResult } from './connectors/connector.interface';
import { IngestionService } from './ingestion.service';

function doc(externalId: string, title: string): SourceDocument {
  return {
    sourceSystem: 'test',
    externalId,
    sourceUrl: `https://src/${externalId}`,
    title,
    breadcrumb: 'Space',
    contentType: 'text/markdown',
    aclPrincipals: ['public'],
    body: `# ${title}\n\nThis is a paragraph of content for ${externalId}.`,
  };
}

/** A db double routing the queries runInitialCrawl/sync emit, recording the
 *  security-relevant ones (document inserts, DLQ writes/clears, cursor saves). */
function harness(opts: { storedCursor?: string | null } = {}) {
  const docInserts: string[] = [];
  const dlqWrites: { id: string; error: string }[] = [];
  const dlqClears: string[] = [];
  const cursorSaves: (string | null)[] = [];

  const run = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('suppressed_documents')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT d.content_hash')) return { rows: [] }; // every doc is new → full ingest
    if (sql.includes('SELECT id FROM documents WHERE source_system')) return { rows: [] }; // no reconcile deletes
    if (sql.includes('INSERT INTO ingestion_dlq')) {
      dlqWrites.push({ id: params[0] as string, error: params[3] as string });
      return { rowCount: 1 };
    }
    if (sql.includes('DELETE FROM ingestion_dlq')) {
      dlqClears.push(params[0] as string);
      return { rowCount: 1 };
    }
    if (sql.includes('SELECT cursor FROM sync_cursors')) {
      return { rows: opts.storedCursor !== undefined ? [{ cursor: opts.storedCursor }] : [] };
    }
    if (sql.includes('INSERT INTO sync_cursors')) {
      cursorSaves.push(params[1] as string | null);
      return { rowCount: 1 };
    }
    if (sql.includes('INSERT INTO documents')) docInserts.push(params[0] as string);
    return { rows: [], rowCount: 0 };
  };

  const db = {
    query: run,
    transaction: async (fn: (c: { query: typeof run }) => Promise<unknown>) => fn({ query: run }),
  } as unknown as DatabaseService;

  // The embedder throws for any document whose text carries the POISON marker.
  const embedder: EmbeddingProvider = {
    model: 'fake-test',
    dim: 4,
    embed: async (texts: string[]) => {
      if (texts.some((t) => t.includes('POISON'))) throw new Error('embedder 429 — rate limited');
      return texts.map(() => [0, 0, 0, 0]);
    },
  };

  return { service: new IngestionService(db, embedder), docInserts, dlqWrites, dlqClears, cursorSaves };
}

function connector(over: Partial<Connector> & { delta?: Partial<SyncResult>; deltaThrows?: boolean } = {}): Connector {
  return {
    sourceSystem: 'test',
    initialCrawl: over.initialCrawl ?? (async () => []),
    deltaSync:
      over.deltaSync ??
      (async () => {
        if (over.deltaThrows) throw new Error('source API down');
        return { documents: [], deletedExternalIds: [], cursor: 'cursor-2', ...over.delta };
      }),
    resolvePermissions: async () => [],
  };
}

describe('IngestionService resilience — a poison document does not abort the crawl', () => {
  it('ingests the good docs, dead-letters the failure, and continues', async () => {
    const h = harness();
    const docs = [doc('good-1', 'Alpha'), doc('poison', 'POISON Doc'), doc('good-2', 'Beta')];
    const stats = await h.service.runInitialCrawl(connector({ initialCrawl: async () => docs }));

    expect(stats.ingested).toBe(2);
    expect(stats.failed).toBe(1);
    // the two good docs were written; the poison one never reached the transaction
    expect(h.docInserts).toEqual(['test:good-1', 'test:good-2']);
    // the failure is dead-lettered with its error
    expect(h.dlqWrites).toHaveLength(1);
    expect(h.dlqWrites[0].id).toBe('test:poison');
    expect(h.dlqWrites[0].error).toMatch(/embedder 429/);
    // each successful ingest clears any prior DLQ row
    expect(h.dlqClears).toEqual(expect.arrayContaining(['test:good-1', 'test:good-2']));
    expect(h.dlqClears).not.toContain('test:poison');
  });

  it('a now-succeeding document clears its DLQ row', async () => {
    const h = harness();
    await h.service.runInitialCrawl(connector({ initialCrawl: async () => [doc('recovered', 'Gamma')] }));
    expect(h.dlqClears).toContain('test:recovered');
    expect(h.dlqWrites).toHaveLength(0);
  });
});

describe('IngestionService sync — durable cursor', () => {
  it('loads the stored cursor, runs deltaSync, and persists the returned cursor', async () => {
    const h = harness({ storedCursor: 'cursor-1' });
    const seen: (string | null)[] = [];
    const c = connector({
      deltaSync: async (cur) => {
        seen.push(cur);
        return { documents: [doc('d1', 'Delta')], deletedExternalIds: [], cursor: 'cursor-2' };
      },
    });
    const result = await h.service.sync(c);

    expect(seen).toEqual(['cursor-1']); // resumed from the stored cursor
    expect(result.cursor).toBe('cursor-2');
    expect(h.cursorSaves).toEqual(['cursor-2']); // new cursor persisted
  });

  it('does NOT advance the cursor when the source API throws (window retried next run)', async () => {
    const h = harness({ storedCursor: 'cursor-1' });
    await expect(h.service.sync(connector({ deltaThrows: true }))).rejects.toThrow(/source API down/);
    expect(h.cursorSaves).toHaveLength(0); // saveCursor unreachable past the throw
  });

  it('a tombstoned document is deleted AND its DLQ row cleared (no ghost)', async () => {
    const h = harness({ storedCursor: null });
    await h.service.sync(connector({ delta: { documents: [], deletedExternalIds: ['gone'], cursor: 'c3' } }));
    expect(h.dlqClears).toContain('test:gone'); // deleteDocument cleared the DLQ row
  });
});

import { createHash } from 'crypto';
import { CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import { ErasureService } from './erasure.service';

interface QueryResponse {
  match: RegExp;
  result: { rows?: unknown[]; rowCount?: number };
}

/** A db double that routes both db.query and the in-transaction client.query by
 *  SQL pattern, recording every call. Unmatched queries return an empty result. */
function makeDb(responses: QueryResponse[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const hit = responses.find((r) => r.match.test(sql));
    return { rows: hit?.result.rows ?? [], rowCount: hit?.result.rowCount ?? 0 };
  };
  const db = {
    query: run,
    transaction: async (fn: (client: { query: typeof run }) => unknown) => fn({ query: run }),
  } as unknown as DatabaseService;
  const find = (re: RegExp) => calls.filter((c) => re.test(c.sql));
  return { db, calls, find };
}

const RECEIPT: QueryResponse = { match: /INSERT INTO erasure_log/, result: { rows: [{ id: '42' }], rowCount: 1 } };

const svc = (db: DatabaseService, pepper = 'test-pepper') =>
  new ErasureService({ erasure: { pepper } } as CerebroConfig, db);

const expectedDigest = (pepper: string, mode: string, target: string) =>
  createHash('sha256').update(pepper).update('\0').update(`${mode}:${target}`).digest('hex');

describe('ErasureService.eraseSubject (footprint only)', () => {
  it('deletes the user mapping + link rows, pseudonymizes audit, and touches NOTHING else', async () => {
    const { db, find, calls } = makeDb([
      RECEIPT,
      { match: /DELETE FROM principal_mappings/, result: { rowCount: 1 } },
      { match: /DELETE FROM identity_links/, result: { rowCount: 1 } },
      { match: /UPDATE delegation_audit/, result: { rowCount: 3 } },
    ]);
    const receipt = await svc(db).eraseSubject('oid-1', 'DSAR-7');

    // principal_mappings: EXACT user principal, never a group / LIKE.
    const pm = find(/DELETE FROM principal_mappings/);
    expect(pm).toHaveLength(1);
    expect(pm[0].sql).toMatch(/entra_principal = \$1/);
    expect(pm[0].params[0]).toBe('entra-user:oid-1');
    expect(find(/DELETE FROM identity_links/)[0].params[0]).toBe('entra-user:oid-1');

    // delegation_audit is PSEUDONYMIZED (UPDATE), not deleted.
    const au = find(/delegation_audit/);
    expect(au).toHaveLength(1);
    expect(au[0].sql).toMatch(/UPDATE delegation_audit SET subject/);
    const digest = expectedDigest('test-pepper', 'subject', 'oid-1');
    expect(au[0].params).toEqual([`erased:${digest}`, 'oid-1']); // [pseudonym, oldSubject] → SET $1 WHERE $2
    expect(receipt.targetDigest).toBe(digest);

    // NEVER touches the fail-open revocation list, nor any content/suppression table.
    expect(find(/delegation_revocations/)).toHaveLength(0);
    expect(find(/FROM documents|FROM chunks|suppressed_documents/)).toHaveLength(0);

    expect(receipt.counts).toEqual({ principalMappings: 1, identityLinks: 1, auditPseudonymized: 3 });
    expect(calls.some((c) => /entra-group/.test(JSON.stringify(c.params)))).toBe(false);
  });

  it('the audit pseudonym equals the receipt digest (correlatable, reveals nothing)', async () => {
    const { db, find } = makeDb([RECEIPT, { match: /UPDATE delegation_audit/, result: { rowCount: 1 } }]);
    const receipt = await svc(db).eraseSubject('oid-9');
    expect(find(/UPDATE delegation_audit/)[0].params[0]).toBe(`erased:${receipt.targetDigest}`); // SET $1 = pseudonym
  });
});

describe('ErasureService.eraseByAuthor', () => {
  it('deletes documents by author, counts chunks, and suppresses the found ids', async () => {
    const found = [{ id: 'confluence:1' }, { id: 'confluence:2' }];
    const { db, find } = makeDb([
      RECEIPT,
      { match: /SELECT id FROM documents WHERE author/, result: { rows: found } },
      { match: /SELECT count\(\*\).*FROM chunks/, result: { rows: [{ count: '5' }] } },
      { match: /DELETE FROM documents WHERE author/, result: { rowCount: 2 } },
      { match: /INSERT INTO suppressed_documents/, result: { rowCount: 2 } },
    ]);
    const receipt = await svc(db).eraseByAuthor('jane.doe', 'DSAR-8');

    expect(find(/DELETE FROM documents WHERE author/)[0].params[0]).toBe('jane.doe');
    expect(find(/INSERT INTO suppressed_documents/)[0].params[0]).toEqual(['confluence:1', 'confluence:2']);
    expect(receipt.mode).toBe('author');
    expect(receipt.counts).toEqual({ documents: 2, chunks: 5, suppressed: 2 });
  });
});

describe('ErasureService.eraseDocuments', () => {
  it('suppresses EVERY requested id — even ones not currently present', async () => {
    const { db, find } = makeDb([
      RECEIPT,
      { match: /SELECT id FROM documents WHERE id = ANY/, result: { rows: [{ id: 'github:present' }] } },
      { match: /SELECT count\(\*\).*FROM chunks/, result: { rows: [{ count: '3' }] } },
      { match: /DELETE FROM documents WHERE id = ANY/, result: { rowCount: 1 } },
      { match: /INSERT INTO suppressed_documents/, result: { rowCount: 2 } },
    ]);
    const receipt = await svc(db).eraseDocuments(['github:present', 'github:absent'], 'ticket-1');

    // delete targets only the present id; suppression covers BOTH requested ids.
    expect(find(/DELETE FROM documents WHERE id = ANY/)[0].params[0]).toEqual(['github:present']);
    expect(find(/INSERT INTO suppressed_documents/)[0].params[0]).toEqual(['github:present', 'github:absent']);
    expect(receipt.counts).toEqual({ documents: 1, chunks: 3, suppressed: 2 });
  });
});

describe('ErasureService.vacuumReindex (physical zeroing)', () => {
  it('VACUUM FULLs every personal-data table and completes pending receipts', async () => {
    const { db, find } = makeDb([
      { match: /UPDATE erasure_log SET status = 'physically-zeroed'/, result: { rowCount: 4 } },
    ]);
    const res = await svc(db).vacuumReindex();

    for (const t of ['chunks', 'documents', 'principal_mappings', 'identity_links', 'delegation_audit']) {
      expect(find(new RegExp(`VACUUM \\(FULL, ANALYZE\\) ${t}`))).toHaveLength(1);
    }
    expect(res.tablesZeroed).toHaveLength(5);
    expect(res.receiptsCompleted).toBe(4);
  });
});

describe('ErasureService digest', () => {
  it('is deterministic for a given pepper and changes with the pepper', async () => {
    const a = makeDb([RECEIPT]);
    const b = makeDb([RECEIPT]);
    const r1 = await svc(a.db, 'pepper-A').eraseSubject('oid-x');
    const r2 = await svc(b.db, 'pepper-B').eraseSubject('oid-x');
    expect(r1.targetDigest).toBe(expectedDigest('pepper-A', 'subject', 'oid-x'));
    expect(r1.targetDigest).not.toBe(r2.targetDigest);
  });
});

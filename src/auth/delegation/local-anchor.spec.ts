import type { QueryResult, QueryResultRow } from 'pg';
import { DatabaseService } from '../../db/database.service';
import { LocalAppendOnlyAnchor } from './local-anchor';

/**
 * Unit suite for the default AttestationAnchor backend. No real DB — a fake
 * DatabaseService records the SQL it is asked to run and returns canned rows, so
 * the SQL-shaping and the fail-closed semantics are pinned offline (the live DB
 * is exercised by `npm run eval`).
 */
type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult<QueryResultRow>>;

function fakeDb(query: QueryFn): DatabaseService {
  return { query } as unknown as DatabaseService;
}

const rows = (r: QueryResultRow[]): QueryResult<QueryResultRow> =>
  ({ rows: r, rowCount: r.length, command: '', oid: 0, fields: [] }) as QueryResult<QueryResultRow>;

describe('LocalAppendOnlyAnchor', () => {
  describe('record', () => {
    it('inserts an audit row and returns its handle', async () => {
      const calls: { text: string; params?: unknown[] }[] = [];
      const anchor = new LocalAppendOnlyAnchor(
        fakeDb(async (text, params) => {
          calls.push({ text, params });
          return rows([{ id: '42' }]);
        }),
      );
      const { handle } = await anchor.record({
        ts: '2026-06-16T00:00:00Z',
        subject: 'human-1',
        actor: 'agent:x',
        action: '/cerebro/search',
        argsDigest: 'sha256:abc',
        decision: 'allow',
        reasons: [],
        delegationId: 'jti-1',
      });
      expect(handle).toBe('audit:42');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.text).toMatch(/INSERT INTO delegation_audit/);
      expect(calls[0]!.params).toEqual([
        'human-1',
        'agent:x',
        '/cerebro/search',
        'sha256:abc',
        'allow',
        [],
        'jti-1',
      ]);
    });

    it('is best-effort: a write failure does NOT throw (audit gap is logged, request survives)', async () => {
      const anchor = new LocalAppendOnlyAnchor(
        fakeDb(async () => {
          throw new Error('db down');
        }),
      );
      const { handle } = await anchor.record({
        ts: 't',
        action: '/cerebro/search',
        decision: 'deny',
        reasons: ['delegation/revoked'],
      });
      expect(handle).toBe('unrecorded');
    });
  });

  describe('isRevoked', () => {
    it('reports revoked when a row exists', async () => {
      const anchor = new LocalAppendOnlyAnchor(
        fakeDb(async () => rows([{ revoked_at: new Date('2026-06-16T00:00:00Z') }])),
      );
      const status = await anchor.isRevoked('human-1', 'jti-1');
      expect(status.revoked).toBe(true);
      expect(status.asOf).toBe('2026-06-16T00:00:00.000Z');
    });

    it('reports not-revoked when no row exists', async () => {
      const anchor = new LocalAppendOnlyAnchor(fakeDb(async () => rows([])));
      expect((await anchor.isRevoked('human-1', 'jti-1')).revoked).toBe(false);
    });

    it('fails closed: a DB error propagates (verification aborts, never "not revoked")', async () => {
      const anchor = new LocalAppendOnlyAnchor(
        fakeDb(async () => {
          throw new Error('db down');
        }),
      );
      await expect(anchor.isRevoked('human-1', 'jti-1')).rejects.toThrow('db down');
    });
  });

  describe('revoke', () => {
    it('inserts a revocation row idempotently', async () => {
      const calls: { text: string; params?: unknown[] }[] = [];
      const anchor = new LocalAppendOnlyAnchor(
        fakeDb(async (text, params) => {
          calls.push({ text, params });
          return rows([]);
        }),
      );
      await anchor.revoke('human-1', 'jti-1', 'admin');
      expect(calls[0]!.text).toMatch(/INSERT INTO delegation_revocations/);
      expect(calls[0]!.text).toMatch(/ON CONFLICT/);
      expect(calls[0]!.params).toEqual(['human-1', 'jti-1', 'admin']);
    });
  });
});

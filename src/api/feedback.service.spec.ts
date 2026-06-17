import { CallerIdentity } from '../auth/identity.types';
import { DatabaseService } from '../db/database.service';
import { queryHash } from '../observability/query-log';
import { FeedbackService } from './feedback.service';

const identity: CallerIdentity = { subject: 'oid-1', principals: ['entra-user:oid-1'], mode: 'oidc' };

function svc() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ id: '7' }] };
    },
  } as unknown as DatabaseService;
  return { service: new FeedbackService(db), calls };
}

describe('FeedbackService', () => {
  it('records a rating with the query HASHED (never raw), caller subject, chunks + comment', async () => {
    const { service, calls } = svc();
    const res = await service.record(identity, {
      query: 'what are the salary bands?',
      rating: 'up',
      chunkIds: ['confluence:HR-SALARY-BANDS'],
      comment: 'spot on',
    });

    expect(res).toEqual({ id: '7' });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO query_feedback'))!;
    expect(insert.params[0]).toBe('oid-1');
    expect(insert.params[1]).toBe(queryHash('what are the salary bands?'));
    expect(insert.params[1]).not.toMatch(/salary/); // stored as a hash, not the raw text
    expect(insert.params[2]).toBe('up');
    expect(insert.params[3]).toEqual(['confluence:HR-SALARY-BANDS']);
    expect(insert.params[4]).toBe('spot on');
  });

  it('defaults chunkIds to [] and comment to null', async () => {
    const { service, calls } = svc();
    await service.record(identity, { query: 'q', rating: 'down' });
    expect(calls[0].params[3]).toEqual([]);
    expect(calls[0].params[4]).toBeNull();
  });
});

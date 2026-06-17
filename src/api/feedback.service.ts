import { Injectable } from '@nestjs/common';
import { CallerIdentity } from '../auth/identity.types';
import { DatabaseService } from '../db/database.service';
import { queryHash } from '../observability/query-log';
import { FeedbackDto } from './dto';

/**
 * Records 👍/👎 answer-quality feedback (Plan_Review P2). The raw query is hashed
 * (never stored — Art. 9) with the same fingerprint as the observability events,
 * so feedback joins to a query's log trail by `query_hash`.
 */
@Injectable()
export class FeedbackService {
  constructor(private readonly db: DatabaseService) {}

  async record(identity: CallerIdentity, dto: FeedbackDto): Promise<{ id: string }> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO query_feedback (subject, query_hash, rating, chunk_ids, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id::text AS id`,
      [identity.subject, queryHash(dto.query), dto.rating, dto.chunkIds ?? [], dto.comment ?? null],
    );
    return { id: res.rows[0]!.id };
  }
}

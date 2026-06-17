import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';

/**
 * Privacy-safe structured query observability (Plan_Review P2/P3). One JSON event
 * per query stage (retrieval, rag) carrying chunk ids + scores, per-stage latency,
 * and token usage — enough to trace recall, latency and cost without storing the
 * raw query text, which can be Art. 9 special-category data. The query is reduced
 * to a short hash + length by default; raw text is opt-in (OBSERVABILITY_LOG_QUERY_TEXT).
 */

/** A short, non-reversible fingerprint of the query — correlates a query's stages
 *  across log events without recording its content. */
export function queryHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Emit one structured event as a single JSON line via the Nest logger. */
export function emitQueryEvent(log: Logger, event: Record<string, unknown>): void {
  log.log(JSON.stringify(event));
}

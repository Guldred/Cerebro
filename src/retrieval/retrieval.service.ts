import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
  embedOne,
  toVectorLiteral,
} from '../embedding/embedding.interface';
import { RetrievalOptions, RetrievedChunk } from './retrieval.types';

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  heading_path: string;
  anchor: string | null;
  content: string;
  source_system: string;
  source_url: string;
  title: string;
  vector_rank: number | null;
  fts_rank: number | null;
  score: string;
}

/**
 * Hybrid retrieval (plan §6.4): dense vector search (pgvector cosine) and lexical
 * full-text search run as two legs, each producing a ranked candidate list, fused
 * with Reciprocal Rank Fusion. The ACL pre-filter (§7, early binding) is applied
 * inside BOTH legs so a forbidden chunk can never enter either ranking.
 */
@Injectable()
export class RetrievalService {
  private readonly log = new Logger(RetrievalService.name);

  constructor(
    @Inject(CONFIG) private readonly config: CerebroConfig,
    private readonly db: DatabaseService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
  ) {}

  async search(query: string, options: RetrievalOptions): Promise<RetrievedChunk[]> {
    const topK = options.topK ?? this.config.retrieval.topK;
    const candidates = options.candidates ?? this.config.retrieval.candidates;
    const { rrfK, ftsConfig } = this.config.retrieval;

    const queryVector = toVectorLiteral(await embedOne(this.embedder, query));

    // Build params and the shared ACL/source filter once.
    const params: unknown[] = [];
    const p = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    const pVec = p(queryVector);
    const pCfg = p(ftsConfig);
    const pQuery = p(query);
    const pCand = p(candidates);
    const pRrf = p(rrfK);
    const pTopK = p(topK);

    const filters: string[] = ['embedding IS NOT NULL'];
    if (this.config.acl.enforced) {
      // The defining permission-safety guarantee. Principals always include the
      // public principal (added below), so public content stays visible.
      const principals = dedupe([...options.principals, this.config.acl.publicPrincipal]);
      filters.push(`acl_principals && ${p(principals)}::text[]`);
    }
    if (options.sourceSystems && options.sourceSystems.length > 0) {
      filters.push(`source_system = ANY(${p(options.sourceSystems)})`);
    }
    const where = filters.join(' AND ');

    // OR-semantics lexical query: plainto_tsquery ANDs every term, so a chunk must
    // contain ALL query words to match — far too strict for hybrid retrieval. We
    // rewrite the '&' operators to '|' so any matching term contributes, and let
    // ts_rank_cd + RRF do the ranking. Empty/stopword-only queries collapse to NULL
    // (no lexical hits), which is correct.
    const sql = `
      WITH q AS (
        SELECT to_tsquery(
                 ${pCfg}::regconfig,
                 NULLIF(regexp_replace(plainto_tsquery(${pCfg}::regconfig, ${pQuery})::text, ' & ', ' | ', 'g'), '')
               ) AS ts
      ),
      vec AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${pVec}::vector) AS rank
        FROM chunks
        WHERE ${where}
        ORDER BY embedding <=> ${pVec}::vector
        LIMIT ${pCand}
      ),
      fts AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(tsv, q.ts) DESC) AS rank
        FROM chunks, q
        WHERE ${where} AND tsv @@ q.ts
        ORDER BY ts_rank_cd(tsv, q.ts) DESC
        LIMIT ${pCand}
      )
      SELECT c.id, c.document_id, c.chunk_index, c.heading_path, c.anchor, c.content,
             c.source_system, c.source_url, c.title,
             vec.rank AS vector_rank, fts.rank AS fts_rank,
             COALESCE(1.0 / (${pRrf} + vec.rank), 0) + COALESCE(1.0 / (${pRrf} + fts.rank), 0) AS score
      FROM chunks c
      LEFT JOIN vec ON vec.id = c.id
      LEFT JOIN fts ON fts.id = c.id
      WHERE vec.id IS NOT NULL OR fts.id IS NOT NULL
      ORDER BY score DESC
      LIMIT ${pTopK}
    `;

    const startedAt = process.hrtime.bigint();
    // Run inside a transaction so the HNSW tuning GUCs are SET LOCAL — scoped to
    // this query only and never leaking across pooled connections.
    const rows = await this.db.transaction(async (client) => {
      // ef_search is a trusted integer from config; interpolated because SET does
      // not accept bind parameters.
      await client.query(`SET LOCAL hnsw.ef_search = ${Math.trunc(this.config.retrieval.efSearch)}`);
      if (this.config.retrieval.iterativeScan) {
        await client.query(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
      }
      const res = await client.query<ChunkRow>(sql, params);
      return res.rows;
    });

    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // Structured per-query observability (plan §13): which chunks, what scores.
    this.log.debug(
      `search topK=${topK} hits=${rows.length} ms=${ms.toFixed(1)} acl=${this.config.acl.enforced} ` +
        `ids=[${rows.map((r) => r.id).join(',')}]`,
    );

    return rows.map(toRetrievedChunk);
  }
}

function toRetrievedChunk(row: ChunkRow): RetrievedChunk {
  const deepLink = row.anchor ? `${row.source_url}#${row.anchor}` : row.source_url;
  return {
    id: Number(row.id),
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    headingPath: row.heading_path,
    anchor: row.anchor,
    content: row.content,
    sourceSystem: row.source_system,
    sourceUrl: row.source_url,
    title: row.title,
    deepLink,
    score: Number(row.score),
    vectorRank: row.vector_rank === null ? null : Number(row.vector_rank),
    ftsRank: row.fts_rank === null ? null : Number(row.fts_rank),
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

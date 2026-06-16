import { createHash } from 'crypto';
import { ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CONFIG, CerebroConfig } from '../config/config';
import { LocalAppendOnlyAnchor } from '../auth/delegation/local-anchor';
import { DatabaseService } from '../db/database.service';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
  embedOne,
  toVectorLiteral,
} from '../embedding/embedding.interface';
import { type Args, type AttestationAnchor } from '../totem-sdk';
import { decideDelegatedAction } from '../auth/delegation/policy-core';
import { PrincipalMappingService } from './principal-mapping.service';
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
    private readonly mapping: PrincipalMappingService,
    @Optional() @Inject(LocalAppendOnlyAnchor) private readonly anchor?: AttestationAnchor,
  ) {}

  async search(query: string, options: RetrievalOptions): Promise<RetrievedChunk[]> {
    const topK = options.topK ?? this.config.retrieval.topK;
    const candidates = options.candidates ?? this.config.retrieval.candidates;
    const { rrfK, ftsConfig } = this.config.retrieval;

    // Defense in depth (P1.2): in oidc modes every authenticated caller holds
    // at least entra-user:<oid>, so an empty set means some code path minted an
    // identity without going through token validation — refuse loudly instead
    // of silently degrading to public-only.
    if (options.identity.mode !== 'dev-header' && options.identity.principals.length === 0) {
      throw new Error('Invariant violation: authenticated identity with empty principal set');
    }

    // Principal-mapping expansion happens HERE, inside the enforcement point,
    // so a caller can neither fabricate nor forget it (P1.1).
    const callerPrincipals = await this.mapping.expand(options.identity);

    // The human ACL set (caller principals + public floor) is the VISIBILITY
    // FLOOR. Delegation can only NARROW it and the requested sources; it never
    // widens (docs/Totem_Integration.md §4). Runs only for a delegated caller.
    let aclPrincipals = dedupe([...callerPrincipals, this.config.acl.publicPrincipal]);
    let effectiveSources = options.sourceSystems;
    if (options.identity.delegation) {
      const narrowed = await this.enforceDelegation(options, aclPrincipals);
      aclPrincipals = narrowed.aclPrincipals;
      effectiveSources = narrowed.effectiveSources;
    }

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
      // The defining permission-safety guarantee. aclPrincipals = the human's
      // expanded principals + the public floor, already narrowed by any
      // delegation allow-list above (strict intersection, never widened).
      filters.push(`acl_principals && ${p(aclPrincipals)}::text[]`);
    }
    if (effectiveSources && effectiveSources.length > 0) {
      filters.push(`source_system = ANY(${p(effectiveSources)})`);
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

  /**
   * Enforce the delegated scope (docs/Totem_Integration.md §4): authorize the
   * action against the grant (command narrowing + scalar policy), set-intersect
   * the requested sources and the ACL principals with the grant's allow-lists,
   * audit the decision, and DENY (403) on any over-scope. Returns the narrowed
   * ACL principal set + effective sources for the SQL pre-filter. The human ACL
   * is still the floor — this can only remove.
   */
  private async enforceDelegation(
    options: RetrievalOptions,
    aclPrincipals: string[],
  ): Promise<{ aclPrincipals: string[]; effectiveSources: string[] | undefined }> {
    const d = options.identity.delegation!;
    const topK = options.topK ?? this.config.retrieval.topK;
    const cmd = options.command ?? '/cerebro/search';
    const args: Args = {
      topK,
      ...(options.sourceSystems && options.sourceSystems.length > 0
        ? { sourceSystems: options.sourceSystems }
        : {}),
    };

    // The ONE policy core — shared with the Phase-2 MCP PDP (no forked enforcement).
    const reasons = [
      ...decideDelegatedAction(d, { cmd, args, sourceSystems: options.sourceSystems }).reasons,
    ];

    // Source narrowing for the SQL filter: requested ∩ allowed (no request →
    // the allowed subset). The over-scope DENY is already captured in `reasons`.
    let effectiveSources = options.sourceSystems;
    if (d.sourcesAllow && d.sourcesAllow.length > 0) {
      const allow = new Set(d.sourcesAllow);
      effectiveSources =
        options.sourceSystems && options.sourceSystems.length > 0
          ? options.sourceSystems.filter((s) => allow.has(s))
          : [...allow];
    }

    // Principal narrowing (Decision E: the public floor is narrowed too when an
    // allow-list is present) — strict intersection, never widens.
    let narrowedPrincipals = aclPrincipals;
    if (d.principalsAllow && d.principalsAllow.length > 0) {
      const allow = new Set(d.principalsAllow);
      narrowedPrincipals = aclPrincipals.filter((pr) => allow.has(pr));
    }

    const ok = reasons.length === 0;
    await this.recordDecision(options.identity, cmd, args, ok ? 'allow' : 'deny', reasons);
    if (!ok) {
      // No data on an over-scope call (fail-closed). 403 in REST; the MCP layer
      // maps the thrown exception to an isError tool result.
      throw new ForbiddenException(`Delegation denied: ${reasons.join(', ')}`);
    }
    return { aclPrincipals: narrowedPrincipals, effectiveSources };
  }

  private async recordDecision(
    identity: RetrievalOptions['identity'],
    cmd: string,
    args: Args,
    decision: 'allow' | 'deny',
    reasons: string[],
  ): Promise<void> {
    if (!this.anchor) return;
    const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    await this.anchor.record({
      ts: new Date().toISOString(),
      subject: identity.subject,
      actor: identity.delegation?.agent,
      action: cmd,
      argsDigest: `sha256:${digest}`,
      decision,
      reasons,
      delegationId: identity.delegation?.delegationId,
    });
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

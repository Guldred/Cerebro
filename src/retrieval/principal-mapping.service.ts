import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, CerebroConfig } from '../config/config';
import { CallerIdentity } from '../auth/identity.types';
import { DatabaseService } from '../db/database.service';

/**
 * Query-time principal expansion (Plan_Review P1.1). Expands the caller's
 * Entra principals into the source-native principals they hold via the
 * principal_mappings table. Lives INSIDE the enforcement point — only
 * RetrievalService calls it — so no consumer can run a query with an
 * unexpanded (or fabricated) principal set.
 *
 * Fail-closed: a DB error here aborts the query (the caller sees an error,
 * never an unfiltered or differently-filtered result), and a source principal
 * without a mapping row is unreachable by construction.
 *
 * The cache TTL defaults to 0 (no cache): a deleted mapping row revokes on the
 * very next query, via one indexed SELECT. A TTL caches the whole table and is
 * an explicit, eyes-open trade of revocation latency for load.
 */
@Injectable()
export class PrincipalMappingService {
  private cache: { loadedAt: number; byEntra: Map<string, string[]> } | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: CerebroConfig,
    private readonly db: DatabaseService,
  ) {}

  /**
   * The caller's full effective principal set: their own principals plus every
   * source-native principal mapped to any of them. Dev-header principals pass
   * through expansion too, so demo/eval fixtures exercise the same path.
   */
  async expand(identity: CallerIdentity): Promise<string[]> {
    const own = [...identity.principals];
    if (own.length === 0) return own;

    const expanded = new Set<string>(own);
    const ttl = this.config.mapping.cacheTtlMs;

    if (ttl > 0) {
      const byEntra = await this.cachedTable(ttl);
      for (const p of own) for (const s of byEntra.get(p) ?? []) expanded.add(s);
    } else {
      const res = await this.db.query<{ source_principal: string }>(
        'SELECT source_principal FROM principal_mappings WHERE entra_principal = ANY($1)',
        [own],
      );
      for (const row of res.rows) expanded.add(row.source_principal);
    }
    return [...expanded];
  }

  private async cachedTable(ttl: number): Promise<Map<string, string[]>> {
    if (this.cache && Date.now() - this.cache.loadedAt < ttl) return this.cache.byEntra;
    const res = await this.db.query<{ entra_principal: string; source_principal: string }>(
      'SELECT entra_principal, source_principal FROM principal_mappings',
    );
    const byEntra = new Map<string, string[]>();
    for (const row of res.rows) {
      const list = byEntra.get(row.entra_principal) ?? [];
      list.push(row.source_principal);
      byEntra.set(row.entra_principal, list);
    }
    this.cache = { loadedAt: Date.now(), byEntra };
    return byEntra;
  }
}

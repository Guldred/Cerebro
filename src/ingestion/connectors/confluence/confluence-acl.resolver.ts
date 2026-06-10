import { computeEffectiveReadSet, PermissionLayer } from '../../acl/effective-read-set';

/** Read-restriction shape shared by pages and ancestors (Confluence REST). */
export interface ConfluenceRestrictions {
  read?: {
    restrictions?: {
      user?: { results?: { accountId: string }[] };
      group?: { results?: { name: string }[] };
    };
  };
}

export interface ConfluencePageAclInput {
  spaceKey?: string;
  restrictions?: ConfluenceRestrictions;
  /** Ancestor content ids, root first (Confluence returns them in that order). */
  ancestorIds: string[];
}

/** Fetches one ancestor's read restrictions. Throws on API failure. */
export type RestrictionFetcher = (contentId: string) => Promise<ConfluenceRestrictions>;

/** Raised when permissions cannot be resolved — the caller must QUARANTINE the
 *  document (zero ACLs, acl_status='failed'), never default it to anything. */
export class AclResolutionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AclResolutionError';
  }
}

/**
 * Confluence Cloud effective read-set (Plan_Review P1.1). Confluence layering:
 * space permissions are the base; the page AND every ancestor may carry a read
 * restriction, and a reader must satisfy all of them (a restricted ancestor
 * restricts its whole subtree). This resolver flattens that into the pure
 * PermissionLayer IR:
 *
 *   base          — symbolic confluence-space:<KEY>, resolved to the caller's
 *                   Entra groups via principal_mappings at query time. A space
 *                   key listed in `certifiedPublicSpaces` (explicitly certified
 *                   by an admin, P1.1 "non-public unless certified public")
 *                   becomes `public` instead.
 *   restrictions  — one layer per RESTRICTED level (page + restricted
 *                   ancestors), allow = its user/group lists, deny = [] (the
 *                   Cloud API has no explicit deny — the IR supports it for
 *                   SharePoint later).
 *
 * Ancestor restrictions are fetched per id and memoized for the lifetime of
 * this resolver instance (one crawl). ANY fetch failure throws
 * AclResolutionError — fail closed, no partial resolution.
 */
export class ConfluenceAclResolver {
  private readonly ancestorCache = new Map<string, Promise<ConfluenceRestrictions>>();

  constructor(
    private readonly fetchRestrictions: RestrictionFetcher,
    private readonly certifiedPublicSpaces: ReadonlySet<string>,
  ) {}

  async resolve(page: ConfluencePageAclInput): Promise<string[]> {
    const layers: PermissionLayer[] = [];

    for (const ancestorId of page.ancestorIds) {
      let restrictions: ConfluenceRestrictions;
      try {
        restrictions = await this.cachedRestrictions(ancestorId);
      } catch (err) {
        throw new AclResolutionError(
          `Failed to fetch read restrictions for ancestor ${ancestorId}`,
          err,
        );
      }
      const layer = toLayer(restrictions);
      if (layer) layers.push(layer);
    }

    const pageLayer = toLayer(page.restrictions);
    if (pageLayer) layers.push(pageLayer);

    return computeEffectiveReadSet({ base: this.baseFor(page.spaceKey), restrictions: layers });
  }

  private baseFor(spaceKey?: string): string[] {
    // No space key at all: nothing to anchor access to — resolve to NO
    // principals (invisible) rather than guessing.
    if (!spaceKey) return [];
    if (this.certifiedPublicSpaces.has(spaceKey)) return ['public'];
    return [`confluence-space:${spaceKey}`];
  }

  private cachedRestrictions(contentId: string): Promise<ConfluenceRestrictions> {
    let cached = this.ancestorCache.get(contentId);
    if (!cached) {
      cached = this.fetchRestrictions(contentId);
      // A failed fetch must not be memoized as permanently failed — drop it so
      // a later document sharing this ancestor can retry.
      cached.catch(() => this.ancestorCache.delete(contentId));
      this.ancestorCache.set(contentId, cached);
    }
    return cached;
  }
}

/** A restriction layer exists only when the level actually restricts reads. */
function toLayer(restrictions?: ConfluenceRestrictions): PermissionLayer | null {
  const read = restrictions?.read?.restrictions;
  const groups = (read?.group?.results ?? []).map((g) => `confluence-group:${g.name}`);
  const users = (read?.user?.results ?? []).map((u) => `confluence-user:${u.accountId}`);
  const allow = [...groups, ...users];
  return allow.length > 0 ? { allow, deny: [] } : null;
}

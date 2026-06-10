/**
 * Pure effective-read-set resolution (Plan_Review P1.1). Source connectors
 * flatten their layered permission model into this IR at ingest; the resolved
 * set is what lands on chunks. Zero I/O — fully unit-testable offline.
 *
 * The IR is deny-capable even though Confluence Cloud read restrictions are
 * allow-lists only: SharePoint/Teams explicit DENY (named in P1.1) slots in as
 * a populated `deny` without redesigning the resolver.
 */
export interface PermissionLayer {
  /** Principals this layer allows to read (namespaced, e.g. confluence-group:x). */
  allow: string[];
  /** Principals this layer explicitly denies. Deny beats allow, always. */
  deny: string[];
}

export interface ReadSetInput {
  /**
   * The unrestricted-content base, e.g. the symbolic space principal
   * [confluence-space:KEY] (resolved to Entra groups via principal_mappings at
   * query time) or [public] for a certified-public space.
   */
  base: string[];
  /**
   * One layer per RESTRICTED level in the inheritance chain: the page itself
   * and every restricted ancestor. Unrestricted levels contribute no layer.
   */
  restrictions: PermissionLayer[];
}

/**
 * Resolution semantics (decided by the Phase-2 design review):
 *
 * 1. No restriction layers → the base set applies.
 * 2. Restriction layers REPLACE the base (they do not intersect with it): a
 *    page restricted to `eng-leads` inside the `eng` space must stay readable
 *    by eng-leads even though that subgroup is not literally in the space's
 *    allow list. DOCUMENTED OVER-GRANT EDGE: a principal on a restriction
 *    list that lacks space view permission would be over-granted relative to
 *    Confluence itself (which requires both); accepting this beats sending the
 *    dominant restricted-to-subgroup pattern dark for everyone.
 * 3. Multiple restriction layers intersect SYMBOLICALLY (a reader must satisfy
 *    the page's restriction AND every restricted ancestor's). A principal
 *    spelled differently across layers (user listed on one, their group on
 *    another) falls out — under-grant, never over-grant; resolving that needs
 *    a membership oracle, a documented future seam.
 * 4. Deny-over-allow: every deny from every layer (and the base layer) is
 *    subtracted LAST, so no allow at any level can resurrect a denied
 *    principal.
 */
export function computeEffectiveReadSet(input: ReadSetInput, denies: string[] = []): string[] {
  let effective: Set<string>;

  if (input.restrictions.length === 0) {
    effective = new Set(input.base);
  } else {
    effective = new Set(input.restrictions[0].allow);
    for (const layer of input.restrictions.slice(1)) {
      const allowed = new Set(layer.allow);
      effective = new Set([...effective].filter((p) => allowed.has(p)));
    }
  }

  const allDenies = new Set([...denies, ...input.restrictions.flatMap((l) => l.deny)]);
  return [...effective].filter((p) => !allDenies.has(p)).sort();
}

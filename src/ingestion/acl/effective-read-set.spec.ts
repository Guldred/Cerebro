import { computeEffectiveReadSet } from './effective-read-set';

/**
 * Phase-2 exit gates for the pure resolver (Plan_Review P1.1): deny-over-allow,
 * inheritance break, replacement semantics, and the documented over-grant edge —
 * each pinned so a semantics change cannot land silently.
 */
describe('computeEffectiveReadSet', () => {
  const base = ['confluence-space:ENG'];

  it('unrestricted content gets the base (symbolic space principal)', () => {
    expect(computeEffectiveReadSet({ base, restrictions: [] })).toEqual(['confluence-space:ENG']);
  });

  it('a restriction layer REPLACES the base — the space principal must NOT survive', () => {
    const result = computeEffectiveReadSet({
      base,
      restrictions: [{ allow: ['confluence-group:eng-leads'], deny: [] }],
    });
    // The dominant real-world pattern: page restricted to a subgroup of the
    // space group stays readable by that subgroup…
    expect(result).toEqual(['confluence-group:eng-leads']);
    // …and the space-wide audience is locked out (no base leak-through).
    expect(result).not.toContain('confluence-space:ENG');
  });

  it('INHERITANCE BREAK: a restricted ancestor restricts the whole subtree (layer intersection)', () => {
    const result = computeEffectiveReadSet({
      base,
      restrictions: [
        // restricted ancestor: leads + auditors
        { allow: ['confluence-group:eng-leads', 'confluence-group:auditors'], deny: [] },
        // the page itself: leads + interns
        { allow: ['confluence-group:eng-leads', 'confluence-user:intern-1'], deny: [] },
      ],
    });
    // A reader must satisfy EVERY restricted level.
    expect(result).toEqual(['confluence-group:eng-leads']);
  });

  it('DENY-OVER-ALLOW: a deny at any layer survives every allow', () => {
    const result = computeEffectiveReadSet({
      base,
      restrictions: [
        { allow: ['confluence-group:eng', 'confluence-user:mallory'], deny: [] },
        { allow: ['confluence-group:eng', 'confluence-user:mallory'], deny: ['confluence-user:mallory'] },
      ],
    });
    expect(result).toEqual(['confluence-group:eng']);
  });

  it('deny applies to the base set too (future SharePoint-style source)', () => {
    const result = computeEffectiveReadSet(
      { base: ['sharepoint-site:HR', 'sharepoint-user:bob'], restrictions: [] },
      ['sharepoint-user:bob'],
    );
    expect(result).toEqual(['sharepoint-site:HR']);
  });

  it('an empty base with no restrictions resolves to NOBODY (never public)', () => {
    expect(computeEffectiveReadSet({ base: [], restrictions: [] })).toEqual([]);
  });

  it('disjoint restriction layers resolve to NOBODY (under-grant, never over-grant)', () => {
    const result = computeEffectiveReadSet({
      base,
      restrictions: [
        { allow: ['confluence-group:a'], deny: [] },
        { allow: ['confluence-group:b'], deny: [] },
      ],
    });
    expect(result).toEqual([]);
  });

  it('DOCUMENTED OVER-GRANT EDGE: a restriction-listed principal is granted even without provable space access', () => {
    // Confluence itself requires BOTH space view permission AND restriction
    // membership. Without a membership oracle we cannot verify space access for
    // restriction-listed principals; the design review accepted granting them
    // (replacement semantics) over darkening the restricted-to-subgroup
    // pattern. This pin makes that decision explicit — if it changes, this
    // test must change WITH a design note.
    const result = computeEffectiveReadSet({
      base: ['confluence-space:HR'],
      restrictions: [{ allow: ['confluence-user:external-contractor'], deny: [] }],
    });
    expect(result).toEqual(['confluence-user:external-contractor']);
  });
});

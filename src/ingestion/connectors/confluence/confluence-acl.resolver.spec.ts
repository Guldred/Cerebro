import {
  AclResolutionError,
  ConfluenceAclResolver,
  ConfluenceRestrictions,
} from './confluence-acl.resolver';

function restrictionsFor(groups: string[], users: string[] = []): ConfluenceRestrictions {
  return {
    read: {
      restrictions: {
        group: { results: groups.map((name) => ({ name })) },
        user: { results: users.map((accountId) => ({ accountId })) },
      },
    },
  };
}

const NONE: ConfluenceRestrictions = {};

describe('ConfluenceAclResolver', () => {
  it('unrestricted page in an uncertified space → symbolic space principal (mapping-table resolved)', async () => {
    const resolver = new ConfluenceAclResolver(async () => NONE, new Set());
    await expect(
      resolver.resolve({ spaceKey: 'ENG', restrictions: NONE, ancestorIds: [] }),
    ).resolves.toEqual(['confluence-space:ENG']);
  });

  it('unrestricted page in a CERTIFIED public space → public (P1.1: certified-only)', async () => {
    const resolver = new ConfluenceAclResolver(async () => NONE, new Set(['INTRANET']));
    await expect(
      resolver.resolve({ spaceKey: 'INTRANET', restrictions: NONE, ancestorIds: [] }),
    ).resolves.toEqual(['public']);
  });

  it('page without a space key resolves to NOBODY — never a guess', async () => {
    const resolver = new ConfluenceAclResolver(async () => NONE, new Set());
    await expect(resolver.resolve({ restrictions: NONE, ancestorIds: [] })).resolves.toEqual([]);
  });

  it('page restriction replaces the space base', async () => {
    const resolver = new ConfluenceAclResolver(async () => NONE, new Set());
    await expect(
      resolver.resolve({
        spaceKey: 'ENG',
        restrictions: restrictionsFor(['eng-leads'], ['u-1']),
        ancestorIds: [],
      }),
    ).resolves.toEqual(['confluence-group:eng-leads', 'confluence-user:u-1']);
  });

  it('INHERITANCE: a restricted ancestor narrows an unrestricted page', async () => {
    const byId: Record<string, ConfluenceRestrictions> = {
      '100': NONE, // unrestricted grandparent contributes no layer
      '200': restrictionsFor(['eng-leads']),
    };
    const resolver = new ConfluenceAclResolver(async (id) => byId[id], new Set());
    await expect(
      resolver.resolve({ spaceKey: 'ENG', restrictions: NONE, ancestorIds: ['100', '200'] }),
    ).resolves.toEqual(['confluence-group:eng-leads']);
  });

  it('INHERITANCE BREAK exit gate: page restriction intersects the restricted ancestor', async () => {
    const resolver = new ConfluenceAclResolver(
      async () => restrictionsFor(['eng-leads', 'auditors']),
      new Set(),
    );
    await expect(
      resolver.resolve({
        spaceKey: 'ENG',
        restrictions: restrictionsFor(['eng-leads', 'interns']),
        ancestorIds: ['200'],
      }),
    ).resolves.toEqual(['confluence-group:eng-leads']);
  });

  it('FAIL-CLOSED: an ancestor fetch failure raises AclResolutionError (caller quarantines)', async () => {
    const resolver = new ConfluenceAclResolver(
      async () => {
        throw new Error('503 from Confluence');
      },
      new Set(),
    );
    await expect(
      resolver.resolve({ spaceKey: 'ENG', restrictions: NONE, ancestorIds: ['200'] }),
    ).rejects.toThrow(AclResolutionError);
  });

  it('memoizes ancestor restriction fetches across pages of one crawl', async () => {
    const fetcher = jest.fn(async () => restrictionsFor(['eng-leads']));
    const resolver = new ConfluenceAclResolver(fetcher, new Set());
    await resolver.resolve({ spaceKey: 'ENG', restrictions: NONE, ancestorIds: ['200'] });
    await resolver.resolve({ spaceKey: 'ENG', restrictions: NONE, ancestorIds: ['200'] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does NOT memoize a failed ancestor fetch (later documents may retry)', async () => {
    const fetcher = jest
      .fn<Promise<ConfluenceRestrictions>, [string]>()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(restrictionsFor(['eng-leads']));
    const resolver = new ConfluenceAclResolver(fetcher, new Set());

    await expect(
      resolver.resolve({ spaceKey: 'ENG', restrictions: NONE, ancestorIds: ['200'] }),
    ).rejects.toThrow(AclResolutionError);
    await expect(
      resolver.resolve({ spaceKey: 'ENG', restrictions: NONE, ancestorIds: ['200'] }),
    ).resolves.toEqual(['confluence-group:eng-leads']);
  });

  // P1.1 names attachment-vs-page ACL divergence as a Phase-2 exit gate. The
  // object-level attachment resolver is an explicit, signed-off scope
  // exclusion for this slice (attachments are not ingested at all yet — no
  // attachment content can leak). Two TRIPWIRES enforce the exclusion until
  // then: the connector spec pins the crawl CQL to type=page, and toDocument
  // quarantines any non-page content type outright — so shipping attachment
  // ingestion without an object-level resolver turns tests red instead of
  // silently inheriting page ACLs.
  it.todo('attachment ACLs resolve at the OBJECT level, never inherited from the parent page');
});

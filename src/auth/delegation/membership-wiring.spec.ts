import { CerebroConfig } from '../../config/config';
import { DatabaseService } from '../../db/database.service';
import { CallerIdentity } from '../identity.types';
import { GitHubMembershipChecker, selectMembershipChecker } from './github-membership';
import { LocalAppendOnlyAnchor } from './local-anchor';
import { MembershipChecker } from './membership';
import { PolicyDecisionPoint } from './pdp';
import type { AuthorizationDecisionRecord, RevocationStatus } from '../../totem-sdk';

/**
 * Wiring exit gate (per the design review): prove the WHOLE chain
 * config → selectMembershipChecker → live oracle → PDP → AARP step-up, with the
 * github source flagged sensitive. The three-way membership logic itself is
 * pinned in github-membership.spec / pdp.spec — this asserts the env-selected
 * connector-backed checker actually drives the boundary decision.
 */
function configFor(checker: 'unverified' | 'github'): CerebroConfig {
  return {
    delegation: {
      sensitiveSources: ['github'],
      membership: { checker, github: { org: 'acme', token: 'ghp_member', apiUrl: '' } },
    },
  } as unknown as CerebroConfig;
}

function fakeDb(login: string | null): DatabaseService {
  return {
    query: async () => ({ rows: login ? [{ source_login: login }] : [] }),
  } as unknown as DatabaseService;
}

/** A PDP driven by the given checker + a stub anchor; captures audit records. */
function pdpWith(config: CerebroConfig, checker: MembershipChecker) {
  const records: AuthorizationDecisionRecord[] = [];
  const anchor = {
    isRevoked: async (): Promise<RevocationStatus> => ({ revoked: false }),
    record: async (r: AuthorizationDecisionRecord) => {
      records.push(r);
      return { handle: 'audit:1' };
    },
  } as unknown as LocalAppendOnlyAnchor;
  return { pdp: new PolicyDecisionPoint(config, checker, anchor), records };
}

/** The github checker the factory would build, but handed a deterministic fetch. */
function githubChecker(db: DatabaseService, status: number): GitHubMembershipChecker {
  return new GitHubMembershipChecker(configFor('github').delegation.membership.github, db, async () => ({ status }));
}

const delegated: CallerIdentity = {
  subject: 'human-1',
  principals: ['entra-user:human-1', 'entra-group:hr'],
  mode: 'oidc',
  delegation: { agent: 'agent:x', grant: { cmd: '/cerebro/search', pol: [] }, delegationId: 'jti-1' },
};
const action = { cmd: '/cerebro/search', args: { topK: 5 }, sourceSystems: ['github'] };

describe('membership checker wiring (config → factory → PDP)', () => {
  it('the factory selects the connector-backed checker from config', () => {
    expect(selectMembershipChecker(configFor('github'), fakeDb(null))).toBeInstanceOf(GitHubMembershipChecker);
  });

  it('github checker + no identity link → unknown → PDP needs-approval (AARP step-up)', async () => {
    const { pdp, records } = pdpWith(configFor('github'), githubChecker(fakeDb(null), 204));
    const dec = await pdp.decide(delegated, action);
    expect(dec.decision).toBe('needs-approval');
    expect(dec.prerequisites?.[0]?.sourceSystem).toBe('github');
    expect(records[0]!.decision).toBe('needs-approval');
  });

  it('github checker + linked + LIVE 204 (member) → confirmed → PDP allow', async () => {
    const { pdp } = pdpWith(configFor('github'), githubChecker(fakeDb('octocat'), 204));
    expect((await pdp.decide(delegated, action)).decision).toBe('allow');
  });

  it('github checker + linked + LIVE 404 (removed at source) → revoked → PDP deny', async () => {
    const { pdp } = pdpWith(configFor('github'), githubChecker(fakeDb('ex-employee'), 404));
    const dec = await pdp.decide(delegated, action);
    expect(dec.decision).toBe('deny');
    expect(dec.reasons.some((r) => r.startsWith('delegation/membership-revoked'))).toBe(true);
  });

  it('the default (unverified) checker steps up the same sensitive source', async () => {
    const { pdp } = pdpWith(configFor('unverified'), selectMembershipChecker(configFor('unverified'), fakeDb('x')));
    expect((await pdp.decide(delegated, action)).decision).toBe('needs-approval');
  });
});

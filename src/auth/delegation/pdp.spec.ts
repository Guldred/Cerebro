import { CerebroConfig } from '../../config/config';
import { CallerIdentity, DelegationContext } from '../identity.types';
import { LocalAppendOnlyAnchor } from './local-anchor';
import { MembershipChecker, MembershipStatus } from './membership';
import { PolicyDecisionPoint } from './pdp';
import type { AuthorizationDecisionRecord, RevocationStatus } from '../../totem-sdk';

/**
 * PDP unit suite. Drives the decision with a checker double + fake anchor (per
 * the design review: prove the Phase-2 path with a MembershipChecker double, not
 * by deleting a mapping row — which Phase 1 already denies).
 */
function makePdp(opts: { sensitiveSources?: string[]; revoked?: boolean; membership?: MembershipStatus }) {
  const config = {
    delegation: { sensitiveSources: opts.sensitiveSources ?? [] },
  } as CerebroConfig;
  const records: AuthorizationDecisionRecord[] = [];
  const anchor = {
    isRevoked: async (): Promise<RevocationStatus> => ({ revoked: opts.revoked ?? false }),
    record: async (r: AuthorizationDecisionRecord) => {
      records.push(r);
      return { handle: 'audit:1' };
    },
  } as unknown as LocalAppendOnlyAnchor;
  const checker: MembershipChecker = { check: async () => opts.membership ?? 'unknown' };
  return { pdp: new PolicyDecisionPoint(config, checker, anchor), records };
}

const delegated = (over: Partial<DelegationContext> = {}): CallerIdentity => ({
  subject: 'human-1',
  principals: ['entra-user:human-1', 'entra-group:hr'],
  mode: 'oidc',
  delegation: {
    agent: 'agent:x',
    grant: { cmd: '/cerebro/search', pol: [] },
    delegationId: 'jti-1',
    ...over,
  },
});
const action = (over: Record<string, unknown> = {}) => ({ cmd: '/cerebro/search', args: { topK: 5 }, ...over });

describe('PolicyDecisionPoint', () => {
  it('non-delegated caller → allow (PDP does not apply)', async () => {
    const { pdp } = makePdp({});
    const id: CallerIdentity = { subject: 'u', principals: ['entra-user:u'], mode: 'oidc' };
    expect((await pdp.decide(id, action())).decision).toBe('allow');
  });

  it('delegated, in-scope, no sensitive source → allow (audited)', async () => {
    const { pdp, records } = makePdp({});
    expect((await pdp.decide(delegated(), action())).decision).toBe('allow');
    expect(records[0]!.decision).toBe('allow');
  });

  it('over-scope command → deny', async () => {
    const { pdp } = makePdp({});
    const dec = await pdp.decide(delegated({ grant: { cmd: '/cerebro/admin' } }), action());
    expect(dec.decision).toBe('deny');
    expect(dec.reasons).toContain('delegation/command-not-permitted');
  });

  it('revoked delegation → deny (defense-in-depth re-confirm)', async () => {
    const { pdp } = makePdp({ revoked: true });
    const dec = await pdp.decide(delegated(), action());
    expect(dec.decision).toBe('deny');
    expect(dec.reasons).toContain('delegation/revoked');
  });

  it('sensitive source + membership unknown → needs-approval (AARP step-up)', async () => {
    const { pdp, records } = makePdp({ sensitiveSources: ['confluence'], membership: 'unknown' });
    const dec = await pdp.decide(delegated(), action({ sourceSystems: ['confluence'] }));
    expect(dec.decision).toBe('needs-approval');
    expect(dec.prerequisites?.[0]?.type).toBe('membership-reverification');
    expect(dec.prerequisites?.[0]?.sourceSystem).toBe('confluence');
    expect(records[0]!.decision).toBe('needs-approval');
  });

  it('sensitive source + membership revoked → deny', async () => {
    const { pdp } = makePdp({ sensitiveSources: ['confluence'], membership: 'revoked' });
    const dec = await pdp.decide(delegated(), action({ sourceSystems: ['confluence'] }));
    expect(dec.decision).toBe('deny');
    expect(dec.reasons.some((r) => r.startsWith('delegation/membership-revoked'))).toBe(true);
  });

  it('sensitive source + membership confirmed → allow', async () => {
    const { pdp } = makePdp({ sensitiveSources: ['confluence'], membership: 'confirmed' });
    expect((await pdp.decide(delegated(), action({ sourceSystems: ['confluence'] }))).decision).toBe('allow');
  });

  it('a request scoped to a NON-sensitive source does not trigger a step-up', async () => {
    const { pdp } = makePdp({ sensitiveSources: ['confluence'], membership: 'unknown' });
    expect((await pdp.decide(delegated(), action({ sourceSystems: ['github'] }))).decision).toBe('allow');
  });
});

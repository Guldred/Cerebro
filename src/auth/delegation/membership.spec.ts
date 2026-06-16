import { UnverifiedMembershipChecker } from './membership';
import type { CallerIdentity } from '../identity.types';

describe('UnverifiedMembershipChecker', () => {
  it('returns "unknown" — it never pretends to confirm what it cannot (→ PDP step-up)', async () => {
    const checker = new UnverifiedMembershipChecker();
    const identity: CallerIdentity = { subject: 'human-1', principals: ['entra-user:human-1'], mode: 'oidc' };
    expect(await checker.check(identity, 'confluence')).toBe('unknown');
  });
});

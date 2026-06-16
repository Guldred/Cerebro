import { Global, Logger, Module, OnApplicationBootstrap, Inject } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CONFIG, CerebroConfig } from '../config/config';
import { ConfigModule } from '../config/config.module';
import { AuthGuard } from './auth.guard';
import { DELEGATION_VERIFIER, JoseDelegationVerifier } from './delegation/delegation-verifier';
import { LocalAppendOnlyAnchor } from './delegation/local-anchor';
import { MEMBERSHIP_CHECKER, UnverifiedMembershipChecker } from './delegation/membership';
import { PolicyDecisionPoint } from './delegation/pdp';
import { IdentityService } from './identity.service';

/**
 * Identity resolution for every consumer path (Plan_Review P1.2). Global so the
 * MCP server and scripts can resolve IdentityService without importing the
 * module explicitly. The guard is registered app-wide; only @Public() endpoints
 * (health) skip it.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    IdentityService,
    LocalAppendOnlyAnchor,
    {
      // The delegation verifier (off unless DELEGATION_ENABLED). Built once with
      // the AttestationAnchor as its revocation source; inert when disabled.
      provide: DELEGATION_VERIFIER,
      useFactory: (config: CerebroConfig, anchor: LocalAppendOnlyAnchor) =>
        new JoseDelegationVerifier(config.delegation, anchor),
      inject: [CONFIG, LocalAppendOnlyAnchor],
    },
    // Phase-2 PDP + its membership oracle (inert unless DELEGATION_PDP_ENABLED).
    { provide: MEMBERSHIP_CHECKER, useClass: UnverifiedMembershipChecker },
    PolicyDecisionPoint,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [IdentityService, LocalAppendOnlyAnchor, PolicyDecisionPoint],
})
export class AuthModule implements OnApplicationBootstrap {
  private readonly log = new Logger(AuthModule.name);

  constructor(@Inject(CONFIG) private readonly config: CerebroConfig) {}

  onApplicationBootstrap(): void {
    // Loud, unmissable: any boot that is not full OIDC announces itself once.
    if (this.config.auth.mode === 'dev-header') {
      this.log.warn(
        'AUTH_MODE=dev-header — CLIENT-ASSERTED identity (x-cerebro-principals is trusted ' +
          'verbatim), NOT for production (production boot refuses this mode).',
      );
    } else if (this.config.auth.mode === 'local-oidc') {
      this.log.warn(
        'AUTH_MODE=local-oidc — tokens are fully validated, but against a LOCAL file trust ' +
          'root, NOT for production (production boot refuses this mode).',
      );
    }
  }
}

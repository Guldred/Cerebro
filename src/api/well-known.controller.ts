import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { CONFIG, CerebroConfig } from '../config/config';

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata. Lets MCP clients discover the
 * accepted authorization server(s) and scopes for this resource (the discovery
 * MCP expects). @Public, like the health check — it is unauthenticated metadata.
 *
 * When delegation is enabled the delegation mint/STS issuer is advertised
 * alongside the primary OIDC issuer, so a client knows where to obtain a
 * delegated token.
 */
@Public()
@Controller('.well-known')
export class WellKnownController {
  constructor(@Inject(CONFIG) private readonly config: CerebroConfig) {}

  @Get('oauth-protected-resource')
  protectedResource() {
    const authorizationServers = [this.config.auth.issuer].filter(Boolean);
    if (this.config.delegation.enabled && this.config.delegation.issuer) {
      authorizationServers.push(this.config.delegation.issuer);
    }
    return {
      resource: this.config.auth.audience,
      authorization_servers: authorizationServers,
      scopes_supported: ['cerebro.search', 'cerebro.query'],
      bearer_methods_supported: ['header'],
    };
  }
}

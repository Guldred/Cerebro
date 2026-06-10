import { promises as fs } from 'fs';
import { IdentityService } from '../auth/identity.service';
import { CallerIdentity, IdentityError } from '../auth/identity.types';
import { CerebroConfig } from '../config/config';

/**
 * End-user identity for the stdio MCP path (Plan_Review P1.2).
 *
 * oidc / local-oidc — the end-user's bearer token lives in MCP_USER_TOKEN_FILE,
 * placed there by the launching agent host. It is re-read and RE-VERIFIED on
 * EVERY tool call (rotation-safe, revocation-safe). The token deliberately
 * never travels as a tool argument: tool arguments transit the model context,
 * where a live credential could be exfiltrated by indirect prompt injection
 * (Plan_Review P2) and would be persisted in agent transcripts. No token, an
 * unreadable file, or an over-permissive file mode (group/world-readable) is a
 * hard IDENTITY_REQUIRED reject — there is NO service-credential or
 * public-only fallback on this path.
 *
 * dev-header — the MVP stub: principals from the `principals` tool argument or
 * the CEREBRO_MCP_PRINCIPALS env var, identical to the REST header stub.
 */
export class McpIdentityProvider {
  constructor(
    private readonly config: CerebroConfig,
    private readonly identityService: IdentityService,
  ) {}

  async resolve(toolPrincipals?: string[]): Promise<CallerIdentity> {
    if (this.config.auth.mode === 'dev-header') {
      const principals = toolPrincipals ?? this.config.mcp.devPrincipals;
      return this.identityService.resolve({ devHeader: principals.join(',') });
    }

    const file = this.config.mcp.userTokenFile;
    if (!file) {
      throw new IdentityError(
        'IDENTITY_REQUIRED',
        'MCP_USER_TOKEN_FILE is not configured — every MCP tool call requires a resolvable ' +
          'end-user identity in oidc mode (no service-credential fallback)',
      );
    }

    let token: string;
    try {
      const stat = await fs.stat(file);
      // A bearer token readable by other users is a credential leak — refuse,
      // don't warn.
      if ((stat.mode & 0o077) !== 0) {
        throw new IdentityError(
          'IDENTITY_REQUIRED',
          `${file} is group/world-readable (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it`,
        );
      }
      token = (await fs.readFile(file, 'utf8')).trim();
    } catch (err) {
      if (err instanceof IdentityError) throw err;
      throw new IdentityError('IDENTITY_REQUIRED', `Cannot read MCP_USER_TOKEN_FILE: ${String(err)}`);
    }
    if (!token) {
      throw new IdentityError('IDENTITY_REQUIRED', `MCP_USER_TOKEN_FILE ${file} is empty`);
    }

    return this.identityService.resolve({ authorization: `Bearer ${token}` });
  }
}

import { promises as fs } from 'fs';
import * as path from 'path';
import { createLocalIdp } from '../auth/testing/token-factory';
import type { DelegationGrant } from '../totem-sdk';

/**
 * npm run auth:dev-delegation — mint a local trust root + a DELEGATED token for
 * the Totem delegation layer (DELEGATION_ENABLED). One local IdP serves as both
 * the OIDC and the delegation root (mirrors the eval delegation leg). Writes
 * .dev/delegation-jwks.json and prints the env lines + a signed delegated bearer
 * token. The on-chain anchor is OFF; zero external keys.
 *
 *   DEV_DLG_OID=...               human oid (default dev-user-1)
 *   DEV_DLG_GROUPS=hr,finance     human's groups (entitlement axis; default hr)
 *   DEV_DLG_AGENT=...             agent id (default agent:dev-copilot/instance-1)
 *   DEV_DLG_CMD=/cerebro/search   grant command (default /cerebro = full scope)
 */
async function main(): Promise<void> {
  const idp = await createLocalIdp();
  const dir = path.join(process.cwd(), '.dev');
  await fs.mkdir(dir, { recursive: true });
  const jwksPath = path.join(dir, 'delegation-jwks.json');
  await fs.writeFile(jwksPath, JSON.stringify(idp.jwks, null, 2));

  const oid = process.env.DEV_DLG_OID ?? 'dev-user-1';
  const groups = (process.env.DEV_DLG_GROUPS ?? 'hr')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const agent = process.env.DEV_DLG_AGENT ?? 'agent:dev-copilot/instance-1';
  const grant: DelegationGrant = { cmd: process.env.DEV_DLG_CMD ?? '/cerebro' };
  // 1h, within the DELEGATION_MAX_TTL_S ceiling (3600) printed below.
  const ttlS = 3600;
  const token = await idp.signDelegation({
    humanOid: oid,
    groups,
    agent,
    grant,
    scope: 'cerebro.search',
    expiresInS: ttlS,
  });

  console.log(`Delegation JWKS written to ${jwksPath}\n`);
  console.log('Env (one IdP as both OIDC + delegation trust root; chain OFF):');
  console.log(`  AUTH_MODE=local-oidc`);
  console.log(`  AUTH_OIDC_ISSUER=${idp.issuer}`);
  console.log(`  AUTH_OIDC_AUDIENCE=${idp.audience}`);
  console.log(`  AUTH_OIDC_JWKS_FILE=${jwksPath}`);
  console.log(`  DELEGATION_ENABLED=true`);
  console.log(`  DELEGATION_ISSUER=${idp.issuer}`);
  console.log(`  DELEGATION_AUDIENCE=${idp.audience}`);
  console.log(`  DELEGATION_JWKS_FILE=${jwksPath}`);
  console.log(`  DELEGATION_MAX_TTL_S=${ttlS}`);
  console.log(
    `\nDelegated bearer token (sub/oid=${oid}, groups=[${groups.join(',')}], ` +
      `act=${agent}, grant cmd=${grant.cmd}, ${ttlS / 3600}h):\n`,
  );
  console.log(token);
  console.log(
    `\nNOTE: the signing key is NOT persisted — rerun to mint more (it rewrites the JWKS).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

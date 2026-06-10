import { promises as fs } from 'fs';
import * as path from 'path';
import { createLocalIdp } from '../auth/testing/token-factory';

/**
 * npm run auth:dev-jwks — mint a local OIDC trust root for AUTH_MODE=local-oidc.
 * Writes .dev/jwks.json (point AUTH_OIDC_JWKS_FILE at it) and prints a signed
 * dev token plus the env lines to copy. The token is validated by the REAL
 * verifier — same code path as production, zero network.
 *
 *   node: principals come from the token's groups claim; pass extra groups via
 *   DEV_TOKEN_GROUPS=g1,g2 and a subject via DEV_TOKEN_OID=...
 */
async function main(): Promise<void> {
  const idp = await createLocalIdp();
  const dir = path.join(process.cwd(), '.dev');
  await fs.mkdir(dir, { recursive: true });
  const jwksPath = path.join(dir, 'jwks.json');
  await fs.writeFile(jwksPath, JSON.stringify(idp.jwks, null, 2));

  const oid = process.env.DEV_TOKEN_OID ?? 'dev-user-1';
  const groups = (process.env.DEV_TOKEN_GROUPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const token = await idp.signToken({ oid, groups, expiresIn: '8h' });

  console.log(`JWKS written to ${jwksPath}\n`);
  console.log('Env for local-oidc mode:');
  console.log(`  AUTH_MODE=local-oidc`);
  console.log(`  AUTH_OIDC_ISSUER=${idp.issuer}`);
  console.log(`  AUTH_OIDC_AUDIENCE=${idp.audience}`);
  console.log(`  AUTH_OIDC_JWKS_FILE=${jwksPath}`);
  console.log(`\nBearer token (oid=${oid}, groups=[${groups.join(',')}], 8h):\n`);
  console.log(token);
  console.log(
    `\nNOTE: the signing key is NOT persisted — rerun this script to mint more tokens` +
      ` (it rewrites the JWKS too).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

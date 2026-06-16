import 'reflect-metadata';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ForbiddenException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../db/database.service';
import { LocalAppendOnlyAnchor } from '../auth/delegation/local-anchor';
import { IdentityService } from '../auth/identity.service';
import { CallerIdentity, IdentityError } from '../auth/identity.types';
import { createLocalIdp, LocalIdp } from '../auth/testing/token-factory';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { RetrievedChunk } from '../retrieval/retrieval.types';
import type { DelegationGrant, Predicate } from '../totem-sdk';

/**
 * Eval harness (plan §13, moved to Phase 1 per critique P1). Measures Recall@k and
 * MRR against a labelled gold set, and — critically — treats any ACL leak (a
 * forbidden document surfacing for an unauthorized caller) as a hard failure.
 * Cross-lingual cases need a real multilingual model, so they are reported
 * separately and excluded from the gate when running on the fake provider.
 *
 * IDENTITY (Phase 2): every case resolves its caller through IdentityService —
 * the same minting point as REST and MCP. Two legs:
 *
 *   AUTH_MODE=dev-header (default) — case principals pass through the stub
 *     verbatim, byte-identical to the MVP behavior.
 *   EVAL_AUTH=local-oidc — the harness generates a throwaway RS256 trust root,
 *     boots the app in AUTH_MODE=local-oidc against it, and mints a REAL JWT
 *     per case (entra-group:* principals become groups claims). The production
 *     verifier code path — signature, issuer, audience, exp — gates the same
 *     gold set, fully offline. CI runs both legs.
 */
interface GoldCase {
  id: string;
  question: string;
  principals: string[];
  relevantDocIds: string[];
  forbiddenDocIds?: string[];
  expectNotFound?: boolean;
  crossLingual?: boolean;
  /** A required case that misses fails the eval outright — aggregate recall
   *  slack must not let a security-gate case regress silently. */
  required?: boolean;
  /**
   * Delegation spec (EVAL_AUTH=delegation leg ONLY). A case carrying this is
   * minted as a delegated token per these terms; cases WITH a delegation field
   * are SKIPPED in the dev-header / local-oidc legs (they are delegation tests).
   * Base cases (no delegation field) run as a full-scope delegation in the
   * delegation leg — proving delegation-with-full-scope behaves like the human.
   */
  delegation?: {
    agent?: string;
    /** Grant command path (default '/cerebro' = full scope over cerebro tools). */
    cmd?: string;
    pol?: Predicate[];
    sourcesAllow?: string[];
    principalsAllow?: string[];
    /** Mint with exp in the past (revocation-window/expiry case). */
    expired?: boolean;
    /** Revoke the minted delegation in the AttestationAnchor before the call. */
    revoked?: boolean;
  };
  /**
   * The case is EXPECTED to be denied at the boundary (over-scope / revoked /
   * expired) — IdentityError or ForbiddenException is the PASS condition, treated
   * as "no data". Without this flag such a throw fails the run (real error).
   */
  expectDenied?: boolean;
}
interface Gold {
  topK: number;
  recallThreshold: number;
  cases: GoldCase[];
}

const ENTRA_GROUP = 'entra-group:';
const ENTRA_USER = 'entra-user:';

/** Boot-time setup for the local-oidc leg: trust root + env, BEFORE Nest loads config. */
async function setupLocalOidc(): Promise<LocalIdp> {
  const idp = await createLocalIdp();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebro-eval-jwks-'));
  const jwksFile = path.join(dir, 'jwks.json');
  await fs.writeFile(jwksFile, JSON.stringify(idp.jwks));
  process.env.AUTH_MODE = 'local-oidc';
  process.env.AUTH_OIDC_ISSUER = idp.issuer;
  process.env.AUTH_OIDC_AUDIENCE = idp.audience;
  process.env.AUTH_OIDC_JWKS_FILE = jwksFile;
  return idp;
}

/**
 * Boot-time setup for the delegation leg: ONE local IdP serves as both the OIDC
 * trust root (config boot requires AUTH_MODE=local-oidc) and the delegation
 * trust root, and DELEGATION is enabled. Set BEFORE Nest loads config.
 */
async function setupDelegation(): Promise<LocalIdp> {
  const idp = await createLocalIdp();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebro-eval-deleg-'));
  const jwksFile = path.join(dir, 'jwks.json');
  await fs.writeFile(jwksFile, JSON.stringify(idp.jwks));
  process.env.AUTH_MODE = 'local-oidc';
  process.env.AUTH_OIDC_ISSUER = idp.issuer;
  process.env.AUTH_OIDC_AUDIENCE = idp.audience;
  process.env.AUTH_OIDC_JWKS_FILE = jwksFile;
  process.env.DELEGATION_ENABLED = 'true';
  process.env.DELEGATION_ISSUER = idp.issuer;
  process.env.DELEGATION_AUDIENCE = idp.audience;
  process.env.DELEGATION_JWKS_FILE = jwksFile;
  process.env.DELEGATION_MAX_TTL_S = '300';
  return idp;
}

/** A gold case's namespaced principals → the Entra (oid, groups) a token carries. */
function caseToEntra(c: GoldCase): { oid: string; groups: string[] } {
  const groups: string[] = [];
  let oid = `eval-${c.id}`;
  for (const p of c.principals) {
    if (p.startsWith(ENTRA_GROUP)) groups.push(p.slice(ENTRA_GROUP.length));
    else if (p.startsWith(ENTRA_USER)) oid = p.slice(ENTRA_USER.length);
    else if (p !== 'public' && p !== 'all-users') {
      // 'public' is appended to every caller by retrieval; 'all-users' is
      // minted automatically for every AUTHENTICATED oidc identity — both are
      // implicit in the token legs (dev-header passes them verbatim instead).
      throw new Error(
        `Gold case ${c.id}: principal "${p}" cannot be represented in an Entra token — ` +
          `use entra-group:/entra-user: (or the implicit public/all-users)`,
      );
    }
  }
  return { oid, groups };
}

/** Translate a gold case's principals into a signed Entra-shaped token. */
async function mintCaseToken(idp: LocalIdp, c: GoldCase): Promise<string> {
  const { oid, groups } = caseToEntra(c);
  return idp.signToken({ oid, groups });
}

/**
 * Mint a delegated token for a case. Base cases (no delegation field) get a
 * full-scope grant (cmd '/cerebro') so they behave exactly like the human;
 * delegation cases carry their narrowing / expiry / revocation. A revoked case
 * is written to the AttestationAnchor before the call.
 */
async function mintCaseDelegation(
  idp: LocalIdp,
  c: GoldCase,
  anchor: LocalAppendOnlyAnchor,
): Promise<string> {
  const { oid, groups } = caseToEntra(c);
  const d = c.delegation ?? {};
  const grant: DelegationGrant = { cmd: d.cmd ?? '/cerebro' };
  if (d.pol) grant.pol = d.pol;
  if (d.sourcesAllow) grant.sources_allow = d.sourcesAllow;
  if (d.principalsAllow) grant.principals_allow = d.principalsAllow;

  const jti = `eval-dlg-${c.id}`;
  const nowS = Math.floor(Date.now() / 1000);
  const token = await idp.signDelegation({
    humanOid: oid,
    groups,
    agent: d.agent ?? 'agent:eval-bot',
    grant,
    scope: 'cerebro.search',
    expiresInS: 300,
    jti,
    // Expired: issue far enough in the past that exp (= iat + 300) is also past.
    nowS: d.expired ? nowS - 100_000 : nowS,
  });
  // Revocation namespace is the root subject — mintDelegation sets sub = humanOid.
  if (d.revoked) await anchor.revoke(oid, jti, 'eval');
  return token;
}

async function main(): Promise<void> {
  const leg = process.env.EVAL_AUTH ?? 'dev-header';
  const delegationLeg = leg === 'delegation';
  const idp =
    leg === 'local-oidc' ? await setupLocalOidc() : delegationLeg ? await setupDelegation() : null;

  const gold: Gold = JSON.parse(
    await fs.readFile(path.join(process.cwd(), 'eval', 'gold.json'), 'utf8'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const retrieval = app.get(RetrievalService, { strict: false });
  const rag = app.get(RagService, { strict: false });
  const identityService = app.get(IdentityService, { strict: false });
  const db = app.get(DatabaseService, { strict: false });
  const anchor = app.get(LocalAppendOnlyAnchor, { strict: false });

  const identityFor = async (c: GoldCase): Promise<CallerIdentity> => {
    if (delegationLeg) {
      return identityService.resolve({
        authorization: `Bearer ${await mintCaseDelegation(idp!, c, anchor)}`,
      });
    }
    if (idp) {
      return identityService.resolve({ authorization: `Bearer ${await mintCaseToken(idp, c)}` });
    }
    return identityService.resolve({ devHeader: c.principals.join(',') });
  };

  let gateHits = 0;
  let gateTotal = 0;
  let reciprocalRankSum = 0;
  let aclViolations = 0;
  let notFoundFailures = 0;
  let requiredMisses = 0;
  const rows: string[] = [];

  try {
    // PRESENCE CONTROL: every document a case references must exist in the
    // corpus. Without this, a forbidden-doc case passes VACUOUSLY when the
    // protected document was never ingested (deleted seed file, connector
    // regression) — the primary leak gate must not be satisfiable by absence.
    const referenced = [
      ...new Set(gold.cases.flatMap((c) => [...c.relevantDocIds, ...(c.forbiddenDocIds ?? [])])),
    ];
    const present = await db.query<{ id: string }>(
      'SELECT id FROM documents WHERE id = ANY($1)',
      [referenced],
    );
    const missing = referenced.filter((id) => !present.rows.some((r) => r.id === id));
    if (missing.length > 0) {
      throw new Error(
        `Eval corpus integrity failure: gold set references documents not in the store: ` +
          `${missing.join(', ')} — leak cases would pass vacuously. Re-seed or fix the gold set.`,
      );
    }

    // SCHEMA TRIPWIRE: the CHECKs that make dangerous mapping rows
    // unrepresentable are load-bearing for fail-closed; prove they still
    // reject. Each insert runs in a rolled-back transaction.
    const badMappingRows: [string, string][] = [
      ['entra-group:x', 'public'], //          reserved source principal
      ['entra-group:x', 'all-users'], //       reserved source principal
      ['entra-group:x', 'nonamespace'], //     un-namespaced source principal
      ['hr', 'confluence-group:x'], //         un-namespaced entra principal
    ];
    for (const [entra, source] of badMappingRows) {
      let rejected = false;
      try {
        await db.transaction(async (client) => {
          await client.query(
            'INSERT INTO principal_mappings (source_principal, entra_principal) VALUES ($1, $2)',
            [source, entra],
          );
          throw new Error('__ROLLBACK__'); // insert succeeded — roll it back
        });
      } catch (err) {
        rejected = !String(err).includes('__ROLLBACK__');
      }
      if (!rejected) {
        throw new Error(
          `Schema tripwire failure: principal_mappings accepted the dangerous row ` +
            `(${entra} -> ${source}) — a CHECK constraint has regressed.`,
        );
      }
    }
    for (const c of gold.cases) {
      // Delegation cases run ONLY in the delegation leg — under plain OIDC the
      // human is un-narrowed, so an over-scope case's forbidden doc could surface.
      if (c.delegation && !delegationLeg) {
        rows.push(`  ${c.id.padEnd(24)}         skip (delegation-only)`);
        continue;
      }

      // A deny-expected case (over-scope / revoked / expired) throws at the
      // boundary; that throw IS the pass condition and means "no data".
      let identity: CallerIdentity | null = null;
      let chunks: RetrievedChunk[] = [];
      let denied = false;
      try {
        identity = await identityFor(c);
        chunks = await retrieval.search(c.question, { identity, topK: gold.topK });
      } catch (err) {
        if (c.expectDenied && (err instanceof IdentityError || err instanceof ForbiddenException)) {
          denied = true;
        } else {
          throw err;
        }
      }
      const retrievedDocIds = chunks.map((ch) => ch.documentId);

      // First-relevant rank → recall@k + reciprocal rank.
      const firstRelevantRank =
        c.relevantDocIds.length === 0
          ? -1
          : chunks.findIndex((ch) => c.relevantDocIds.includes(ch.documentId)) + 1;
      const hit = firstRelevantRank > 0;

      // ACL: a forbidden doc must never appear for this caller.
      const leaked = (c.forbiddenDocIds ?? []).filter((id) => retrievedDocIds.includes(id));
      if (leaked.length > 0) aclViolations++;

      // notFound expectation (verified via the full RAG answer). A boundary deny
      // is "no data" by definition, so it satisfies the abstention expectation.
      let notFoundOk = true;
      if (c.expectNotFound) {
        if (denied || !identity) {
          notFoundOk = true;
        } else {
          try {
            const ans = await rag.answer(c.question, { identity, topK: gold.topK });
            notFoundOk = ans.notFound;
          } catch (err) {
            if (c.expectDenied && err instanceof ForbiddenException) notFoundOk = true;
            else throw err;
          }
        }
        if (!notFoundOk) notFoundFailures++;
      }

      const inGate = !c.crossLingual;
      if (inGate && c.relevantDocIds.length > 0) {
        gateTotal++;
        if (hit) {
          gateHits++;
          reciprocalRankSum += 1 / firstRelevantRank;
        }
      }
      // Security-gate cases fail the run individually — aggregate recall
      // slack (threshold < 1.0) must not absorb them.
      if (c.required && c.relevantDocIds.length > 0 && !hit) requiredMisses++;

      const status = leaked.length
        ? `LEAK!(${leaked.join(',')})`
        : !notFoundOk
          ? 'NOTFOUND-FAIL'
          : denied
            ? 'ok(denied)'
            : c.relevantDocIds.length === 0
              ? 'ok(deny)'
              : hit
                ? `hit@${firstRelevantRank}${c.required ? ' [required]' : ''}`
                : `MISS${c.required ? ' [REQUIRED!]' : ''}`;
      rows.push(
        `  ${c.id.padEnd(24)} ${c.crossLingual ? '[xling] ' : '        '}${status}`,
      );
    }

    const recall = gateTotal ? gateHits / gateTotal : 1;
    const mrr = gateTotal ? reciprocalRankSum / gateTotal : 1;

    console.log(
      `\nEval results [auth=${leg}${delegationLeg ? ' (delegated JWT per case)' : ''}] ` +
        `(gated cases exclude cross-lingual under the fake provider):`,
    );
    console.log(rows.join('\n'));
    console.log(
      `\n  Recall@${gold.topK} = ${recall.toFixed(3)}  MRR = ${mrr.toFixed(3)}  ` +
        `(gated cases: ${gateHits}/${gateTotal})`,
    );
    console.log(`  ACL violations = ${aclViolations}  (must be 0)`);
    console.log(`  Abstention (not-found) failures = ${notFoundFailures}  (must be 0)`);
    console.log(`  Required-case misses = ${requiredMisses}  (must be 0)`);

    const pass =
      aclViolations === 0 &&
      notFoundFailures === 0 &&
      requiredMisses === 0 &&
      recall >= gold.recallThreshold;
    console.log(`\n  ${pass ? 'PASS' : 'FAIL'}\n`);
    if (!pass) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

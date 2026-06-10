import 'reflect-metadata';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IdentityService } from '../auth/identity.service';
import { CallerIdentity } from '../auth/identity.types';
import { createLocalIdp, LocalIdp } from '../auth/testing/token-factory';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';

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

/** Translate a gold case's principals into a signed Entra-shaped token. */
async function mintCaseToken(idp: LocalIdp, c: GoldCase): Promise<string> {
  const groups: string[] = [];
  let oid = `eval-${c.id}`;
  for (const p of c.principals) {
    if (p.startsWith(ENTRA_GROUP)) groups.push(p.slice(ENTRA_GROUP.length));
    else if (p.startsWith(ENTRA_USER)) oid = p.slice(ENTRA_USER.length);
    else if (p !== 'public') {
      throw new Error(
        `Gold case ${c.id}: principal "${p}" cannot be represented in an Entra token — ` +
          `use entra-group:/entra-user: (or 'public', which every caller holds automatically)`,
      );
    }
  }
  return idp.signToken({ oid, groups });
}

async function main(): Promise<void> {
  const useLocalOidc = process.env.EVAL_AUTH === 'local-oidc';
  const idp = useLocalOidc ? await setupLocalOidc() : null;

  const gold: Gold = JSON.parse(
    await fs.readFile(path.join(process.cwd(), 'eval', 'gold.json'), 'utf8'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const retrieval = app.get(RetrievalService, { strict: false });
  const rag = app.get(RagService, { strict: false });
  const identityService = app.get(IdentityService, { strict: false });

  const identityFor = async (c: GoldCase): Promise<CallerIdentity> =>
    idp
      ? identityService.resolve({ authorization: `Bearer ${await mintCaseToken(idp, c)}` })
      : identityService.resolve({ devHeader: c.principals.join(',') });

  let gateHits = 0;
  let gateTotal = 0;
  let reciprocalRankSum = 0;
  let aclViolations = 0;
  let notFoundFailures = 0;
  const rows: string[] = [];

  try {
    for (const c of gold.cases) {
      const identity = await identityFor(c);
      const chunks = await retrieval.search(c.question, { identity, topK: gold.topK });
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

      // notFound expectation (verified via the full RAG answer).
      let notFoundOk = true;
      if (c.expectNotFound) {
        const ans = await rag.answer(c.question, { identity, topK: gold.topK });
        notFoundOk = ans.notFound;
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

      const status = leaked.length
        ? `LEAK!(${leaked.join(',')})`
        : !notFoundOk
          ? 'NOTFOUND-FAIL'
          : c.relevantDocIds.length === 0
            ? 'ok(deny)'
            : hit
              ? `hit@${firstRelevantRank}`
              : 'MISS';
      rows.push(
        `  ${c.id.padEnd(24)} ${c.crossLingual ? '[xling] ' : '        '}${status}`,
      );
    }

    const recall = gateTotal ? gateHits / gateTotal : 1;
    const mrr = gateTotal ? reciprocalRankSum / gateTotal : 1;

    console.log(
      `\nEval results [auth=${idp ? 'local-oidc (real JWT per case)' : 'dev-header'}] ` +
        `(gated cases exclude cross-lingual under the fake provider):`,
    );
    console.log(rows.join('\n'));
    console.log(
      `\n  Recall@${gold.topK} = ${recall.toFixed(3)}  MRR = ${mrr.toFixed(3)}  ` +
        `(gated cases: ${gateHits}/${gateTotal})`,
    );
    console.log(`  ACL violations = ${aclViolations}  (must be 0)`);
    console.log(`  Abstention (not-found) failures = ${notFoundFailures}  (must be 0)`);

    const pass = aclViolations === 0 && notFoundFailures === 0 && recall >= gold.recallThreshold;
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

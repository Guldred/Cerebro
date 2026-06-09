import 'reflect-metadata';
import { promises as fs } from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';

/**
 * Eval harness (plan §13, moved to Phase 1 per critique P1). Measures Recall@k and
 * MRR against a labelled gold set, and — critically — treats any ACL leak (a
 * forbidden document surfacing for an unauthorized caller) as a hard failure.
 * Cross-lingual cases need a real multilingual model, so they are reported
 * separately and excluded from the gate when running on the fake provider.
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

async function main(): Promise<void> {
  const gold: Gold = JSON.parse(
    await fs.readFile(path.join(process.cwd(), 'eval', 'gold.json'), 'utf8'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const retrieval = app.get(RetrievalService, { strict: false });
  const rag = app.get(RagService, { strict: false });

  let gateHits = 0;
  let gateTotal = 0;
  let reciprocalRankSum = 0;
  let aclViolations = 0;
  let notFoundFailures = 0;
  const rows: string[] = [];

  try {
    for (const c of gold.cases) {
      const chunks = await retrieval.search(c.question, { principals: c.principals, topK: gold.topK });
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
        const ans = await rag.answer(c.question, { principals: c.principals, topK: gold.topK });
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

    console.log('\nEval results (gated cases exclude cross-lingual under the fake provider):');
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

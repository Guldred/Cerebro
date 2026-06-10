import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../db/database.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { buildConnector } from './connector-factory';

/**
 * npm run acl:refresh — re-resolve permissions for every stored document of the
 * configured connector WITHOUT re-embedding (Plan_Review P2: ACL refresh
 * decoupled from content sync, on its own faster cadence). Cron this against
 * sensitive sources: it is the path that propagates a REVOKED permission or a
 * tightened restriction on an unchanged page.
 *
 * Fail-closed: documents whose resolution fails are quarantined (invisible).
 * Exit code 1 when quarantined documents remain afterwards, so a scheduled run
 * alerts instead of silently leaving dark documents behind.
 *
 * NOTE: refresh targets documents whose source_system matches the connector
 * (confluence, github). The SAMPLE seed corpus masquerades as multi-source via
 * front-matter (source_system: confluence/gitlab), so acl:refresh is a no-op
 * for it by design — its refresh semantics are pinned in unit tests instead.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const ingestion = app.get(IngestionService, { strict: false });
    const db = app.get(DatabaseService, { strict: false });

    const stats = await ingestion.refreshAcls(buildConnector());
    console.log('ACL refresh:', stats);

    const dark = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM documents WHERE acl_status = 'failed'`,
    );
    const darkCount = Number(dark.rows[0]?.count ?? 0);
    if (darkCount > 0) {
      console.error(
        `WARNING: ${darkCount} document(s) quarantined (acl_status='failed') — invisible until ` +
          `resolution succeeds. Investigate source API access, then rerun.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

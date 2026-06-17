import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { CONFIG, CerebroConfig } from '../config/config';
import { ErasureService, ErasureReceipt } from '../erasure/erasure.service';

/**
 * npm run erase — GDPR right-to-be-forgotten erasure (Plan_Review P1.4).
 *
 *   ERASE_MODE=documents ERASE_TARGET=<comma-separated document ids>
 *   ERASE_MODE=author    ERASE_TARGET=<source-native author string>
 *   ERASE_MODE=subject   ERASE_TARGET=<entra oid>      # footprint only
 *   ERASE_MODE=vacuum                                  # physical-zeroing phase
 *
 * Optional: ERASE_SCOPE=<ticket id> (recorded on the receipt),
 *           ERASE_VACUUM=true (also run the physical phase after a logical erase).
 *
 * Two-phase by design: a content/footprint erase is LOGICAL + suppressed +
 * receipted immediately; ERASE_MODE=vacuum is the scheduled VACUUM FULL that
 * physically overwrites the heap and rebuilds the HNSW index. Exit codes: 2 =
 * bad usage, 1 = failure.
 */
async function main(): Promise<void> {
  const mode = (process.env.ERASE_MODE ?? '').trim();
  const target = (process.env.ERASE_TARGET ?? '').trim();
  const scope = (process.env.ERASE_SCOPE ?? '').trim() || null;
  const alsoVacuum = /^(1|true|yes)$/i.test(process.env.ERASE_VACUUM ?? '');

  if (!['documents', 'author', 'subject', 'vacuum'].includes(mode)) {
    usage();
    process.exit(2);
  }
  if (mode !== 'vacuum' && !target) {
    console.error(`ERASE_MODE=${mode} requires ERASE_TARGET.`);
    usage();
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const erasure = app.get(ErasureService, { strict: false });
    const config = app.get(CONFIG, { strict: false }) as CerebroConfig;
    if (!config.erasure.pepper) {
      console.warn(
        'WARNING: ERASURE_PEPPER is empty — receipt digests are an unsalted hash of the identifier. ' +
          'Set a deployment-wide pepper in production.',
      );
    }

    if (mode === 'vacuum') {
      console.log('Physical zeroing:', await erasure.vacuumReindex());
      return;
    }

    let receipt: ErasureReceipt;
    if (mode === 'documents') {
      const ids = target.split(',').map((s) => s.trim()).filter(Boolean);
      receipt = await erasure.eraseDocuments(ids, scope);
    } else if (mode === 'author') {
      receipt = await erasure.eraseByAuthor(target, scope);
    } else {
      receipt = await erasure.eraseSubject(target, scope);
    }
    console.log('Erasure receipt:', JSON.stringify(receipt, null, 2));

    if (alsoVacuum) {
      console.log('Physical zeroing:', await erasure.vacuumReindex());
    } else {
      console.log('Logical erase complete. Run `ERASE_MODE=vacuum npm run erase` to physically zero (scheduled maintenance).');
    }
  } finally {
    await app.close();
  }
}

function usage(): void {
  console.error(
    'Usage: ERASE_MODE=documents|author|subject|vacuum [ERASE_TARGET=...] [ERASE_SCOPE=ticket] [ERASE_VACUUM=true] npm run erase',
  );
}

main().catch((err) => {
  console.error('erase failed:', err);
  process.exit(1);
});

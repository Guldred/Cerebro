import { CallerIdentity } from '../auth/identity.types';
import { CerebroConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import { PrincipalMappingService } from './principal-mapping.service';

function identityWith(principals: string[]): CallerIdentity {
  return { subject: 'u', principals, mode: 'local-oidc' };
}

function serviceWith(
  rows: { entra_principal: string; source_principal: string }[],
  cacheTtlMs = 0,
): { service: PrincipalMappingService; query: jest.Mock } {
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (cacheTtlMs > 0) return { rows };
    // Targeted query path: filter like the SQL WHERE entra_principal = ANY($1)
    const wanted = new Set(params?.[0] as string[]);
    return { rows: rows.filter((r) => wanted.has(r.entra_principal)) };
  });
  const db = { query } as unknown as DatabaseService;
  const config = { mapping: { cacheTtlMs } } as CerebroConfig;
  return { service: new PrincipalMappingService(config, db), query };
}

describe('PrincipalMappingService', () => {
  const rows = [
    { entra_principal: 'entra-group:hr', source_principal: 'confluence-group:hr-payroll' },
    { entra_principal: 'entra-group:hr', source_principal: 'github-repo:corp/payroll' },
    { entra_principal: 'entra-group:eng', source_principal: 'confluence-space:ENG' },
  ];

  it('expands the caller into every mapped source-native principal', async () => {
    const { service } = serviceWith(rows);
    const expanded = await service.expand(identityWith(['entra-user:u1', 'entra-group:hr', 'all-users']));
    expect(expanded.sort()).toEqual(
      [
        'all-users',
        'confluence-group:hr-payroll',
        'entra-group:hr',
        'entra-user:u1',
        'github-repo:corp/payroll',
      ].sort(),
    );
  });

  it('FAIL-CLOSED: an unmapped principal expands to nothing extra (P1.1 — no row, no access)', async () => {
    const { service } = serviceWith(rows);
    const expanded = await service.expand(identityWith(['entra-group:board-secret']));
    expect(expanded).toEqual(['entra-group:board-secret']);
  });

  it('an empty principal set short-circuits (no DB round-trip)', async () => {
    const { service, query } = serviceWith(rows);
    await expect(service.expand(identityWith([]))).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('TTL=0 (default): every query hits the table — a deleted mapping revokes instantly', async () => {
    const { service, query } = serviceWith(rows, 0);
    await service.expand(identityWith(['entra-group:hr']));
    await service.expand(identityWith(['entra-group:hr']));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('TTL>0: the table is cached within the window (explicit revocation-latency trade)', async () => {
    const { service, query } = serviceWith(rows, 60_000);
    await service.expand(identityWith(['entra-group:hr']));
    await service.expand(identityWith(['entra-group:eng']));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('a DB failure aborts the query — never a silently unexpanded result', async () => {
    const db = {
      query: jest.fn(async () => {
        throw new Error('connection refused');
      }),
    } as unknown as DatabaseService;
    const service = new PrincipalMappingService({ mapping: { cacheTtlMs: 0 } } as CerebroConfig, db);
    await expect(service.expand(identityWith(['entra-group:hr']))).rejects.toThrow(
      'connection refused',
    );
  });
});

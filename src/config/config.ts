import * as dotenv from 'dotenv';

dotenv.config();

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} must be an integer, got "${v}"`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Typed, validated view over the environment. Built once at boot. Keeping all
 * env access here means provider selection and the dimension contract live in
 * one place.
 */
export interface CerebroConfig {
  port: number;
  databaseUrl: string;
  /** Deployment environment. Explicit (CEREBRO_ENV) so the production
   *  fail-closed assertions never hinge on NODE_ENV being remembered. */
  env: 'development' | 'production';

  auth: {
    /**
     * dev-header  — trust the x-cerebro-principals header (MVP stub; local DX).
     * local-oidc  — full OIDC validation against a LOCAL JWKS file (CI/tests run
     *               the identical verifier code path with zero network).
     * oidc        — full OIDC validation against the IdP's remote JWKS (production).
     */
    mode: 'dev-header' | 'local-oidc' | 'oidc';
    issuer: string;
    audience: string;
    /** Remote JWKS (oidc mode). Defaults to <issuer>/discovery/v2.0/keys (Entra). */
    jwksUrl: string;
    /** Local JWKS file (local-oidc mode ONLY — production boot refuses it). */
    jwksFile: string;
    clockToleranceS: number;
    groupsClaim: string;
  };

  mcp: {
    /** oidc modes: end-user bearer-token file, re-read + re-verified per tool
     *  call. Must not be group/world-readable. */
    userTokenFile: string;
    /** dev-header mode ONLY: launcher-set principals for local MCP demos. */
    devPrincipals: string[];
  };

  mapping: {
    /** principal_mappings cache TTL. 0 (default) = no cache: a revoked mapping
     *  row takes effect on the very next query. Raise only deliberately. */
    cacheTtlMs: number;
  };

  embedding: {
    provider: 'fake' | 'azure-openai' | 'openai-compatible';
    dim: number;
    azure: { endpoint: string; apiKey: string; apiVersion: string; deployment: string };
    openaiCompatible: { baseUrl: string; model: string; apiKey: string };
  };

  llm: {
    provider: 'fake' | 'azure-openai' | 'openai-compatible';
    azure: { endpoint: string; apiKey: string; apiVersion: string; deployment: string };
    openaiCompatible: { baseUrl: string; model: string; apiKey: string };
  };

  retrieval: {
    topK: number;
    candidates: number;
    rrfK: number;
    ftsConfig: string;
    /** HNSW search breadth. Higher = better recall, slower. */
    efSearch: number;
    /** pgvector 0.8+ iterative scan: keeps recall under selective ACL/metadata
     *  filters (post-filtering would otherwise return far fewer than k results). */
    iterativeScan: boolean;
  };

  acl: {
    enforced: boolean;
    publicPrincipal: string;
  };
}

export function loadConfig(): CerebroConfig {
  const env = resolveEnv();
  const issuer = str('AUTH_OIDC_ISSUER', '');

  const config: CerebroConfig = {
    port: int('PORT', 3000),
    databaseUrl: str('DATABASE_URL', 'postgres://cerebro:cerebro@localhost:5433/cerebro'),
    env,

    auth: {
      mode: str('AUTH_MODE', 'dev-header') as CerebroConfig['auth']['mode'],
      issuer,
      audience: str('AUTH_OIDC_AUDIENCE', ''),
      // Entra's jwks_uri lives at <tenant-base>/discovery/v2.0/keys where the
      // issuer is <tenant-base>/v2.0 — strip that suffix before deriving. Other
      // IdPs should set AUTH_OIDC_JWKS_URL explicitly.
      jwksUrl: str(
        'AUTH_OIDC_JWKS_URL',
        issuer ? `${issuer.replace(/\/$/, '').replace(/\/v2\.0$/, '')}/discovery/v2.0/keys` : '',
      ),
      jwksFile: str('AUTH_OIDC_JWKS_FILE', ''),
      clockToleranceS: int('AUTH_CLOCK_TOLERANCE_S', 60),
      groupsClaim: str('AUTH_GROUPS_CLAIM', 'groups'),
    },

    mcp: {
      userTokenFile: str('MCP_USER_TOKEN_FILE', ''),
      devPrincipals: str('CEREBRO_MCP_PRINCIPALS', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },

    mapping: {
      cacheTtlMs: int('PRINCIPAL_MAPPING_CACHE_TTL_MS', 0),
    },

    embedding: {
      provider: str('EMBEDDING_PROVIDER', 'fake') as CerebroConfig['embedding']['provider'],
      dim: int('EMBEDDING_DIM', 1024),
      azure: {
        endpoint: str('AZURE_OPENAI_ENDPOINT', ''),
        apiKey: str('AZURE_OPENAI_API_KEY', ''),
        apiVersion: str('AZURE_OPENAI_API_VERSION', '2024-10-21'),
        deployment: str('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', 'text-embedding-3-large'),
      },
      openaiCompatible: {
        baseUrl: str('EMBEDDING_BASE_URL', 'http://localhost:8080/v1'),
        model: str('EMBEDDING_MODEL', 'bge-m3'),
        apiKey: str('EMBEDDING_API_KEY', ''),
      },
    },

    llm: {
      provider: str('LLM_PROVIDER', 'fake') as CerebroConfig['llm']['provider'],
      azure: {
        endpoint: str('AZURE_OPENAI_ENDPOINT', ''),
        apiKey: str('AZURE_OPENAI_API_KEY', ''),
        apiVersion: str('AZURE_OPENAI_API_VERSION', '2024-10-21'),
        deployment: str('AZURE_OPENAI_CHAT_DEPLOYMENT', 'gpt-4o'),
      },
      openaiCompatible: {
        baseUrl: str('LLM_BASE_URL', 'http://localhost:8081/v1'),
        model: str('LLM_MODEL', ''),
        apiKey: str('LLM_API_KEY', ''),
      },
    },

    retrieval: {
      topK: int('RETRIEVAL_TOP_K', 8),
      candidates: int('RETRIEVAL_CANDIDATES', 40),
      rrfK: int('RRF_K', 60),
      ftsConfig: str('FTS_CONFIG', 'simple'),
      efSearch: int('HNSW_EF_SEARCH', 100),
      iterativeScan: bool('HNSW_ITERATIVE_SCAN', true),
    },

    acl: {
      enforced: bool('ACL_ENFORCED', true),
      publicPrincipal: str('PUBLIC_PRINCIPAL', 'public'),
    },
  };

  assertBootInvariants(config);
  return config;
}

/**
 * Deployment environment, STRICTLY validated. CEREBRO_ENV is this app's knob:
 * any value outside the known set refuses to boot — a typo ('Producton',
 * 'staging') must never silently run with development-grade auth. Common
 * aliases normalize toward the SAFE direction (prod → production). NODE_ENV
 * stays a fallback with its Node-conventional semantics (only the exact string
 * 'production' activates production).
 */
function resolveEnv(): CerebroConfig['env'] {
  const raw = process.env.CEREBRO_ENV ?? '';
  if (raw) {
    const norm = raw.trim().toLowerCase();
    if (norm === 'production' || norm === 'prod') return 'production';
    if (norm === 'development' || norm === 'dev') return 'development';
    throw new Error(
      `Refusing to boot: CEREBRO_ENV must be development or production, got "${raw}" ` +
        '(an unrecognized value must never silently disable the production boot guards)',
    );
  }
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

/**
 * Fail-closed boot assertions (Plan_Review P1.1/P1.2): insecure combinations
 * must be UNBOOTABLE, not warned about. Throws before the app serves a byte.
 */
function assertBootInvariants(c: CerebroConfig): void {
  const fail = (msg: string): never => {
    throw new Error(`Refusing to boot: ${msg}`);
  };

  if (!['dev-header', 'local-oidc', 'oidc'].includes(c.auth.mode)) {
    fail(`AUTH_MODE must be dev-header | local-oidc | oidc, got "${c.auth.mode}"`);
  }

  if (c.env === 'production') {
    // The header stub trusts the client outright and a local JWKS file lets an
    // env var swap the JWT trust root — neither may ever serve real traffic.
    if (c.auth.mode !== 'oidc') {
      fail(`CEREBRO_ENV=production requires AUTH_MODE=oidc (got "${c.auth.mode}")`);
    }
    if (!c.acl.enforced) {
      fail('CEREBRO_ENV=production requires ACL_ENFORCED=true');
    }
    if (c.auth.jwksFile) {
      fail('AUTH_OIDC_JWKS_FILE (a local JWT trust root) must not be set in production');
    }
    // A plaintext-HTTP trust root lets an on-path attacker substitute the JWKS
    // and forge every identity in the system.
    if (!c.auth.issuer.startsWith('https://')) {
      fail(`AUTH_OIDC_ISSUER must be https:// in production (got "${c.auth.issuer}")`);
    }
    if (!c.auth.jwksUrl.startsWith('https://')) {
      fail(`AUTH_OIDC_JWKS_URL must be https:// in production (got "${c.auth.jwksUrl}")`);
    }
  }

  if (c.auth.mode === 'oidc') {
    if (!c.auth.issuer || !c.auth.audience || !c.auth.jwksUrl) {
      fail('AUTH_MODE=oidc requires AUTH_OIDC_ISSUER, AUTH_OIDC_AUDIENCE and AUTH_OIDC_JWKS_URL');
    }
    if (c.auth.jwksFile) {
      fail('AUTH_MODE=oidc never reads a JWKS file — use AUTH_MODE=local-oidc for file-based JWKS');
    }
  }

  if (c.auth.mode === 'local-oidc') {
    if (!c.auth.issuer || !c.auth.audience || !c.auth.jwksFile) {
      fail('AUTH_MODE=local-oidc requires AUTH_OIDC_ISSUER, AUTH_OIDC_AUDIENCE and AUTH_OIDC_JWKS_FILE');
    }
  }
}

export const CONFIG = Symbol('CEREBRO_CONFIG');

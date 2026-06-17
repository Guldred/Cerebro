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
    /**
     * Resolver for Entra groups OVERAGE tokens (the `groups` claim omitted
     * because the user is in too many groups). `none` (default) keeps the
     * fail-closed hard-403; `graph` resolves the full set from Microsoft Graph.
     */
    groupResolver: 'none' | 'graph';
    graph: {
      tenantId: string;
      clientId: string;
      clientSecret: string;
      /** Graph API base — default graph.microsoft.com; set for sovereign clouds. */
      baseUrl: string;
      /** Token authority — default login.microsoftonline.com. */
      authority: string;
      /**
       * MUST mirror the tenant's `groupMembershipClaims` manifest: `true` =
       * security groups only (the `SecurityGroup` setting, common); `false` =
       * all groups + directory roles (`All`). A mismatch under-serves (subset)
       * or LEAKS principals (superset) — see GraphGroupResolver.
       */
      securityEnabledOnly: boolean;
      /** Per-oid resolved-group cache TTL. 0 (default) = no cache (a re-call per
       *  overage request; raise to soften Graph throttling, eyes open). */
      cacheTtlMs: number;
    };
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

  ingestion: {
    /** Max chunks per embed() request — caps the per-request batch so one large
     *  document can't exceed the embedder's item/token limit. 0 disables. */
    embedMaxBatch: number;
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

  observability: {
    /** Include the RAW query text in structured query logs. Default OFF — a query
     *  can be Art. 9 special-category data, so it is hashed + length-only by
     *  default (Plan_Review P3). Turn on only for debugging in a safe environment. */
    logQueryText: boolean;
  };

  /**
   * Delegated-agent access (docs/Totem_Integration.md). EVERYTHING here defaults
   * OFF — Cerebro must boot and the eval must pass with delegation disabled and
   * the chain disabled. When enabled, the delegation trust root is held to the
   * SAME fail-closed bar as AUTH_MODE (https issuer/JWKS, no local file in prod).
   */
  delegation: {
    /** Master switch (Phase 1). OFF ⇒ an `act`-bearing token is a plain bearer token. */
    enabled: boolean;
    /** When ON, a request with no valid delegation is denied (delegation mandatory). */
    require: boolean;
    /** Trust root for the delegation mint / token-exchange STS. */
    issuer: string;
    audience: string;
    /** Remote JWKS (production). */
    jwksUrl: string;
    /** Local JWKS file (dev/local/CI ONLY — production boot refuses it). */
    jwksFile: string;
    /** Cap on delegated-token lifetime in seconds (short by design). */
    maxTtlS: number;
    /** Audit/anchor sink: `local` append-only (default) or the optional `onchain` adapter. */
    auditBackend: 'local' | 'onchain';
    /** Phase-2 per-MCP-call policy decision point. Independently flaggable. */
    pdpEnabled: boolean;
    /** source_systems that trigger a Phase-2 late-binding membership re-check. */
    sensitiveSources: string[];
    /**
     * Phase-2 late-binding membership oracle. `unverified` (default) returns the
     * honest `unknown` → step-up; a connector-backed checker re-confirms LIVE
     * source-side membership at call time, closing the chunk-ACL window.
     */
    membership: {
      checker: 'unverified' | 'github';
      github: {
        /** The GitHub org whose membership gates the sensitive `github` source. */
        org: string;
        /**
         * Read token that is ITSELF a member of `org` — required for an
         * unambiguous 204/404 from the members API (a non-member token gets a
         * 302 redirect to the PUBLIC member list, which the checker treats as
         * `unknown` rather than silently downgrading).
         */
        token: string;
        /** API base — default api.github.com; set for GitHub Enterprise Server. */
        apiUrl: string;
      };
    };
  };

  /** GDPR erasure (Plan_Review P1.4). */
  erasure: {
    /**
     * Deployment-wide pepper for the erasure-receipt digest
     * (`sha256(pepper ‖ identifier)`). Keeps `erasure_log` non-identifying while
     * staying verify-on-demand. A secret, not per-row salt, so recompute is
     * deterministic; empty in dev (the erase script warns).
     */
    pepper: string;
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
      groupResolver: str('AUTH_GROUP_RESOLVER', 'none') as CerebroConfig['auth']['groupResolver'],
      graph: {
        tenantId: str('GRAPH_TENANT_ID', ''),
        clientId: str('GRAPH_CLIENT_ID', ''),
        clientSecret: str('GRAPH_CLIENT_SECRET', ''),
        baseUrl: str('GRAPH_BASE_URL', 'https://graph.microsoft.com'),
        authority: str('GRAPH_AUTHORITY', 'https://login.microsoftonline.com'),
        securityEnabledOnly: bool('GRAPH_SECURITY_ENABLED_ONLY', true),
        cacheTtlMs: int('AUTH_GROUP_RESOLVER_CACHE_TTL_MS', 0),
      },
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

    ingestion: {
      embedMaxBatch: int('EMBEDDING_MAX_BATCH', 96),
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

    observability: {
      logQueryText: bool('OBSERVABILITY_LOG_QUERY_TEXT', false),
    },

    delegation: {
      enabled: bool('DELEGATION_ENABLED', false),
      require: bool('DELEGATION_REQUIRE', false),
      issuer: str('DELEGATION_ISSUER', ''),
      audience: str('DELEGATION_AUDIENCE', ''),
      jwksUrl: str('DELEGATION_JWKS_URL', ''),
      jwksFile: str('DELEGATION_JWKS_FILE', ''),
      maxTtlS: int('DELEGATION_MAX_TTL_S', 300),
      auditBackend: str('DELEGATION_AUDIT_BACKEND', 'local') as CerebroConfig['delegation']['auditBackend'],
      pdpEnabled: bool('DELEGATION_PDP_ENABLED', false),
      sensitiveSources: str('DELEGATION_SENSITIVE_SOURCES', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      membership: {
        checker: str(
          'DELEGATION_MEMBERSHIP_CHECKER',
          'unverified',
        ) as CerebroConfig['delegation']['membership']['checker'],
        github: {
          org: str('DELEGATION_GITHUB_MEMBERSHIP_ORG', ''),
          token: str('DELEGATION_GITHUB_MEMBERSHIP_TOKEN', ''),
          apiUrl: str('DELEGATION_GITHUB_API_URL', ''),
        },
      },
    },

    erasure: {
      pepper: str('ERASURE_PEPPER', ''),
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

  // Overage group resolver (escape hatch for >200-group Entra tokens).
  if (!['none', 'graph'].includes(c.auth.groupResolver)) {
    fail(`AUTH_GROUP_RESOLVER must be none | graph, got "${c.auth.groupResolver}"`);
  }
  if (c.auth.groupResolver === 'graph') {
    const g = c.auth.graph;
    if (!g.tenantId || !g.clientId || !g.clientSecret) {
      fail('AUTH_GROUP_RESOLVER=graph requires GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET');
    }
    if (c.env === 'production') {
      if (!g.baseUrl.startsWith('https://')) fail(`GRAPH_BASE_URL must be https:// in production (got "${g.baseUrl}")`);
      if (!g.authority.startsWith('https://')) fail(`GRAPH_AUTHORITY must be https:// in production (got "${g.authority}")`);
    }
  }

  if (c.auth.mode === 'local-oidc') {
    if (!c.auth.issuer || !c.auth.audience || !c.auth.jwksFile) {
      fail('AUTH_MODE=local-oidc requires AUTH_OIDC_ISSUER, AUTH_OIDC_AUDIENCE and AUTH_OIDC_JWKS_FILE');
    }
  }

  // --- Delegation (docs/Totem_Integration.md). All OFF by default; when ON, the
  //     new trust root is held to the SAME fail-closed bar as AUTH_MODE. ---
  const d = c.delegation;
  if (!['local', 'onchain'].includes(d.auditBackend)) {
    fail(`DELEGATION_AUDIT_BACKEND must be local | onchain, got "${d.auditBackend}"`);
  }
  // The chain is opt-in and off by default — turning it on must be loud, never accidental.
  if (d.auditBackend === 'onchain' && !bool('DELEGATION_ONCHAIN_ACK', false)) {
    fail('DELEGATION_AUDIT_BACKEND=onchain requires DELEGATION_ONCHAIN_ACK=true (the on-chain anchor is opt-in)');
  }
  if (d.require && !d.enabled) fail('DELEGATION_REQUIRE=true requires DELEGATION_ENABLED=true');
  if (d.pdpEnabled && !d.enabled) fail('DELEGATION_PDP_ENABLED=true requires DELEGATION_ENABLED=true');

  // Phase-2 connector-backed membership oracle (consulted only by the PDP).
  const m = d.membership;
  if (!['unverified', 'github'].includes(m.checker)) {
    fail(`DELEGATION_MEMBERSHIP_CHECKER must be unverified | github, got "${m.checker}"`);
  }
  if (m.checker === 'github') {
    if (!m.github.org) {
      fail('DELEGATION_MEMBERSHIP_CHECKER=github requires DELEGATION_GITHUB_MEMBERSHIP_ORG');
    }
    // An unauthenticated (or non-member) token cannot read private org
    // membership — GitHub redirects to the PUBLIC member list, which the checker
    // refuses to trust (→ unknown). In production a real org-member token is
    // mandatory; dev/local may run keyless, where the checker just steps up.
    if (c.env === 'production' && !m.github.token) {
      fail('DELEGATION_MEMBERSHIP_CHECKER=github requires DELEGATION_GITHUB_MEMBERSHIP_TOKEN in production');
    }
  }

  if (d.enabled) {
    if (!Number.isFinite(d.maxTtlS) || d.maxTtlS <= 0 || d.maxTtlS > 3600) {
      fail(`DELEGATION_MAX_TTL_S must be in (0, 3600] seconds (got ${d.maxTtlS})`);
    }
    if (!d.issuer || !d.audience) {
      fail('DELEGATION_ENABLED=true requires DELEGATION_ISSUER and DELEGATION_AUDIENCE');
    }
    if (!d.jwksUrl && !d.jwksFile) {
      fail('DELEGATION_ENABLED=true requires DELEGATION_JWKS_URL (remote) or DELEGATION_JWKS_FILE (local)');
    }
    if (d.jwksUrl && d.jwksFile) {
      fail('Set exactly one of DELEGATION_JWKS_URL (remote) or DELEGATION_JWKS_FILE (local), not both');
    }
    if (c.env === 'production') {
      if (d.jwksFile) {
        fail('DELEGATION_JWKS_FILE (a local JWT trust root) must not be set in production — use DELEGATION_JWKS_URL');
      }
      if (!d.issuer.startsWith('https://')) {
        fail(`DELEGATION_ISSUER must be https:// in production (got "${d.issuer}")`);
      }
      if (!d.jwksUrl.startsWith('https://')) {
        fail(`DELEGATION_JWKS_URL must be https:// in production (got "${d.jwksUrl}")`);
      }
    }
  }
}

export const CONFIG = Symbol('CEREBRO_CONFIG');

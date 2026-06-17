import { loadConfig } from './config';

/**
 * Boot-assertion exit gates: insecure configurations must be UNBOOTABLE.
 * loadConfig reads process.env, so each case sets a clean slate.
 */
describe('loadConfig boot invariants', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CEREBRO_ENV;
    delete process.env.NODE_ENV;
    delete process.env.AUTH_MODE;
    delete process.env.AUTH_OIDC_ISSUER;
    delete process.env.AUTH_OIDC_AUDIENCE;
    delete process.env.AUTH_OIDC_JWKS_URL;
    delete process.env.AUTH_OIDC_JWKS_FILE;
    delete process.env.ACL_ENFORCED;
    delete process.env.AUTH_GROUP_RESOLVER;
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DELEGATION_') || k.startsWith('GRAPH_')) delete process.env[k];
    }
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults: dev-header mode in development boots', () => {
    const config = loadConfig();
    expect(config.env).toBe('development');
    expect(config.auth.mode).toBe('dev-header');
    expect(config.observability.logQueryText).toBe(false); // raw query text is OFF by default (Art. 9)
    expect(config.ingestion.embedMaxBatch).toBe(96); // per-request embed batch cap
  });

  it('production refuses dev-header mode (client-asserted identity)', () => {
    process.env.CEREBRO_ENV = 'production';
    expect(() => loadConfig()).toThrow(/requires AUTH_MODE=oidc/);
  });

  it('production refuses local-oidc mode (file-based trust root)', () => {
    process.env.CEREBRO_ENV = 'production';
    process.env.AUTH_MODE = 'local-oidc';
    expect(() => loadConfig()).toThrow(/requires AUTH_MODE=oidc/);
  });

  it('NODE_ENV=production alone (CEREBRO_ENV unset) also triggers the production assertions', () => {
    process.env.NODE_ENV = 'production';
    expect(() => loadConfig()).toThrow(/requires AUTH_MODE=oidc/);
  });

  it('a TYPO in CEREBRO_ENV refuses to boot — it must never silently run as development', () => {
    process.env.CEREBRO_ENV = 'Producton';
    expect(() => loadConfig()).toThrow(/CEREBRO_ENV must be development or production/);
    process.env.CEREBRO_ENV = 'staging';
    expect(() => loadConfig()).toThrow(/CEREBRO_ENV must be development or production/);
  });

  it('CEREBRO_ENV aliases normalize toward the safe direction (prod/PRODUCTION → production)', () => {
    for (const value of ['prod', 'PRODUCTION', 'Production']) {
      process.env.CEREBRO_ENV = value;
      expect(() => loadConfig()).toThrow(/requires AUTH_MODE=oidc/);
    }
  });

  it('production refuses a plaintext-http issuer or JWKS URL (on-path key substitution)', () => {
    process.env.CEREBRO_ENV = 'production';
    process.env.AUTH_MODE = 'oidc';
    process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
    process.env.AUTH_OIDC_ISSUER = 'http://login.microsoftonline.com/t/v2.0';
    expect(() => loadConfig()).toThrow(/AUTH_OIDC_ISSUER must be https/);

    process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/t/v2.0';
    process.env.AUTH_OIDC_JWKS_URL = 'http://login.microsoftonline.com/t/discovery/v2.0/keys';
    expect(() => loadConfig()).toThrow(/AUTH_OIDC_JWKS_URL must be https/);
  });

  it('production refuses ACL_ENFORCED=false', () => {
    process.env.CEREBRO_ENV = 'production';
    process.env.AUTH_MODE = 'oidc';
    process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/t/v2.0';
    process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
    process.env.ACL_ENFORCED = 'false';
    expect(() => loadConfig()).toThrow(/ACL_ENFORCED=true/);
  });

  it('production refuses a JWKS file (env-var trust-root swap)', () => {
    process.env.CEREBRO_ENV = 'production';
    process.env.AUTH_MODE = 'oidc';
    process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/t/v2.0';
    process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
    process.env.AUTH_OIDC_JWKS_FILE = '/tmp/jwks.json';
    expect(() => loadConfig()).toThrow(/must not be set in production/);
  });

  it('oidc mode requires issuer + audience', () => {
    process.env.AUTH_MODE = 'oidc';
    expect(() => loadConfig()).toThrow(/AUTH_OIDC_ISSUER/);
  });

  it('oidc mode derives the JWKS URL from the issuer (Entra discovery path)', () => {
    process.env.AUTH_MODE = 'oidc';
    process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/tenant-x/v2.0';
    process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
    const config = loadConfig();
    expect(config.auth.jwksUrl).toBe(
      'https://login.microsoftonline.com/tenant-x/discovery/v2.0/keys',
    );
  });

  it('local-oidc mode requires a JWKS file', () => {
    process.env.AUTH_MODE = 'local-oidc';
    process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/t/v2.0';
    process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
    expect(() => loadConfig()).toThrow(/AUTH_OIDC_JWKS_FILE/);
  });

  it('rejects an unknown AUTH_MODE outright', () => {
    process.env.AUTH_MODE = 'none';
    expect(() => loadConfig()).toThrow(/AUTH_MODE must be/);
  });

  describe('delegation boot invariants (default OFF, backward compatible)', () => {
    it('defaults: delegation + chain are OFF and the app still boots', () => {
      const config = loadConfig();
      expect(config.delegation.enabled).toBe(false);
      expect(config.delegation.require).toBe(false);
      expect(config.delegation.pdpEnabled).toBe(false);
      expect(config.delegation.auditBackend).toBe('local');
      expect(config.delegation.maxTtlS).toBe(300);
    });

    it('DELEGATION_ENABLED requires an issuer + audience', () => {
      process.env.DELEGATION_ENABLED = 'true';
      expect(() => loadConfig()).toThrow(/requires DELEGATION_ISSUER and DELEGATION_AUDIENCE/);
    });

    it('DELEGATION_ENABLED requires exactly one of JWKS url / file', () => {
      process.env.DELEGATION_ENABLED = 'true';
      process.env.DELEGATION_ISSUER = 'https://totem.local/v2.0';
      process.env.DELEGATION_AUDIENCE = 'api://cerebro';
      expect(() => loadConfig()).toThrow(/DELEGATION_JWKS_URL .* or DELEGATION_JWKS_FILE/);
      process.env.DELEGATION_JWKS_URL = 'https://totem.local/keys';
      process.env.DELEGATION_JWKS_FILE = '/tmp/d.json';
      expect(() => loadConfig()).toThrow(/exactly one of DELEGATION_JWKS_URL/);
    });

    it('a local JWKS file boots in development (CI/local path)', () => {
      process.env.DELEGATION_ENABLED = 'true';
      process.env.DELEGATION_ISSUER = 'https://totem.local/v2.0';
      process.env.DELEGATION_AUDIENCE = 'api://cerebro';
      process.env.DELEGATION_JWKS_FILE = '/tmp/delegation-jwks.json';
      const config = loadConfig();
      expect(config.delegation.enabled).toBe(true);
      expect(config.delegation.jwksFile).toBe('/tmp/delegation-jwks.json');
    });

    it('production refuses a delegation JWKS file (local trust root)', () => {
      process.env.CEREBRO_ENV = 'production';
      process.env.AUTH_MODE = 'oidc';
      process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/t/v2.0';
      process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
      process.env.DELEGATION_ENABLED = 'true';
      process.env.DELEGATION_ISSUER = 'https://totem.local/v2.0';
      process.env.DELEGATION_AUDIENCE = 'api://cerebro';
      process.env.DELEGATION_JWKS_FILE = '/tmp/d.json';
      expect(() => loadConfig()).toThrow(/DELEGATION_JWKS_FILE .* must not be set in production/);
    });

    it('production refuses a plaintext-http delegation issuer/JWKS', () => {
      process.env.CEREBRO_ENV = 'production';
      process.env.AUTH_MODE = 'oidc';
      process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/t/v2.0';
      process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
      process.env.DELEGATION_ENABLED = 'true';
      process.env.DELEGATION_ISSUER = 'http://totem.local/v2.0';
      process.env.DELEGATION_AUDIENCE = 'api://cerebro';
      process.env.DELEGATION_JWKS_URL = 'https://totem.local/keys';
      expect(() => loadConfig()).toThrow(/DELEGATION_ISSUER must be https/);
    });

    it('an over-long delegation TTL refuses to boot', () => {
      process.env.DELEGATION_ENABLED = 'true';
      process.env.DELEGATION_ISSUER = 'https://totem.local/v2.0';
      process.env.DELEGATION_AUDIENCE = 'api://cerebro';
      process.env.DELEGATION_JWKS_URL = 'https://totem.local/keys';
      process.env.DELEGATION_MAX_TTL_S = '7200';
      expect(() => loadConfig()).toThrow(/DELEGATION_MAX_TTL_S must be in/);
    });

    it('DELEGATION_REQUIRE / PDP without DELEGATION_ENABLED refuses to boot', () => {
      process.env.DELEGATION_REQUIRE = 'true';
      expect(() => loadConfig()).toThrow(/DELEGATION_REQUIRE=true requires DELEGATION_ENABLED=true/);
      delete process.env.DELEGATION_REQUIRE;
      process.env.DELEGATION_PDP_ENABLED = 'true';
      expect(() => loadConfig()).toThrow(/DELEGATION_PDP_ENABLED=true requires DELEGATION_ENABLED=true/);
    });

    it('the on-chain anchor is opt-in: onchain backend needs an explicit ack', () => {
      process.env.DELEGATION_AUDIT_BACKEND = 'onchain';
      expect(() => loadConfig()).toThrow(/DELEGATION_ONCHAIN_ACK=true/);
      process.env.DELEGATION_ONCHAIN_ACK = 'true';
      expect(() => loadConfig()).not.toThrow();
    });

    it('defaults: the membership checker is the honest "unverified" oracle', () => {
      expect(loadConfig().delegation.membership.checker).toBe('unverified');
    });

    it('an unknown DELEGATION_MEMBERSHIP_CHECKER refuses to boot', () => {
      process.env.DELEGATION_MEMBERSHIP_CHECKER = 'magic';
      expect(() => loadConfig()).toThrow(/DELEGATION_MEMBERSHIP_CHECKER must be unverified \| github/);
    });

    it('DELEGATION_MEMBERSHIP_CHECKER=github requires an org', () => {
      process.env.DELEGATION_MEMBERSHIP_CHECKER = 'github';
      expect(() => loadConfig()).toThrow(/requires DELEGATION_GITHUB_MEMBERSHIP_ORG/);
    });

    it('the github membership checker boots in development without a token (keyless → step-up)', () => {
      process.env.DELEGATION_MEMBERSHIP_CHECKER = 'github';
      process.env.DELEGATION_GITHUB_MEMBERSHIP_ORG = 'acme';
      const config = loadConfig();
      expect(config.delegation.membership.checker).toBe('github');
      expect(config.delegation.membership.github.org).toBe('acme');
    });

    it('production refuses the github membership checker without a token', () => {
      process.env.CEREBRO_ENV = 'production';
      process.env.AUTH_MODE = 'oidc';
      process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/t/v2.0';
      process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
      process.env.AUTH_OIDC_JWKS_URL = 'https://login.microsoftonline.com/t/discovery/v2.0/keys';
      process.env.DELEGATION_MEMBERSHIP_CHECKER = 'github';
      process.env.DELEGATION_GITHUB_MEMBERSHIP_ORG = 'acme';
      expect(() => loadConfig()).toThrow(/requires DELEGATION_GITHUB_MEMBERSHIP_TOKEN in production/);
    });
  });

  describe('overage group resolver boot invariants (default OFF, backward compatible)', () => {
    it('defaults to none (the hard-403 on overage is preserved) with securityEnabledOnly=true', () => {
      const config = loadConfig();
      expect(config.auth.groupResolver).toBe('none');
      expect(config.auth.graph.securityEnabledOnly).toBe(true);
    });

    it('an unknown AUTH_GROUP_RESOLVER refuses to boot', () => {
      process.env.AUTH_GROUP_RESOLVER = 'ldap';
      expect(() => loadConfig()).toThrow(/AUTH_GROUP_RESOLVER must be none \| graph/);
    });

    it('AUTH_GROUP_RESOLVER=graph requires tenant + client + secret', () => {
      process.env.AUTH_GROUP_RESOLVER = 'graph';
      expect(() => loadConfig()).toThrow(/requires GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET/);
    });

    it('the graph resolver boots in development with creds', () => {
      process.env.AUTH_GROUP_RESOLVER = 'graph';
      process.env.GRAPH_TENANT_ID = 't';
      process.env.GRAPH_CLIENT_ID = 'c';
      process.env.GRAPH_CLIENT_SECRET = 's';
      expect(loadConfig().auth.groupResolver).toBe('graph');
    });

    it('production refuses a plaintext-http Graph base URL', () => {
      process.env.CEREBRO_ENV = 'production';
      process.env.AUTH_MODE = 'oidc';
      process.env.AUTH_OIDC_ISSUER = 'https://login.microsoftonline.com/t/v2.0';
      process.env.AUTH_OIDC_AUDIENCE = 'api://cerebro';
      process.env.AUTH_OIDC_JWKS_URL = 'https://login.microsoftonline.com/t/discovery/v2.0/keys';
      process.env.AUTH_GROUP_RESOLVER = 'graph';
      process.env.GRAPH_TENANT_ID = 't';
      process.env.GRAPH_CLIENT_ID = 'c';
      process.env.GRAPH_CLIENT_SECRET = 's';
      process.env.GRAPH_BASE_URL = 'http://graph.local';
      expect(() => loadConfig()).toThrow(/GRAPH_BASE_URL must be https/);
    });
  });
});

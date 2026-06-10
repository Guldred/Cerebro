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
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults: dev-header mode in development boots', () => {
    const config = loadConfig();
    expect(config.env).toBe('development');
    expect(config.auth.mode).toBe('dev-header');
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
});

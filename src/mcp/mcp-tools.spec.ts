import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { IdentityService } from '../auth/identity.service';
import { CallerIdentity } from '../auth/identity.types';
import { PolicyDecisionPoint } from '../auth/delegation/pdp';
import { createLocalIdp, LocalIdp } from '../auth/testing/token-factory';
import { CerebroConfig } from '../config/config';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { McpIdentityProvider } from './mcp-identity';
import { CerebroMcpDeps, createCerebroMcpServer } from './mcp-tools';

/**
 * Protocol-level exit gates for the MCP identity invariant (P1.2): a real
 * client↔server round-trip over InMemoryTransport — schema behavior and
 * hard-reject semantics are pinned where an agent host actually sees them.
 */

interface CallResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

function fakeServices(): { rag: RagService; retrieval: RetrievalService; searches: unknown[] } {
  const searches: unknown[] = [];
  const retrieval = {
    search: jest.fn(async (_q: string, options: unknown) => {
      searches.push(options);
      return [];
    }),
  } as unknown as RetrievalService;
  const rag = {
    answer: jest.fn(async (question: string, options: unknown) => {
      searches.push(options);
      return { question, answer: 'Not found in the connected sources.', citations: [], evidence: [], notFound: true };
    }),
  } as unknown as RagService;
  return { rag, retrieval, searches };
}

function configFor(
  mode: CerebroConfig['auth']['mode'],
  overrides: Partial<CerebroConfig['mcp']> = {},
  auth: Partial<CerebroConfig['auth']> = {},
): CerebroConfig {
  return {
    auth: {
      mode,
      issuer: '',
      audience: '',
      jwksUrl: '',
      jwksFile: '',
      clockToleranceS: 5,
      groupsClaim: 'groups',
      ...auth,
    },
    mcp: { userTokenFile: '', devPrincipals: [], ...overrides },
  } as CerebroConfig;
}

const allowPdp = () =>
  ({ decide: jest.fn(async () => ({ decision: 'allow', reasons: [] })) }) as unknown as PolicyDecisionPoint;

async function connect(
  config: CerebroConfig,
  services = fakeServices(),
  overrides: Partial<Pick<CerebroMcpDeps, 'identity' | 'pdp'>> = {},
) {
  const identityService = new IdentityService(config);
  const server = createCerebroMcpServer({
    config,
    rag: services.rag,
    retrieval: services.retrieval,
    identity: overrides.identity ?? new McpIdentityProvider(config, identityService),
    pdp: overrides.pdp ?? allowPdp(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spec-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, services };
}

describe('Cerebro MCP server (dev-header mode) — MVP parity', () => {
  it('accepts the principals argument as the identity stub', async () => {
    const { client, services } = await connect(configFor('dev-header'));
    const result = (await client.callTool({
      name: 'cerebro_search',
      arguments: { query: 'salary bands', principals: ['entra-group:hr'] },
    })) as CallResult;
    expect(result.isError).toBeUndefined();
    expect(services.searches[0]).toMatchObject({
      identity: { mode: 'dev-header', principals: ['entra-group:hr'] },
    });
  });

  it('without principals resolves an empty identity (public-only downstream) — parity', async () => {
    const { client, services } = await connect(configFor('dev-header'));
    const result = (await client.callTool({
      name: 'cerebro_query',
      arguments: { question: 'what is the vpn setup?' },
    })) as CallResult;
    expect(result.isError).toBeUndefined();
    expect(services.searches[0]).toMatchObject({ identity: { principals: [] } });
  });
});

describe('Cerebro MCP server (local-oidc mode) — P1.2 hard-reject', () => {
  let idp: LocalIdp;
  let dir: string;
  let jwksFile: string;

  beforeAll(async () => {
    idp = await createLocalIdp();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebro-mcp-spec-'));
    jwksFile = path.join(dir, 'jwks.json');
    await fs.writeFile(jwksFile, JSON.stringify(idp.jwks));
  });

  function oidcConfig(userTokenFile: string): CerebroConfig {
    return configFor(
      'local-oidc',
      { userTokenFile },
      { issuer: idp.issuer, audience: idp.audience, jwksFile },
    );
  }

  async function writeToken(file: string, mode: number): Promise<void> {
    await fs.writeFile(file, await idp.signToken({ oid: 'mcp-user', groups: ['hr'] }), {
      mode,
    });
  }

  it('HARD-REJECTS a call when no token file is configured (no public-only fallback)', async () => {
    const { client, services } = await connect(oidcConfig(''));
    const result = (await client.callTool({
      name: 'cerebro_search',
      arguments: { query: 'anything' },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('IDENTITY_REQUIRED');
    expect(services.searches).toHaveLength(0); // retrieval was never touched
  });

  it('LOUDLY REJECTS a client that still sends the principals argument', async () => {
    const tokenFile = path.join(dir, 'token-a');
    await writeToken(tokenFile, 0o600);
    const { client, services } = await connect(oidcConfig(tokenFile));
    const result = (await client.callTool({
      name: 'cerebro_search',
      arguments: { query: 'anything', principals: ['entra-group:hr'] },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('PRINCIPALS_ARGUMENT_REJECTED');
    expect(services.searches).toHaveLength(0);
  });

  it('REFUSES a group/world-readable token file (credential hygiene, not a warning)', async () => {
    const tokenFile = path.join(dir, 'token-b');
    await writeToken(tokenFile, 0o644);
    const { client, services } = await connect(oidcConfig(tokenFile));
    const result = (await client.callTool({
      name: 'cerebro_query',
      arguments: { question: 'anything' },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('IDENTITY_REQUIRED');
    expect(services.searches).toHaveLength(0);
  });

  it('resolves the end-user identity from a 0600 token file and filters with it', async () => {
    const tokenFile = path.join(dir, 'token-c');
    await writeToken(tokenFile, 0o600);
    const { client, services } = await connect(oidcConfig(tokenFile));
    const result = (await client.callTool({
      name: 'cerebro_search',
      arguments: { query: 'salary bands' },
    })) as CallResult;
    expect(result.isError).toBeUndefined();
    expect(services.searches[0]).toMatchObject({
      identity: {
        mode: 'local-oidc',
        subject: 'mcp-user',
        principals: ['entra-user:mcp-user', 'entra-group:hr', 'all-users'],
      },
    });
  });

  it('re-reads the token file on EVERY call (rotation-safe; revoked token stops working)', async () => {
    const tokenFile = path.join(dir, 'token-d');
    await writeToken(tokenFile, 0o600);
    const { client, services } = await connect(oidcConfig(tokenFile));

    const first = (await client.callTool({
      name: 'cerebro_search',
      arguments: { query: 'q1' },
    })) as CallResult;
    expect(first.isError).toBeUndefined();

    // The host rotates the file to an EXPIRED token mid-session.
    await fs.writeFile(
      tokenFile,
      await idp.signToken({ oid: 'mcp-user', expiresIn: Math.floor(Date.now() / 1000) - 600 }),
      { mode: 0o600 },
    );
    const second = (await client.callTool({
      name: 'cerebro_search',
      arguments: { query: 'q2' },
    })) as CallResult;
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain('TOKEN_INVALID');
    expect(services.searches).toHaveLength(1);
  });
});

describe('Cerebro MCP server — Phase 2 PDP gate (DELEGATION_PDP_ENABLED)', () => {
  const delegatedIdentity: CallerIdentity = {
    subject: 'human-1',
    principals: ['entra-user:human-1', 'entra-group:hr'],
    mode: 'oidc',
    delegation: { agent: 'agent:x', grant: { cmd: '/cerebro/search' }, delegationId: 'jti-1' },
  };
  // Fake identity provider yielding a delegated caller; the gate logic is what's under test.
  const fakeIdentity = { resolve: async () => delegatedIdentity } as unknown as McpIdentityProvider;
  const pdpConfig = (): CerebroConfig =>
    ({
      ...configFor('dev-header'),
      retrieval: { topK: 8 },
      delegation: { pdpEnabled: true },
    }) as unknown as CerebroConfig;

  it('deny → isError DELEGATION_DENIED, retrieval untouched', async () => {
    const services = fakeServices();
    const pdp = {
      decide: jest.fn(async () => ({ decision: 'deny', reasons: ['delegation/command-not-permitted'] })),
    } as unknown as PolicyDecisionPoint;
    const { client } = await connect(pdpConfig(), services, { identity: fakeIdentity, pdp });
    const result = (await client.callTool({
      name: 'cerebro_query',
      arguments: { question: 'salary' },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DELEGATION_DENIED');
    expect(services.searches).toHaveLength(0);
  });

  it('needs-approval → structured step-up result (NOT isError), retrieval untouched', async () => {
    const services = fakeServices();
    const pdp = {
      decide: jest.fn(async () => ({
        decision: 'needs-approval',
        reasons: ['needs:membership-reverification'],
        prerequisites: [
          { type: 'membership-reverification', sourceSystem: 'confluence', message: 'step up' },
        ],
      })),
    } as unknown as PolicyDecisionPoint;
    const { client } = await connect(pdpConfig(), services, { identity: fakeIdentity, pdp });
    const result = (await client.callTool({
      name: 'cerebro_search',
      arguments: { query: 'salary' },
    })) as CallResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('needs-approval');
    expect(result.content[0].text).toContain('membership-reverification');
    expect(services.searches).toHaveLength(0);
  });

  it('allow → proceeds to retrieval', async () => {
    const services = fakeServices();
    const { client } = await connect(pdpConfig(), services, { identity: fakeIdentity, pdp: allowPdp() });
    const result = (await client.callTool({
      name: 'cerebro_search',
      arguments: { query: 'salary' },
    })) as CallResult;
    expect(result.isError).toBeUndefined();
    expect(services.searches).toHaveLength(1);
  });
});

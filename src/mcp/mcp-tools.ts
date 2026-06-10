import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodRawShape } from 'zod';
import { CallerIdentity, IdentityError } from '../auth/identity.types';
import { CerebroConfig } from '../config/config';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { McpIdentityProvider } from './mcp-identity';

export interface CerebroMcpDeps {
  config: CerebroConfig;
  rag: RagService;
  retrieval: RetrievalService;
  identity: McpIdentityProvider;
}

/**
 * Tool registration for the Cerebro MCP server, extracted from the stdio
 * bootstrap so Jest can drive a real client↔server pair over
 * InMemoryTransport (no process spawn).
 *
 * IDENTITY INVARIANT (Plan_Review P1.2): every tool call resolves the END
 * USER's identity before touching retrieval. In oidc modes the identity comes
 * exclusively from the server-side token file; a `principals` argument is not
 * part of the schema AND is loudly rejected if a client sends it anyway —
 * the SDK's zod objects strip unknown keys silently, and silently ignoring a
 * security-relevant argument would hide a misconfigured agent host. In
 * dev-header mode `principals` remains the documented stub. No identity →
 * isError result, never a public-only or unfiltered fallback.
 */
/** Arguments both tools share (validated at runtime by the SDK's zod layer). */
interface CommonToolArgs {
  principals?: unknown;
  topK?: number;
  sourceSystems?: string[];
}

export function createCerebroMcpServer(deps: CerebroMcpDeps): McpServer {
  const server = new McpServer({ name: 'cerebro', version: '0.2.0' });
  const devMode = deps.config.auth.mode === 'dev-header';

  // SDK 1.29's .tool() generic inference explodes (TS2589) under zod 3.25 +
  // TS 5.9 — the repo has always excluded src/mcp from the build for this
  // reason (tsconfig.build.json) and run it transpile-only. The tests DO
  // type-check this file, so we register through an explicitly-typed signature
  // instead of the SDK generics. Runtime validation is unchanged: the SDK
  // still builds the zod object from the shape.
  const registerTool = server.tool.bind(server) as unknown as (
    name: string,
    description: string,
    shape: ZodRawShape,
    handler: (args: never) => Promise<CallToolResult>,
  ) => void;

  const identityNote = devMode
    ? "Pass the end-user's principals so results are permission-filtered to them; without principals you only see public content."
    : 'Results are permission-filtered to the end user authenticated via the server-side token (MCP_USER_TOKEN_FILE); calls without a resolvable identity are rejected.';

  // `principals` stays in the schema in EVERY mode — as z.unknown() so the SDK
  // does not strip it — because the SDK's zod objects silently drop unknown
  // keys: removing it from the schema would silently ignore a security-relevant
  // argument. The handler enforces the mode semantics (stub in dev-header,
  // loud reject otherwise).
  const principalsDescription = devMode
    ? "dev-header mode: the end-user's resolved principals (identity stub)."
    : 'NOT accepted in oidc modes — identity comes from the server-side end-user token.';

  const topK = z.number().int().min(1).max(50).optional();
  const sourceSystems = z.array(z.string()).optional();
  const principals = z.any().optional().describe(principalsDescription);

  /** Resolve identity or produce the hard-reject result; shared by both tools. */
  const resolveOrReject = async (
    rawPrincipals: unknown,
  ): Promise<{ identity: CallerIdentity } | { error: CallToolResult }> => {
    if (!devMode && rawPrincipals !== undefined) {
      return {
        error: errorResult(
          'PRINCIPALS_ARGUMENT_REJECTED',
          `The 'principals' tool argument is not accepted in AUTH_MODE=${deps.config.auth.mode}: ` +
            'identity comes exclusively from the validated end-user token (MCP_USER_TOKEN_FILE). ' +
            'Remove the argument from the client call.',
        ),
      };
    }
    try {
      const identity = await deps.identity.resolve(
        devMode && Array.isArray(rawPrincipals) ? (rawPrincipals as string[]) : undefined,
      );
      return { identity };
    } catch (err) {
      if (err instanceof IdentityError) return { error: errorResult(err.code, err.message) };
      throw err;
    }
  };

  registerTool(
    'cerebro_query',
    `Answer a natural-language question from the enterprise knowledge layer. Returns a grounded answer with source citations (deep links). ${identityNote}`,
    {
      question: z.string().describe('The natural-language question.'),
      principals,
      topK,
      sourceSystems,
    },
    async (args: { question: string } & CommonToolArgs): Promise<CallToolResult> => {
      const resolved = await resolveOrReject(args.principals);
      if ('error' in resolved) return resolved.error;
      const result = await deps.rag.answer(args.question, {
        identity: resolved.identity,
        topK: args.topK,
        sourceSystems: args.sourceSystems,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    'cerebro_search',
    `Hybrid (vector + lexical) retrieval over the knowledge layer WITHOUT generation. Returns permission-filtered chunks with source deep links and scores. ${identityNote}`,
    {
      query: z.string().describe('The search query.'),
      principals,
      topK,
      sourceSystems,
    },
    async (args: { query: string } & CommonToolArgs): Promise<CallToolResult> => {
      const resolved = await resolveOrReject(args.principals);
      if ('error' in resolved) return resolved.error;
      const results = await deps.retrieval.search(args.query, {
        identity: resolved.identity,
        topK: args.topK,
        sourceSystems: args.sourceSystems,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ query: args.query, results }, null, 2) }],
      };
    },
  );

  return server;
}

function errorResult(code: string, message: string): CallToolResult {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `${code}: ${message}` }],
  };
}

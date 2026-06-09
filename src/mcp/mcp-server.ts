import 'reflect-metadata';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';

/**
 * Cerebro as an MCP server (plan §6.5/§6.6) — exposes the knowledge layer as
 * tools any compatible agent can call, reusing the exact same retrieval + RAG
 * services as the REST API.
 *
 * IDENTITY INVARIANT (critique P1): the entire ACL model depends on knowing WHICH
 * end user is asking. An MCP server conventionally runs under one service
 * credential, so the caller MUST pass the end-user's resolved principals on every
 * tool call. Absent them, results are restricted to public content (fail-closed) —
 * never the whole corpus. In production these principals must be derived from a
 * per-user OAuth/OIDC token at the gateway, not trusted from the tool argument.
 *
 * RESIDENCY NOTE (critique P2): retrieved chunks are real enterprise content. If
 * the consuming agent runs on a non-EU-resident model, that egress needs DPO
 * sign-off — see the plan's Ch.4 decision table.
 *
 * Stdio is the protocol channel, so nothing may write to stdout; diagnostics go
 * to stderr and the Nest logger is disabled.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const rag = app.get(RagService, { strict: false });
  const retrieval = app.get(RetrievalService, { strict: false });

  const server = new McpServer({ name: 'cerebro', version: '0.1.0' });

  server.tool(
    'cerebro_query',
    'Answer a natural-language question from the enterprise knowledge layer. Returns a grounded answer with source citations (deep links). Pass the end-user principals so results are permission-filtered to them; without principals you only see public content.',
    {
      question: z.string().describe('The natural-language question.'),
      principals: z
        .array(z.string())
        .optional()
        .describe("End-user's Entra ID groups + user id. Drives the ACL filter."),
      topK: z.number().int().min(1).max(50).optional(),
      sourceSystems: z.array(z.string()).optional(),
    },
    async ({ question, principals, topK, sourceSystems }) => {
      const result = await rag.answer(question, {
        principals: principals ?? [],
        topK,
        sourceSystems,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'cerebro_search',
    'Hybrid (vector + lexical) retrieval over the knowledge layer WITHOUT generation. Returns permission-filtered chunks with source deep links and scores. Pass the end-user principals; without them you only see public content.',
    {
      query: z.string().describe('The search query.'),
      principals: z.array(z.string()).optional(),
      topK: z.number().int().min(1).max(50).optional(),
      sourceSystems: z.array(z.string()).optional(),
    },
    async ({ query, principals, topK, sourceSystems }) => {
      const results = await retrieval.search(query, {
        principals: principals ?? [],
        topK,
        sourceSystems,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ query, results }, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Cerebro MCP server ready on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`Cerebro MCP server failed: ${String(err)}\n`);
  process.exit(1);
});

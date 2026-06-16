import 'reflect-metadata';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IdentityService } from '../auth/identity.service';
import { PolicyDecisionPoint } from '../auth/delegation/pdp';
import { CONFIG, CerebroConfig } from '../config/config';
import { RagService } from '../rag/rag.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { McpIdentityProvider } from './mcp-identity';
import { createCerebroMcpServer } from './mcp-tools';

/**
 * Cerebro as an MCP server (plan §6.5/§6.6) — stdio bootstrap around
 * createCerebroMcpServer (see mcp-tools.ts for the identity invariant).
 *
 * RESIDENCY NOTE (critique P2): retrieved chunks are real enterprise content.
 * If the consuming agent runs on a non-EU-resident model, that egress needs
 * DPO sign-off — see the plan's Ch.4 decision table.
 *
 * Stdio is the protocol channel, so nothing may write to stdout; diagnostics
 * go to stderr and the Nest logger is disabled.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const config = app.get<CerebroConfig>(CONFIG, { strict: false });

  const server = createCerebroMcpServer({
    config,
    rag: app.get(RagService, { strict: false }),
    retrieval: app.get(RetrievalService, { strict: false }),
    identity: new McpIdentityProvider(config, app.get(IdentityService, { strict: false })),
    pdp: app.get(PolicyDecisionPoint, { strict: false }),
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`Cerebro MCP server ready on stdio (AUTH_MODE=${config.auth.mode})\n`);
}

main().catch((err) => {
  process.stderr.write(`Cerebro MCP server failed: ${String(err)}\n`);
  process.exit(1);
});

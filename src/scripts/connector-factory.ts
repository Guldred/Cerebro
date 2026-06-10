import * as path from 'path';
import { Connector } from '../ingestion/connectors/connector.interface';
import { SampleConnector } from '../ingestion/connectors/sample/sample.connector';
import { ConfluenceConnector } from '../ingestion/connectors/confluence/confluence.connector';
import { GitHubConnector } from '../ingestion/connectors/github/github.connector';
import { GitLabConnector } from '../ingestion/connectors/gitlab/gitlab.connector';

/**
 * Shared env-driven connector construction for the seed and acl-refresh
 * scripts. Choose with SEED_CONNECTOR=sample (default) | confluence | github
 * | gitlab.
 */
export function buildConnector(): Connector {
  const which = process.env.SEED_CONNECTOR ?? 'sample';
  switch (which) {
    case 'confluence':
      return new ConfluenceConnector({
        baseUrl: required('CONFLUENCE_BASE_URL'),
        email: required('CONFLUENCE_EMAIL'),
        apiToken: required('CONFLUENCE_API_TOKEN'),
        spaceKeys: list('CONFLUENCE_SPACE_KEYS'),
        certifiedPublicSpaces: list('CONFLUENCE_PUBLIC_SPACES'),
      });
    case 'github':
      return new GitHubConnector({
        token: process.env.GITHUB_TOKEN, // optional — public repos work without it
        repos: list('GITHUB_REPOS') ?? [],
        apiUrl: process.env.GITHUB_API_URL,
      });
    case 'gitlab':
      return new GitLabConnector({
        token: process.env.GITLAB_TOKEN, // optional — public projects work without it
        projects: list('GITLAB_PROJECTS') ?? [],
        baseUrl: process.env.GITLAB_BASE_URL,
      });
    case 'sample':
      return new SampleConnector(path.join(process.cwd(), 'seed'));
    default:
      throw new Error(`Unknown SEED_CONNECTOR: ${which}`);
  }
}

function list(key: string): string[] | undefined {
  return process.env[key]?.split(',').map((s) => s.trim()).filter(Boolean);
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`SEED_CONNECTOR=confluence requires ${key}`);
  return v;
}

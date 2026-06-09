import { SourceDocument } from '../../../documents/document.model';
import { Connector, SyncResult } from '../connector.interface';

export interface ConfluenceConfig {
  baseUrl: string; // e.g. https://your-domain.atlassian.net/wiki  (Cloud)
  email: string; // Cloud: Atlassian account email for Basic auth
  apiToken: string; // store in a secret manager, never in code (§7)
  spaceKeys?: string[]; // limit the crawl to specific spaces
}

/**
 * Confluence connector — SKELETON (Phase 1 target, plan §6.1).
 *
 * Implementation notes for when this is built out:
 *
 *  • Cloud vs Data Center: this skeleton targets Confluence CLOUD (REST v2 +
 *    `/wiki/rest/api`, CQL search, Basic auth with email + API token). Data Center
 *    uses a different base path and PAT auth — keep both behind this interface.
 *
 *  • initialCrawl: page through `GET /wiki/rest/api/content?type=page&expand=
 *    body.storage,version,space,ancestors,restrictions.read.restrictions.{user,group}`.
 *    Map body.storage (HTML) via HtmlLoader; build breadcrumb from `ancestors`;
 *    sourceUrl = `${baseUrl}${_links.webui}`.
 *
 *  • deltaSync: CQL `lastModified >= "<cursor>"` ordered by lastModified; the new
 *    cursor is the max lastModified seen. Detect deletions via the content audit
 *    log or by diffing crawled ids against stored ids (tombstones → vector removal).
 *
 *  • resolvePermissions: read `restrictions.read` (users + groups). When a page has
 *    no explicit restriction it inherits the space permissions — resolve those once
 *    per space and cache. These principals must match Entra ID group ids used at
 *    query time (§7) — reconcile the mapping in Phase 2.
 */
export class ConfluenceConnector implements Connector {
  readonly sourceSystem = 'confluence';

  constructor(private readonly config: ConfluenceConfig) {}

  async initialCrawl(): Promise<SourceDocument[]> {
    throw new Error(
      'ConfluenceConnector.initialCrawl not implemented — Phase 1. See class docs for the REST/CQL plan.',
    );
  }

  async deltaSync(_cursor: string | null): Promise<SyncResult> {
    throw new Error('ConfluenceConnector.deltaSync not implemented — Phase 3 (webhook/poll).');
  }

  async resolvePermissions(_externalId: string): Promise<string[]> {
    throw new Error('ConfluenceConnector.resolvePermissions not implemented — Phase 2 (ACL).');
  }
}

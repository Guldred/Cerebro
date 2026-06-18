import { SourceDocument } from '../../documents/document.model';

/** Result of an incremental sync: what changed and what was deleted. */
export interface SyncResult {
  /** Documents created or modified since the cursor. */
  documents: SourceDocument[];
  /** externalIds confirmed deleted in the source — their vectors must be removed (GDPR, §7). */
  deletedExternalIds: string[];
  /** Opaque cursor to persist and pass back on the next deltaSync. */
  cursor: string | null;
}

/**
 * Common interface every source connector implements (plan §6.1). Connectors are
 * independent and interchangeable; the pipeline only knows this contract.
 */
export interface Connector {
  readonly sourceSystem: string;

  /** Full crawl — every document currently visible in the source. */
  initialCrawl(): Promise<SourceDocument[]>;

  /**
   * Incremental sync since the given cursor (null = from the beginning).
   * Drives event/poll-based freshness; returns changes + tombstones.
   */
  deltaSync(cursor: string | null): Promise<SyncResult>;

  /**
   * Resolve the current authorized principals for a document. Used by the
   * periodic ACL refresh and the optional late-binding check (§7).
   */
  resolvePermissions(externalId: string): Promise<string[]>;

  /**
   * Scopes (e.g. repos) the MOST RECENT initialCrawl() could not read and
   * skipped. A non-empty result means that crawl was PARTIAL — the caller MUST
   * NOT reconcile-delete, because a crawl that never saw a scope cannot conclude
   * its documents are gone (a transient outage or a narrower token would
   * otherwise wipe real data). Connectors that always crawl completely omit this
   * (treated as []). Valid immediately after initialCrawl(); reset on each call.
   */
  skippedScopes?(): string[];
}

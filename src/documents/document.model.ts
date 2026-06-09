/**
 * The unified document model (plan §6.2). Every connector normalizes its source
 * format into this shape before the pipeline touches it. Source-specific quirks
 * stay inside the connector.
 */
export interface SourceDocument {
  sourceSystem: string; // 'confluence' | 'gitlab' | 'msteams' | ...
  externalId: string; // stable id within the source system
  sourceUrl: string; // deep link back to the original resource
  title: string;
  breadcrumb: string; // e.g. "Engineering > Onboarding"
  author?: string;
  contentType: string; // MIME-ish: 'text/markdown', 'text/html', ...
  lang?: string; // 'de' | 'en' | ...
  /** Principals (groups/users) allowed to see this in the source — the ACL (§7). */
  aclPrincipals: string[];
  /** Normalized body as Markdown (loaders convert HTML/code/Office into this). */
  body: string;
  sourceCreatedAt?: string; // ISO 8601
  sourceUpdatedAt?: string; // ISO 8601
}

/** A searchable block produced by the chunker, with citation metadata attached. */
export interface DocumentChunk {
  chunkIndex: number;
  headingPath: string; // in-document heading stack, e.g. "Setup > Database"
  anchor: string | null; // deep-link fragment for the heading
  content: string;
  tokenEstimate: number;
}

/** Stable primary key for a source document — makes re-ingestion idempotent. */
export function documentId(sourceSystem: string, externalId: string): string {
  return `${sourceSystem}:${externalId}`;
}

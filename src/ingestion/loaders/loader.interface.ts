/**
 * A loader turns one source-specific content format into normalized Markdown,
 * which the chunker then consumes. One loader per content type (plan §6.2):
 * HTML (Confluence storage format), Markdown, code, and — via Tika/unstructured —
 * PDF/Office attachments.
 */
export interface ContentLoader {
  /** MIME-ish content types this loader handles, e.g. ['text/html']. */
  readonly contentTypes: string[];
  /** Convert raw source content into normalized Markdown. */
  toMarkdown(raw: string): string;
}

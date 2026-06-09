import { ContentLoader } from './loader.interface';

/**
 * Minimal HTML → Markdown loader for the Confluence storage format.
 *
 * SCOPE: deliberately dependency-free and approximate — it preserves headings,
 * paragraphs, list items and link text, which is enough to keep heading-aware
 * chunking working. For production fidelity (tables, macros, code blocks, nested
 * structure) replace this with a real parser such as `unstructured`, Apache Tika,
 * or a DOM-based HTML-to-Markdown converter. The ContentLoader interface stays
 * the same, so nothing downstream changes.
 */
export class HtmlLoader implements ContentLoader {
  readonly contentTypes = ['text/html', 'application/vnd.confluence.storage'];

  toMarkdown(raw: string): string {
    let s = raw;

    // Drop script/style entirely.
    s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');

    // Headings → ATX so the chunker can split on them.
    for (let level = 1; level <= 6; level++) {
      const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
      s = s.replace(re, (_m, inner) => `\n\n${'#'.repeat(level)} ${stripTags(inner).trim()}\n\n`);
    }

    // List items.
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${stripTags(inner).trim()}`);

    // Block separators.
    s = s.replace(/<\/(p|div|tr|ul|ol|table|blockquote)>/gi, '\n\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');

    // Anything left → drop tags, decode a few entities.
    s = stripTags(s);
    s = decodeEntities(s);

    // Collapse excess blank lines.
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

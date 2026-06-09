import { ContentLoader } from './loader.interface';

/** Markdown is already the normalized form — pass through unchanged. */
export class MarkdownLoader implements ContentLoader {
  readonly contentTypes = ['text/markdown', 'text/plain'];
  toMarkdown(raw: string): string {
    return raw;
  }
}

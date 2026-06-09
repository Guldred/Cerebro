import { ContentLoader } from './loader.interface';
import { MarkdownLoader } from './markdown.loader';
import { HtmlLoader } from './html.loader';

/** Resolves the right loader for a document's content type. */
export class LoaderRegistry {
  private readonly byType = new Map<string, ContentLoader>();
  private readonly fallback = new MarkdownLoader();

  constructor(loaders: ContentLoader[] = [new MarkdownLoader(), new HtmlLoader()]) {
    for (const loader of loaders) {
      for (const type of loader.contentTypes) this.byType.set(type, loader);
    }
  }

  /** Normalize raw content to Markdown using the loader for `contentType`. */
  toMarkdown(contentType: string, raw: string): string {
    const loader = this.byType.get(contentType) ?? this.fallback;
    return loader.toMarkdown(raw);
  }
}

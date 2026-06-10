import { promises as fs } from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { SourceDocument } from '../../../documents/document.model';
import { Connector, SyncResult } from '../connector.interface';

/**
 * The reference connector used for local dev, the demo, and the eval harness.
 *
 * It reads Markdown files with YAML front-matter from a seed directory — no
 * external API, tokens, or network. Each file's front-matter carries the same
 * metadata a real connector would resolve from its source (source_url, acl,
 * author, dates), so the entire pipeline runs end-to-end out of the box. The
 * `source_system` in front-matter is preserved (often 'confluence'/'gitlab') so
 * the demo mirrors a real multi-source corpus.
 */
export class SampleConnector implements Connector {
  readonly sourceSystem = 'sample';

  constructor(private readonly seedDir: string) {}

  async initialCrawl(): Promise<SourceDocument[]> {
    const files = (await fs.readdir(this.seedDir)).filter((f) => f.endsWith('.md'));
    const docs: SourceDocument[] = [];
    for (const file of files) {
      docs.push(await this.parseFile(path.join(this.seedDir, file)));
    }
    return docs;
  }

  async deltaSync(cursor: string | null): Promise<SyncResult> {
    const since = cursor ? Date.parse(cursor) : 0;
    const files = (await fs.readdir(this.seedDir)).filter((f) => f.endsWith('.md'));
    const documents: SourceDocument[] = [];
    let newest = since;
    for (const file of files) {
      const full = path.join(this.seedDir, file);
      const stat = await fs.stat(full);
      if (stat.mtimeMs > since) {
        documents.push(await this.parseFile(full));
        newest = Math.max(newest, stat.mtimeMs);
      }
    }
    // Deletion detection for a directory source is reconciled by the ingestion
    // service against the stored id set (see IngestionService.runInitialCrawl).
    return { documents, deletedExternalIds: [], cursor: new Date(newest).toISOString() };
  }

  async resolvePermissions(externalId: string): Promise<string[]> {
    const doc = await this.parseFile(path.join(this.seedDir, `${externalId}.md`)).catch(() => null);
    return doc?.aclPrincipals ?? [];
  }

  private async parseFile(file: string): Promise<SourceDocument> {
    const raw = await fs.readFile(file, 'utf8');
    const { data, content } = matter(raw);
    const externalId = String(data.external_id ?? path.basename(file, '.md'));
    return {
      sourceSystem: String(data.source_system ?? this.sourceSystem),
      externalId,
      sourceUrl: String(data.source_url ?? `file://${file}`),
      title: String(data.title ?? externalId),
      breadcrumb: String(data.breadcrumb ?? ''),
      author: data.author ? String(data.author) : undefined,
      contentType: String(data.content_type ?? 'text/markdown'),
      lang: data.lang ? String(data.lang) : undefined,
      aclPrincipals: normalizeAcl(data.acl_principals),
      // `acl_status: failed` simulates a permission-resolution failure so the
      // quarantine path (zero principals, invisible) runs through the REAL
      // ingestion + SQL filter in the demo corpus and the eval.
      aclStatus: data.acl_status === 'failed' ? 'failed' : undefined,
      body: content.trim(),
      sourceCreatedAt: toIso(data.created_at),
      sourceUpdatedAt: toIso(data.updated_at),
    };
  }
}

/** YAML parses ISO timestamps into Date objects; normalize everything to an ISO string. */
function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// NOTE: defaulting an *unspecified* ACL to ['public'] is a SEED-ONLY convenience —
// the seed files that omit acl_principals are genuinely public demo content. A REAL
// connector must do the opposite (fail-closed): an unresolved or empty source ACL
// must map to NO principals (invisible), never to public, or an upstream permission
// lookup that fails silently becomes a leak. See Plan_Review.md P1 (fail-closed).
function normalizeAcl(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return ['public'];
}

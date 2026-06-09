import { chunkMarkdown, slugify, estimateTokens } from './chunker';

describe('chunkMarkdown', () => {
  it('splits on headings and records the heading path + anchor', () => {
    const md = [
      '# Page Title',
      'Intro paragraph.',
      '## Setup',
      'Install the thing.',
      '### Database',
      'Run the migrations.',
    ].join('\n');

    const chunks = chunkMarkdown(md);
    const dbChunk = chunks.find((c) => c.content.includes('Run the migrations'));
    expect(dbChunk).toBeDefined();
    expect(dbChunk!.headingPath).toBe('Page Title > Setup > Database');
    expect(dbChunk!.anchor).toBe('database');
  });

  it('returns a single anchorless chunk for a body with no headings', () => {
    const chunks = chunkMarkdown('Just a flat paragraph with no headings at all.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toBe('');
    expect(chunks[0].anchor).toBeNull();
  });

  it('size-bounds a long section into multiple overlapping chunks', () => {
    const para = Array.from({ length: 60 }, (_, i) => `sentence number ${i} here.`).join(' ');
    const body = `# Big\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(body, { maxTokens: 64, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.tokenEstimate))).toBeLessThanOrEqual(120);
    // chunk_index is dense and ordered
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});

describe('slugify', () => {
  it('lowercases, hyphenates, and preserves unicode letters', () => {
    expect(slugify('Recht auf Löschung')).toBe('recht-auf-löschung');
    expect(slugify('  Local Development Setup ')).toBe('local-development-setup');
  });
});

describe('estimateTokens', () => {
  it('grows with word count', () => {
    expect(estimateTokens('one two three')).toBeGreaterThan(estimateTokens('one'));
    expect(estimateTokens('')).toBe(0);
  });
});

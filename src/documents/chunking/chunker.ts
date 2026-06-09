import { DocumentChunk } from '../document.model';

export interface ChunkOptions {
  /** Soft upper bound per chunk (plan §6.2: ~512–1024 tokens). */
  maxTokens: number;
  /** Carried-over tokens between adjacent chunks (~10–15% overlap). */
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 512, overlapTokens: 64 };

/**
 * Structure-aware, size-bounded chunker for Markdown.
 *
 * 1. Split the body on ATX headings (#..######), tracking the heading stack so
 *    each chunk knows its in-document path (improves answer quality and enables
 *    section-precise deep-link anchors — plan §6.2).
 * 2. Within each section, pack paragraphs into windows up to `maxTokens`, with
 *    `overlapTokens` of trailing context carried into the next window so a fact
 *    split across a boundary stays retrievable.
 */
export function chunkMarkdown(
  body: string,
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): DocumentChunk[] {
  const sections = splitIntoSections(body);
  const chunks: DocumentChunk[] = [];
  let index = 0;

  for (const section of sections) {
    const headingPath = section.headingStack.map((h) => h.text).join(' > ');
    const anchor =
      section.headingStack.length > 0
        ? slugify(section.headingStack[section.headingStack.length - 1].text)
        : null;

    for (const content of packParagraphs(section.body, opts)) {
      chunks.push({
        chunkIndex: index++,
        headingPath,
        anchor,
        content,
        tokenEstimate: estimateTokens(content),
      });
    }
  }

  return chunks;
}

interface Heading {
  level: number;
  text: string;
}
interface Section {
  headingStack: Heading[];
  body: string;
}

function splitIntoSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  const stack: Heading[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) sections.push({ headingStack: [...stack], body: text });
    buffer = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      const text = m[2].trim();
      // Pop deeper-or-equal headings, then push this one.
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
    } else {
      buffer.push(line);
    }
  }
  flush();

  // A document whose body has no headings still yields one section.
  if (sections.length === 0 && body.trim().length > 0) {
    sections.push({ headingStack: [], body: body.trim() });
  }
  return sections;
}

function packParagraphs(text: string, opts: ChunkOptions): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const windows: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const emit = () => {
    if (current.length === 0) return;
    windows.push(current.join('\n\n'));
  };

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    // A single oversized paragraph is hard-split by sentences.
    if (paraTokens > opts.maxTokens) {
      emit();
      current = [];
      currentTokens = 0;
      windows.push(...hardSplit(para, opts.maxTokens));
      continue;
    }

    if (currentTokens + paraTokens > opts.maxTokens && current.length > 0) {
      emit();
      // Start the next window with an overlap tail of the previous one.
      const tail = takeTail(current.join('\n\n'), opts.overlapTokens);
      current = tail ? [tail] : [];
      currentTokens = tail ? estimateTokens(tail) : 0;
    }

    current.push(para);
    currentTokens += paraTokens;
  }
  emit();
  return windows;
}

function hardSplit(text: string, maxTokens: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur: string[] = [];
  let tok = 0;
  for (const s of sentences) {
    const st = estimateTokens(s);
    if (tok + st > maxTokens && cur.length > 0) {
      out.push(cur.join(' '));
      cur = [];
      tok = 0;
    }
    cur.push(s);
    tok += st;
  }
  if (cur.length > 0) out.push(cur.join(' '));
  return out;
}

function takeTail(text: string, overlapTokens: number): string {
  const words = text.split(/\s+/);
  const approxWords = Math.round(overlapTokens / TOKENS_PER_WORD);
  if (words.length <= approxWords) return text;
  return words.slice(words.length - approxWords).join(' ');
}

const TOKENS_PER_WORD = 1.3; // rough multilingual average; German runs higher

/** Cheap, dependency-free token estimate. Replace with a real tokenizer if exactness matters. */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * TOKENS_PER_WORD);
}

/** GitHub-style heading slug for deep-link anchors. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

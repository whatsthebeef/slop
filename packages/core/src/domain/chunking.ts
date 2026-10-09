import { hash } from '../app/text-hash.js';
import { markdownHeadings } from './sections.js';
import { SOURCE_LABELS } from './search.js';
import type { NewChunk, SourceType } from './search.js';

/** Chunk sizes in tokens (`estimateTokens`): windows are packed to the target, never above the maximum. */
export const CHUNK_MIN_TOKENS = 300;
export const CHUNK_TARGET_TOKENS = 450;
export const CHUNK_MAX_TOKENS = 600;

const MIN_CHARS = CHUNK_MIN_TOKENS * 4;
const TARGET_CHARS = CHUNK_TARGET_TOKENS * 4;
const MAX_CHARS = CHUNK_MAX_TOKENS * 4;

export interface ChunkInput {
  readonly sourceType: SourceType;
  /** ISO date or timestamp; only its day goes in the header. */
  readonly date: string;
  readonly title: string;
  readonly text: string;
}

/** The text a chunk's section header is made from: stable facts only (no glob links, no status). */
export const chunkHeader = (input: Pick<ChunkInput, 'sourceType' | 'date' | 'title'>, section: string): string => {
  const parts = [SOURCE_LABELS[input.sourceType], input.date.slice(0, 10), `"${input.title}"`];
  if (section !== '') parts.push(section);
  return `[${parts.join(' · ')}]`;
};

/** What decides whether an item is re-indexed: any change to its kind, title, date or text. */
export const contentHash = (input: ChunkInput): string => hash([input.sourceType, input.title, input.date, input.text].join('|'));

interface Section {
  readonly name: string;
  readonly body: string;
}

/** Splits at `#` and `##` headings; text before the first heading has no section name. */
const sections = (text: string): Section[] => {
  const lines = text.split(/\r?\n/);
  const cuts = markdownHeadings(text).filter((h) => h.level <= 2);
  const slice = (from: number, to: number) => lines.slice(from, to).join('\n').trim();
  const found: Section[] = [];
  const first = cuts[0]?.line ?? lines.length;
  found.push({ name: '', body: slice(0, first) });
  cuts.forEach((cut, i) => found.push({ name: cut.text, body: slice(cut.line + 1, cuts[i + 1]?.line ?? lines.length) }));
  return found.filter((s) => s.body !== '');
};

/** Paragraphs (blank-line separated; a fenced block stays whole), none longer than the maximum. */
const paragraphs = (body: string): string[] => {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined !== '') out.push(joined);
    current = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (line.trim() === '' && !fenced) flush();
    else current.push(line);
  }
  flush();
  return out.flatMap(splitLong);
};

/** A paragraph over the maximum is cut at sentence ends, and a sentence over it at the maximum. */
const splitLong = (paragraph: string): string[] => {
  if (paragraph.length <= MAX_CHARS) return [paragraph];
  const pieces: string[] = [];
  let current = '';
  const add = (piece: string) => {
    if (current !== '' && current.length + 1 + piece.length > MAX_CHARS) {
      pieces.push(current);
      current = '';
    }
    current = current === '' ? piece : `${current} ${piece}`;
  };
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    for (let at = 0; at < sentence.length; at += MAX_CHARS) add(sentence.slice(at, at + MAX_CHARS));
  }
  if (current !== '') pieces.push(current);
  return pieces;
};

interface Window {
  readonly section: string;
  text: string;
}

/** Packs a section's paragraphs into windows: to the target, or up to the maximum while a window is below the minimum. */
const windows = (section: Section): Window[] => {
  const out: Window[] = [];
  let current = '';
  for (const paragraph of paragraphs(section.body)) {
    const limit = current.length < MIN_CHARS ? MAX_CHARS : TARGET_CHARS;
    if (current !== '' && current.length + 2 + paragraph.length > limit) {
      out.push({ section: section.name, text: current });
      current = '';
    }
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
  }
  if (current !== '') out.push({ section: section.name, text: current });
  return out;
};

/**
 * Splits a document into chunks of about 450 tokens (300 to 600), without overlap. Sections (by heading) keep their
 * name in the chunk header; a short trailing window, or a whole short section, joins the chunk before it (under its
 * own heading line) when the two fit the maximum. Deterministic, so the same document always yields the same chunks.
 */
export const chunkDocument = (input: ChunkInput): NewChunk[] => {
  const all = sections(input.text).flatMap(windows);
  const merged: Window[] = [];
  for (const window of all) {
    const previous = merged.at(-1);
    const joined =
      previous === undefined
        ? null
        : `${previous.text}\n\n${window.section === previous.section ? '' : `## ${window.section}\n\n`}${window.text}`;
    if (previous !== undefined && joined !== null && window.text.length < MIN_CHARS && joined.length <= MAX_CHARS) {
      previous.text = joined;
    } else {
      merged.push({ section: window.section, text: window.text });
    }
  }
  return merged.map((w, position) => ({ position, header: chunkHeader(input, w.section), text: w.text }));
};

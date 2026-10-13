import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Names the glob view's actions no longer use (s15f88..s15f93). */
const OLD_LABELS = [
  'Hand to routine',
  'Re-trigger',
  'Take over',
  'Mark done (PR ready)',
  'Get AI review',
  'Make it a sub again',
  'Make it a super',
  'Back to Planning',
];

describe('old action labels', () => {
  it('no longer appear in the web app source', () => {
    const files = walk(join(__dirname, '../src')).filter((f) => /\.tsx?$/.test(f));
    const found = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return OLD_LABELS.filter((l) => text.includes(l)).map((l) => `${f}: ${l}`);
    });
    expect(found).toEqual([]);
  });
});

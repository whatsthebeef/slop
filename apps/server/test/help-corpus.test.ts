import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_DOC_MAX_CHARS, loadHelpCorpus, splitHelpFile } from '../src/help-corpus.js';

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
/** The indexer caps one item's text here (SearchIndexer's TEXT_LIMIT). */
const INDEXER_TEXT_LIMIT = 100_000;

describe('help corpus', () => {
  it('is built only from the listed repository files', async () => {
    const warnings: string[] = [];
    const docs = await loadHelpCorpus({ docsDir: repo('docs'), catalogDir: repo('catalog') }, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    const paths = [...new Set(docs.map((d) => d.ref.split('#')[0]))].sort();
    expect(paths).toEqual([
      'catalog/agents/README.md',
      'catalog/agents/claude_md.md',
      'catalog/agents/commands/finalise.md',
      'catalog/agents/commands/kb-bootstrap.md',
      'catalog/agents/commands/run-glob.md',
      'docs/guide.md',
      'docs/slop_behaviour_architecture_spec.md',
    ]);
    for (const doc of docs) {
      expect(doc.ref).not.toMatch(/\.reviews|\.sstor|\.env|node_modules/);
      expect(doc.url?.startsWith('https://github.com/')).toBe(true);
      expect(doc.text.length).toBeGreaterThan(0);
      expect(doc.text.length).toBeLessThanOrEqual(HELP_DOC_MAX_CHARS);
      expect(doc.text.length).toBeLessThan(INDEXER_TEXT_LIMIT);
    }
    // Refs are unique, since each becomes one item's external ref.
    expect(new Set(docs.map((d) => d.ref)).size).toBe(docs.length);
  });

  it('has a guide section for watch signals', async () => {
    const docs = await loadHelpCorpus({ docsDir: repo('docs'), catalogDir: repo('catalog') }, () => undefined);
    const section = docs.find((d) => d.ref === 'docs/guide.md#watch-signals-and-effect-checks');
    expect(section?.text).toContain('watch signal');
  });

  it('warns and yields nothing for a missing folder instead of failing', async () => {
    const warnings: string[] = [];
    const docs = await loadHelpCorpus({ docsDir: '/nonexistent/docs', catalogDir: '/nonexistent/catalog' }, (m) => warnings.push(m));
    expect(docs).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('splits on level-two headings and cuts an oversized section into parts under the cap', () => {
    const [intro, a, b] = splitHelpFile('docs/x.md', '# Title\n\nintro\n\n## A\n\nabout a\n\n## B\n\nabout b', true);
    expect([intro?.ref, a?.ref, b?.ref]).toEqual(['docs/x.md#top', 'docs/x.md#a', 'docs/x.md#b']);
    expect(a?.title).toBe('Title: A');
    const big = splitHelpFile('docs/y.md', `# T\n\n## Big\n\n${Array.from({ length: 40 }, () => 'p'.repeat(5000)).join('\n\n')}`, true);
    expect(big.length).toBeGreaterThan(1);
    for (const d of big) expect(d.text.length).toBeLessThanOrEqual(HELP_DOC_MAX_CHARS);
    expect(new Set(big.map((d) => d.ref)).size).toBe(big.length);
  });
});

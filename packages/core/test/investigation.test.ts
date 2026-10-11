import { describe, expect, it } from 'vitest';
import { parseInvestigation } from '../src/domain/investigation.js';

const BLOCK = {
  files: [{ path: 'apps/server/src/a.ts', change: 'modify' }],
  modules: ['server'],
  expectedLines: { min: 20, max: 80 },
  parts: [
    { name: 'core', files: ['packages/core/src/x.ts'], needs: [] },
    { name: 'web', files: ['apps/web/src/y.tsx'], needs: ['core'] },
  ],
  riskTier: 'normal',
  riskAreas: [],
  needsHuman: { needed: false, reason: null },
  confidence: 'medium',
  planHash: 'abc123',
  baseCommit: 'def4567',
};

const wrap = (value: unknown): string => `# Investigation\n\nProse.\n\n\`\`\`investigation\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

describe('parseInvestigation', () => {
  it('reads a valid block', () => {
    const parsed = parseInvestigation(wrap(BLOCK));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.investigation.riskTier).toBe('normal');
      expect(parsed.investigation.parts.map((p) => p.name)).toEqual(['core', 'web']);
    }
  });

  it('uses the last block when the text shows an example earlier', () => {
    const text = `${wrap({ ...BLOCK, riskTier: 'high' })}\nLater:\n${wrap(BLOCK)}`;
    const parsed = parseInvestigation(text);
    expect(parsed.ok && parsed.investigation.riskTier).toBe('normal');
  });

  it('reports a missing block', () => {
    expect(parseInvestigation('# Investigation only prose')).toEqual({ ok: false, errors: ['No ```investigation fenced block found'] });
  });

  it('reports invalid JSON', () => {
    const parsed = parseInvestigation('```investigation\n{nope\n```');
    expect(!parsed.ok && parsed.errors[0]).toContain('not valid JSON');
  });

  it('lists every field problem', () => {
    const parsed = parseInvestigation(
      wrap({
        ...BLOCK,
        files: [{ path: '', change: 'rename' }],
        expectedLines: { min: 9, max: 1 },
        parts: [{ name: 'a', files: [], needs: ['ghost'] }],
        riskTier: 'extreme',
        needsHuman: { needed: true, reason: null },
        confidence: 'sure',
        planHash: '',
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const text = parsed.errors.join('\n');
      expect(text).toContain('files[0]');
      expect(text).toContain('expectedLines');
      expect(text).toContain('"ghost"');
      expect(text).toContain('riskTier');
      expect(text).toContain('needsHuman.reason');
      expect(text).toContain('confidence');
      expect(text).toContain('planHash');
    }
  });
});

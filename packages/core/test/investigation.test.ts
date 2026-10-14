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

  it('reads the relations the investigator found, and keeps an empty list apart from none', () => {
    const none = parseInvestigation(wrap(BLOCK));
    expect(none.ok && none.investigation.relations).toBeUndefined();
    const empty = parseInvestigation(wrap({ ...BLOCK, relations: [] }));
    expect(empty.ok && empty.investigation.relations).toEqual([]);
    const found = parseInvestigation(wrap({ ...BLOCK, relations: [{ to: 's1t2', reason: 'uses humanSteps()', files: ['a.ts'] }] }));
    expect(found.ok && found.investigation.relations).toEqual([{ to: 's1t2', gate: 'start', until: 'merged', reason: 'uses humanSteps()', files: ['a.ts'] }]);
    const full = parseInvestigation(wrap({ ...BLOCK, relations: [{ to: 's1k4', gate: 'merge', until: 'decided', reason: 'the store is open' }] }));
    expect(full.ok && full.investigation.relations).toEqual([{ to: 's1k4', gate: 'merge', until: 'decided', reason: 'the store is open', files: [] }]);
    const bad = parseInvestigation(wrap({ ...BLOCK, relations: [{ to: 's1t2', gate: 'finish', reason: '' }] }));
    expect(!bad.ok && bad.errors[0]).toContain('relations[0]');
    const unknownUntil = parseInvestigation(wrap({ ...BLOCK, relations: [{ to: 's1t2', until: 'soon', reason: 'x' }] }));
    expect(!unknownUntil.ok && unknownUntil.errors[0]).toContain('relations[0]');
  });

  it('still accepts the older dependencies list: needs become start relations, overlaps are dropped', () => {
    const old = parseInvestigation(
      wrap({ ...BLOCK, dependencies: [{ id: 's1t2', kind: 'needs', reason: 'uses humanSteps()', files: ['a.ts'] }, { id: 's1t3', kind: 'overlaps', reason: 'same file' }] }),
    );
    expect(old.ok && old.investigation.relations).toEqual([{ to: 's1t2', gate: 'start', until: 'merged', reason: 'uses humanSteps()', files: ['a.ts'] }]);
    const empty = parseInvestigation(wrap({ ...BLOCK, dependencies: [] }));
    expect(empty.ok && empty.investigation.relations).toEqual([]);
    const bad = parseInvestigation(wrap({ ...BLOCK, dependencies: [{ id: 's1t2', kind: 'blocks', reason: '' }] }));
    expect(!bad.ok && bad.errors[0]).toContain('dependencies[0]');
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

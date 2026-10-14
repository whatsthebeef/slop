import { describe, expect, it } from 'vitest';
import { parseTestPlan, testPlanNote, testPlanSpecs, unionSpecs } from '../src/domain/test-plan.js';

const MATRIX = [
  '| Name | Status | Location | Description |',
  '|---|---|---|---|',
  '| Sign-off shows rollout steps | new | `e2e/glob-view/rollout.spec.ts` (to add) | What it proves |',
  '| Board loads and lists globs | existing | `e2e/board.spec.ts` | Runs unchanged; covers the list after the change |',
  '| Merge button confirm | adjusted | `e2e/glob-card/merge.spec.ts` | Expects the corner status instead of the Your turn button |',
].join('\n');

const BLOCK = [
  '```atf-specs',
  'specs:',
  '  - e2e/glob-view/rollout.spec.ts',
  '  - e2e/board.spec.ts   # runs unchanged',
  '  - e2e/glob-card/merge.spec.ts',
  'grep: null          # optional Playwright --grep, e.g. "@rollout"',
  '```',
].join('\n');

const plan = (...parts: string[]): string => ['# Test plan', ...parts].join('\n\n');

describe('parseTestPlan', () => {
  it('reads the matrix and the atf-specs block of a valid plan', () => {
    const parsed = parseTestPlan(plan(MATRIX, BLOCK));
    expect(parsed.notes).toEqual([]);
    expect(parsed.matrix.map((r) => [r.status, r.location])).toEqual([
      ['new', 'e2e/glob-view/rollout.spec.ts'],
      ['existing', 'e2e/board.spec.ts'],
      ['adjusted', 'e2e/glob-card/merge.spec.ts'],
    ]);
    expect(parsed.atf).toEqual({
      specs: ['e2e/glob-view/rollout.spec.ts', 'e2e/board.spec.ts', 'e2e/glob-card/merge.spec.ts'],
      grep: null,
    });
    expect(testPlanNote(parsed.notes)).toBeNull();
  });

  it('reads a grep scalar, quoted or not, and keeps a # inside quotes', () => {
    expect(
      parseTestPlan('```atf-specs\nspecs:\n  - a.spec.ts\ngrep: "@roll#out"  # why\n```').atf?.grep,
    ).toBe('@roll#out');
    expect(
      parseTestPlan('```atf-specs\nspecs:\n  - a.spec.ts\ngrep: @rollout\n```').atf?.grep,
    ).toBe('@rollout');
  });

  it('lets the last block win', () => {
    const later = '```atf-specs\nspecs:\n  - later.spec.ts\n```';
    expect(parseTestPlan(plan(BLOCK, later)).atf?.specs).toEqual(['later.spec.ts']);
  });

  it('ignores a table inside a code fence and reads the first real one', () => {
    const fenced =
      '```md\n| Name | Status | Location | Description |\n|---|---|---|---|\n| X | new | `x.ts` | y |\n```';
    expect(parseTestPlan(plan(fenced, MATRIX, BLOCK)).matrix).toHaveLength(3);
  });

  it('notes a missing block when the matrix has rows, and nothing for an empty text', () => {
    expect(parseTestPlan(plan(MATRIX)).notes).toEqual([
      'No ```atf-specs block: the pipeline has nothing to run',
    ]);
    expect(parseTestPlan('').notes).toEqual([]);
    expect(parseTestPlan('').atf).toBeNull();
  });

  it('notes matrix locations that are not in specs', () => {
    const short = '```atf-specs\nspecs:\n  - e2e/board.spec.ts\n```';
    const notes = parseTestPlan(plan(MATRIX, short)).notes;
    expect(notes).toContain(
      '"e2e/glob-view/rollout.spec.ts" (Sign-off shows rollout steps) is in the matrix but not in the atf-specs block',
    );
    expect(notes).toHaveLength(2);
  });

  it('notes unusable paths: absolute, parent, backslash, too long', () => {
    const block = [
      '```atf-specs',
      'specs:',
      '  - /abs/a.spec.ts',
      '  - ../up/b.spec.ts',
      '  - dir\\c.spec.ts',
      `  - ${'x'.repeat(301)}`,
      '```',
    ].join('\n');
    const notes = parseTestPlan(block).notes;
    expect(notes.some((n) => n.includes('"/abs/a.spec.ts" is absolute'))).toBe(true);
    expect(notes.some((n) => n.includes('"../up/b.spec.ts" goes up'))).toBe(true);
    expect(notes.some((n) => n.includes('backslash'))).toBe(true);
    expect(notes.some((n) => n.includes('longer than 300'))).toBe(true);
  });

  it('notes duplicates once, too many specs, and a long grep', () => {
    const dup = '```atf-specs\nspecs:\n  - a.spec.ts\n  - a.spec.ts\n  - a.spec.ts\n```';
    expect(parseTestPlan(dup).notes).toEqual(['"a.spec.ts" is listed twice']);
    const many = `\`\`\`atf-specs\nspecs:\n${Array.from({ length: 201 }, (_, i) => `  - s${String(i)}.spec.ts`).join('\n')}\n\`\`\``;
    expect(parseTestPlan(many).notes).toEqual(['At most 200 specs, found 201']);
    expect(
      parseTestPlan(`\`\`\`atf-specs\nspecs:\n  - a.spec.ts\ngrep: ${'g'.repeat(201)}\n\`\`\``)
        .notes,
    ).toEqual(['grep is longer than 200 characters']);
  });

  it('notes an unknown status and an adjusted row that does not say what changes', () => {
    const rows = [
      '| Name | Status | Location | Description |',
      '|---|---|---|---|',
      '| A | maybe | `a.spec.ts` | text |',
      '| B | adjusted | `b.spec.ts` | tweak |',
    ].join('\n');
    const block = '```atf-specs\nspecs:\n  - a.spec.ts\n  - b.spec.ts\n```';
    const parsed = parseTestPlan(plan(rows, block));
    expect(parsed.matrix[0]?.status).toBeNull();
    expect(parsed.notes).toEqual([
      'Row "A" has status "maybe", not one of new, existing, adjusted',
      'Row "B" is adjusted: its description must say what changes',
    ]);
    expect(testPlanNote(parsed.notes)).toMatch(/^Test plan not fully valid: /);
  });

  it('notes lines and a specs value the grammar does not know, without throwing', () => {
    const notes = parseTestPlan('```atf-specs\nspecs: a.spec.ts\nfoo: bar\n```').notes;
    expect(notes).toEqual([
      'specs must be a list of "- path" lines',
      'Unrecognised line in the atf-specs block: "foo: bar"',
    ]);
  });

  it('accepts an empty list (the default suite)', () => {
    expect(parseTestPlan('```atf-specs\nspecs: []\ngrep: ~\n```')).toEqual({
      matrix: [],
      atf: { specs: [], grep: null },
      notes: [],
    });
  });

  it('keeps a pipe escaped inside a description', () => {
    const rows = [
      '| Name | Status | Location | Description |',
      '|---|---|---|---|',
      '| A | existing | `a.spec.ts` | a \\| b |',
    ].join('\n');
    expect(parseTestPlan(rows).matrix[0]?.description).toBe('a | b');
  });
});

describe('testPlanSpecs', () => {
  it('prefers the list stored on the provenance and falls back to the text', () => {
    const content = plan(BLOCK);
    expect(
      testPlanSpecs({
        content,
        provenance: { atfSpecs: { specs: ['stored.spec.ts'], grep: null } },
      })?.specs,
    ).toEqual(['stored.spec.ts']);
    expect(testPlanSpecs({ content, provenance: {} })?.specs).toHaveLength(3);
    expect(testPlanSpecs({ content: 'no block', provenance: {} })).toBeNull();
  });
});

describe('unionSpecs', () => {
  it('lists each spec and grep once with the globs that asked, sorted', () => {
    const union = unionSpecs([
      { globId: 's1t2', atf: { specs: ['b.spec.ts', 'a.spec.ts'], grep: '@x' } },
      { globId: 's1t1', atf: { specs: ['a.spec.ts'], grep: '@x' } },
      { globId: 's1t3', atf: null },
      { globId: 's1t4', atf: { specs: [], grep: '@y' } },
    ]);
    expect(union.specs).toEqual([
      { spec: 'a.spec.ts', globIds: ['s1t1', 's1t2'] },
      { spec: 'b.spec.ts', globIds: ['s1t2'] },
    ]);
    expect(union.greps).toEqual([
      { grep: '@x', globIds: ['s1t1', 's1t2'] },
      { grep: '@y', globIds: ['s1t4'] },
    ]);
  });

  it('is empty when no glob has a list', () => {
    expect(unionSpecs([{ globId: 's1t1', atf: null }])).toEqual({ specs: [], greps: [] });
  });
});

import { describe, expect, it } from 'vitest';
import { formatId, letterOf, parseId } from '../src/domain/ids.js';
import { isValidCombination, listOf } from '../src/domain/matrix.js';
import { DEFAULT_SIZE_IGNORED_PATHS, matchesGlob, sizeIgnoredPathsOf, subGatePolicy } from '../src/domain/sub-gate.js';

describe('type/category matrix', () => {
  it.each([
    ['sub', 'feature', true],
    ['same', 'feature', true],
    ['super', 'feature', true],
    ['sub', 'task', true],
    ['same', 'task', true],
    ['super', 'task', true],
    ['sub', 'bug', true],
    ['same', 'bug', true],
    ['super', 'bug', false],
  ] as const)('%s %s → %s', (type, category, expected) => {
    expect(isValidCombination(type, category)).toBe(expected);
  });
});

describe('IDs', () => {
  it('formats and parses board, letter and number', () => {
    expect(formatId(1, letterOf('feature'), 12)).toBe('s1f12');
    expect(formatId(2, letterOf('bug'), 3)).toBe('s2b3');
    expect(parseId('s12t4')).toEqual({ boardId: 12, letter: 't', n: 4 });
    expect(parseId('s1x4')).toBeNull();
    expect(parseId('s0t4')).toBeNull();
    expect(parseId('feature/s1t4')).toBeNull();
  });
});

describe('sub gate policy', () => {
  const board = { subMaxChangedLines: 100, sensitivePaths: ['infra/**', '**/*.sql', '.github/workflows/*'] };

  it('matches sensitive path globs', () => {
    expect(matchesGlob('infra/lib/stack.ts', 'infra/**')).toBe(true);
    expect(matchesGlob('db/migrations/001.sql', '**/*.sql')).toBe(true);
    expect(matchesGlob('.github/workflows/ci.yml', '.github/workflows/*')).toBe(true);
    expect(matchesGlob('src/infra.ts', 'infra/**')).toBe(false);
  });

  it('passes small changes outside sensitive paths and flags the rest', () => {
    expect(subGatePolicy({ changedLines: 40, files: ['src/a.ts'] }, board)).toEqual({ passed: true, reason: null, cause: null, changedLines: 40, ignoredLines: 0 });
    expect(subGatePolicy({ changedLines: 400, files: ['src/a.ts'] }, board).reason).toMatch(/400 lines/);
    expect(subGatePolicy({ changedLines: 5, files: ['infra/x.ts', 'src/a.ts'] }, board).reason).toMatch(/infra\/x.ts/);
  });

  it('says why a sub converted and records its size, for the learned limit', () => {
    expect(subGatePolicy({ changedLines: 400, files: ['src/a.ts'] }, board)).toEqual({
      passed: false,
      reason: 'Changes 400 lines (limit 100)',
      cause: 'size',
      changedLines: 400,
      ignoredLines: 0,
    });
    // A sensitive path wins over size: the size alone wouldn't teach the limit anything.
    expect(subGatePolicy({ changedLines: 400, files: ['infra/x.ts'] }, board)).toMatchObject({ passed: false, cause: 'sensitive', changedLines: 400 });
    // Exactly at the limit passes.
    expect(subGatePolicy({ changedLines: 100, files: ['src/a.ts'] }, board)).toMatchObject({ passed: true, cause: null });
  });
});

describe('sub gate size, generated files', () => {
  const board = { subMaxChangedLines: 1750, sensitivePaths: ['infra/**'] };
  const diff = {
    changedLines: 3748,
    files: ['apps/server/src/a.ts', 'apps/server/drizzle/meta/0022_snapshot.json'],
    fileLines: { 'apps/server/src/a.ts': 701, 'apps/server/drizzle/meta/0022_snapshot.json': 3047 },
  };

  it("leaves the policy's ignored paths out of the size and says how many", () => {
    expect(subGatePolicy(diff, { ...board, subMaxChangedLines: 500 }, ['apps/server/drizzle/meta/**'])).toMatchObject({
      passed: false,
      reason: 'Changes 701 lines, not counting 3,047 generated (limit 500)',
      changedLines: 701,
      ignoredLines: 3047,
    });
    expect(subGatePolicy(diff, board, ['apps/server/drizzle/meta/**'])).toMatchObject({ passed: true, changedLines: 701, ignoredLines: 3047 });
  });

  it('counts everything when the policy ignores nothing that changed, and uses the built-in defaults without a policy', () => {
    expect(subGatePolicy(diff, board, ['pnpm-lock.yaml'])).toMatchObject({ passed: false, changedLines: 3748, ignoredLines: 0 });
    expect(sizeIgnoredPathsOf(null)).toBe(DEFAULT_SIZE_IGNORED_PATHS);
    expect(sizeIgnoredPathsOf({})).toBe(DEFAULT_SIZE_IGNORED_PATHS);
    expect(sizeIgnoredPathsOf({ sizeIgnoredPaths: [] })).toBe(DEFAULT_SIZE_IGNORED_PATHS);
    expect(sizeIgnoredPathsOf({ sizeIgnoredPaths: ['gen/**'] })).toEqual(['gen/**']);
    expect(subGatePolicy(diff, board)).toMatchObject({ passed: true, changedLines: 701 });
    const locked = { changedLines: 5000, files: ['pnpm-lock.yaml', 'src/a.ts'], fileLines: { 'pnpm-lock.yaml': 4990, 'src/a.ts': 10 } };
    expect(subGatePolicy(locked, board)).toMatchObject({ passed: true, changedLines: 10, ignoredLines: 4990 });
  });

  it('still checks every file for sensitive paths', () => {
    const generatedSensitive = {
      changedLines: 3000,
      files: ['infra/generated/x.json', 'src/a.ts'],
      fileLines: { 'infra/generated/x.json': 2990, 'src/a.ts': 10 },
    };
    expect(subGatePolicy(generatedSensitive, board, ['infra/generated/**'])).toMatchObject({ passed: false, cause: 'sensitive', changedLines: 10 });
  });
});

describe('lists', () => {
  it('projects statuses onto the four lists', () => {
    expect(listOf('planning')).toBe('planning');
    expect(listOf('merging')).toBe('doing');
    expect(listOf('failed')).toBe('doing');
    expect(listOf('reviewing')).toBe('reviewing');
    expect(listOf('signed_off')).toBe('signed_off');
  });
});

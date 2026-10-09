import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/domain/events.js';
import type { GlobOutcome } from '../src/domain/intake-learning.js';
import {
  DEFAULT_SIZE_THRESHOLD,
  SIZE_PARTS_MAX,
  SIZE_PARTS_MIN,
  SIZE_TASKS_MAX,
  SIZE_TASKS_MIN,
  buildProposal,
  estimateFromText,
  loweredThreshold,
  nextThreshold,
  oversizedReasons,
  prHoursOf,
  prRangeOf,
  raisedThreshold,
  sizeOutcomeOf,
  splitAfterStartOf,
  withModelParts,
} from '../src/domain/size-check.js';
import type { SizeOutcomeInput } from '../src/domain/size-check.js';

const PLAN = `# Big thing

## Chat content
Some prose about the chat panel that has no task of its own.

## Tasks
1. Add the migration in apps/server/drizzle
2. Server endpoint in apps/server/src/http/app.ts
3. Web card in apps/web/src/components/card.tsx
4. CLI command
5. LLM prompt
6. Infra pipeline change
7. Core tests
Done when: it works.
`;

/** The shape of the deleted s15b31: context sections, an investigation list, and three real tasks. */
const S15B31 = `# Thing

## Evidence (2026-10-09)
It went wrong on the board.

## Investigate
1. Look at the counter
2. Look at the splitter
3. Look at the prompt
4. Look at the tests

## Fix
- Count real tasks only.

## Tasks
- [ ] T1: First. Done when: one.
- [ ] T2: Second. Done when: two.
- [ ] T3: Third. Done when: three.
`;

describe('estimate from plan text', () => {
  it('counts tasks, done-when lines, areas and untasked sections', () => {
    const e = estimateFromText(PLAN);
    expect(e.tasks).toBe(7);
    expect(e.doneWhenLines).toBe(1);
    expect(e.untaskedSections).toBe(1);
    expect(e.areas).toEqual(expect.arrayContaining(['migration', 'server', 'web', 'cli', 'llm', 'infra']));
    expect(e.partsSource).toBe('text');
    // 7 tasks at 3 a part; the untasked section is context, not a part.
    expect(e.independentParts).toBe(3);
  });

  it('counts only real tasks: an investigation list is not one', () => {
    const e = estimateFromText(S15B31);
    expect(e.tasks).toBe(3);
    expect(e.independentParts).toBe(1);
    expect(oversizedReasons(e, DEFAULT_SIZE_THRESHOLD)).toEqual([]);
  });

  it('counts plain list lines under a Tasks heading, and checkboxes anywhere', () => {
    expect(estimateFromText('## Tasks\n- one\n2. two\n  - nested\n\n## Steps\n1. not a task\n- [ ] a task\n').tasks).toBe(3);
  });

  it('is one part for a plan with a single task', () => {
    expect(estimateFromText('## Do\n- [ ] Fix the typo\n')).toMatchObject({ tasks: 1, untaskedSections: 0, independentParts: 1 });
  });

  it('takes the model count over the text count', () => {
    const e = withModelParts(estimateFromText(PLAN), 5, 'five separate pieces');
    expect(e).toMatchObject({ independentParts: 5, partsSource: 'model', reasoning: 'five separate pieces' });
  });
});

describe('flagging against the threshold', () => {
  const base = estimateFromText('## Do\n- [ ] one\n');
  it('flags more than 5 tasks or more than 3 parts by default', () => {
    expect(oversizedReasons({ ...base, tasks: 5, independentParts: 3 }, DEFAULT_SIZE_THRESHOLD)).toEqual([]);
    expect(oversizedReasons({ ...base, tasks: 6 }, DEFAULT_SIZE_THRESHOLD)).toHaveLength(1);
    expect(oversizedReasons({ ...base, independentParts: 4 }, DEFAULT_SIZE_THRESHOLD)).toHaveLength(1);
    expect(oversizedReasons({ ...base, tasks: 9, independentParts: 4 }, DEFAULT_SIZE_THRESHOLD)).toHaveLength(2);
  });
  it('follows a moved threshold', () => {
    expect(oversizedReasons({ ...base, tasks: 6 }, { maxTasks: 6, maxParts: 3 })).toEqual([]);
  });
});

describe('threshold steps and bounds', () => {
  it('raises and lowers both limits by one step', () => {
    expect(raisedThreshold({ maxTasks: 5, maxParts: 3 })).toEqual({ maxTasks: 6, maxParts: 4 });
    expect(loweredThreshold({ maxTasks: 5, maxParts: 3 })).toEqual({ maxTasks: 4, maxParts: 2 });
  });
  it('stops at each limit own bounds', () => {
    expect(raisedThreshold({ maxTasks: SIZE_TASKS_MAX, maxParts: SIZE_PARTS_MAX - 1 })).toEqual({ maxTasks: SIZE_TASKS_MAX, maxParts: SIZE_PARTS_MAX });
    expect(loweredThreshold({ maxTasks: SIZE_TASKS_MIN, maxParts: SIZE_PARTS_MIN + 1 })).toEqual({ maxTasks: SIZE_TASKS_MIN, maxParts: SIZE_PARTS_MIN });
    expect(raisedThreshold({ maxTasks: SIZE_TASKS_MAX, maxParts: SIZE_PARTS_MAX })).toEqual({ maxTasks: SIZE_TASKS_MAX, maxParts: SIZE_PARTS_MAX });
  });
  it('never moves a value set outside the bounds the wrong way', () => {
    expect(raisedThreshold({ maxTasks: 20, maxParts: 3 }).maxTasks).toBe(20);
    expect(loweredThreshold({ maxTasks: 1, maxParts: 3 }).maxTasks).toBe(1);
  });
  it('moves by outcome: raise, lower, or leave', () => {
    expect(nextThreshold('kept_whole_clean', DEFAULT_SIZE_THRESHOLD).maxTasks).toBe(6);
    expect(nextThreshold('unflagged_struggled', DEFAULT_SIZE_THRESHOLD).maxTasks).toBe(4);
    expect(nextThreshold('flag_confirmed', DEFAULT_SIZE_THRESHOLD)).toEqual(DEFAULT_SIZE_THRESHOLD);
  });
});

const outcome = (patch: { rounds?: number | null; maxRounds?: number | null; fixGlobs?: string[] } = {}): GlobOutcome => ({
  globId: 's1f1',
  snapshotVersion: 1,
  boardId: 1,
  mergedAt: '2026-09-01T00:00:00.000Z',
  recordedAt: '2026-09-20T00:00:00.000Z',
  final: true,
  corrections: { category: null, type: null, subConverted: null, split: false },
  size: { changedLines: null },
  review: { rounds: patch.rounds ?? 1, maxRounds: patch.maxRounds ?? 3, testFailRounds: 0, findingsBySeverity: {}, findingsByClass: {} },
  tests: { ciFailures: 0 },
  effort: { calendarHours: 10 },
  postMerge: { fixGlobs: patch.fixGlobs ?? [] },
});

const input = (patch: Partial<SizeOutcomeInput> & { rounds?: number | null; maxRounds?: number | null; fixGlobs?: string[] } = {}): SizeOutcomeInput => {
  const { rounds, maxRounds, fixGlobs, ...rest } = patch;
  return {
    globId: 's1f1',
    flagged: true,
    outcome: outcome({ ...(rounds === undefined ? {} : { rounds }), ...(maxRounds === undefined ? {} : { maxRounds }), ...(fixGlobs === undefined ? {} : { fixGlobs }) }),
    failedRuns: 0,
    prHours: 10,
    split: false,
    splitAfterStart: false,
    ...rest,
  };
};
const range = prRangeOf([8, 10, 10, 12, 10]);

describe('raise: a flagged glob kept whole merged cleanly', () => {
  it('raises when review rounds, runs, PR time and bugs are all fine', () => {
    expect(sizeOutcomeOf(input(), range)?.outcome).toBe('kept_whole_clean');
  });
  it.each([
    ['review rounds hit the tier max', { rounds: 3 }],
    ['a run failed', { failedRuns: 1 }],
    ['the PR stayed open over twice the median', { prHours: 25 }],
    ['a bug named it within 14 days', { fixGlobs: ['s1b2'] }],
  ])('does not raise when %s', (_name, patch) => {
    expect(sizeOutcomeOf(input(patch), range)?.outcome).toBe('flag_confirmed');
  });
  it('does not judge PR time before the board has enough merged PRs', () => {
    expect(sizeOutcomeOf(input({ prHours: 500 }), prRangeOf([10, 12]))?.outcome).toBe('kept_whole_clean');
  });
  it('a flagged glob that was split is a flag confirmed, never a raise', () => {
    expect(sizeOutcomeOf(input({ split: true }), range)?.outcome).toBe('flag_confirmed');
  });
});

describe('lower: an unflagged glob struggled', () => {
  const unflagged = (patch: Parameters<typeof input>[0] = {}) => input({ flagged: false, ...patch });
  it('says nothing when it merged fine', () => {
    expect(sizeOutcomeOf(unflagged(), range)).toBeNull();
    // A slow PR alone (over twice the median, under three times) is not a struggle.
    expect(sizeOutcomeOf(unflagged({ prHours: 25 }), range)).toBeNull();
  });
  it.each([
    ['max review rounds', { rounds: 3 }],
    ['a failed run', { failedRuns: 2 }],
    ['a very long PR', { prHours: 40 }],
    ['a split after it started', { splitAfterStart: true }],
  ])('lowers on %s', (_name, patch) => {
    expect(sizeOutcomeOf(unflagged(patch), range)?.outcome).toBe('unflagged_struggled');
  });
  it('a bug naming an unflagged glob is not a struggle on its own', () => {
    expect(sizeOutcomeOf(unflagged({ fixGlobs: ['s1b2'] }), range)).toBeNull();
  });
});

const ev = (type: DomainEvent['type'], at: string): DomainEvent => ({ type, globId: 's1f1', actor: null, at, data: {} });

describe('outcome inputs from events', () => {
  it('measures PR open time to the last merge', () => {
    expect(prHoursOf([ev('PROpened', '2026-09-01T00:00:00.000Z'), ev('Merged', '2026-09-01T06:00:00.000Z')])).toBe(6);
    expect(prHoursOf([ev('Merged', '2026-09-01T06:00:00.000Z')])).toBeNull();
  });
  it('a hand split after the glob started counts, one before does not', () => {
    expect(splitAfterStartOf([ev('RunTriggered', '2026-09-01T00:00:00.000Z'), ev('GlobSplit', '2026-09-02T00:00:00.000Z')])).toBe(true);
    expect(splitAfterStartOf([ev('GlobSplit', '2026-09-01T00:00:00.000Z'), ev('RunTriggered', '2026-09-02T00:00:00.000Z')])).toBe(false);
    expect(splitAfterStartOf([ev('GlobSplit', '2026-09-01T00:00:00.000Z')])).toBe(false);
  });
});

describe('proposal from the model parts', () => {
  const part = (title: string, plan: string, after: number[] = []) => ({ title, summary: `${title} summary`, plan, after });
  it('copies a context section into every part and orders parts that share files', () => {
    const proposal = buildProposal(PLAN, [
      part('Data', '## Tasks\n1. Add the migration in apps/server/drizzle/0001.sql'),
      part('Server', '## Tasks\n2. Endpoint in apps/server/drizzle/0001.sql'),
      part('Web', '## Tasks\n3. Card'),
    ]);
    expect(proposal?.parts.map((p) => p.title)).toEqual(['Data', 'Server', 'Web']);
    expect(proposal?.parts[1]?.after).toEqual([0]);
    expect(proposal?.parts[2]?.after).toEqual([]);
    for (const p of proposal?.parts ?? []) expect(p.plan).toContain('Some prose about the chat panel');
  });
  it('does not repeat a section a part already carries, and drops bad `after` indexes', () => {
    const proposal = buildProposal(PLAN, [part('A', '## Tasks\n1. a'), part('B', '## Chat content\nprose\n\n## Tasks\n2. b', [0, 1, 5, -1])]);
    expect(proposal?.parts).toHaveLength(2);
    expect(proposal?.parts[1]?.after).toEqual([0]);
    expect(proposal?.parts[1]?.plan.match(/Chat content/g)).toHaveLength(1);
  });
  it('never makes a part of a context section', () => {
    const proposal = buildProposal(S15B31, [
      part('T1 and T2', '## Tasks\n- [ ] T1: First.\n- [ ] T2: Second.'),
      part('T3', '## Tasks\n- [ ] T3: Third.'),
      part('Evidence (2026-10-09)', '## Evidence (2026-10-09)\n\nIt went wrong on the board.'),
    ]);
    expect(proposal?.parts.map((p) => p.title)).toEqual(['T1 and T2', 'T3']);
    for (const p of proposal?.parts ?? []) {
      expect(p.plan).toContain('It went wrong on the board.');
      expect(p.plan).toContain('Look at the splitter');
    }
  });
  it('is null when removing context-only parts leaves one part', () => {
    expect(buildProposal(S15B31, [part('Work', '## Tasks\n- [ ] T1: First.'), part('Evidence', '## Evidence (2026-10-09)\n\nx')])).toBeNull();
  });
  it('is null with fewer than two usable parts', () => {
    expect(buildProposal('## Do\n- [ ] one\n', [part('Only', '- [ ] x'), part('', 'y')])).toBeNull();
  });
});

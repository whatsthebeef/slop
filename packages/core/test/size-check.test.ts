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
  isChain,
  loweredThreshold,
  needsInvestigation,
  nextThreshold,
  oversizedReasons,
  parseWorkstream,
  prHoursOf,
  prRangeOf,
  proposalOfStored,
  raisedThreshold,
  sizeOutcomeOf,
  splitShape,
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
  const base = { ...estimateFromText('## Do\n- [ ] one\n'), parallelParts: 3 };
  it('flags more than 5 tasks or more than 3 parts by default, when parts could run at the same time', () => {
    expect(oversizedReasons({ ...base, tasks: 5, independentParts: 3 }, DEFAULT_SIZE_THRESHOLD)).toEqual([]);
    // One reason for the size, one for the parallelism.
    expect(oversizedReasons({ ...base, tasks: 6 }, DEFAULT_SIZE_THRESHOLD)).toHaveLength(2);
    expect(oversizedReasons({ ...base, independentParts: 4 }, DEFAULT_SIZE_THRESHOLD)).toHaveLength(2);
    expect(oversizedReasons({ ...base, tasks: 9, independentParts: 4 }, DEFAULT_SIZE_THRESHOLD)).toHaveLength(3);
  });
  it('never flags a serial plan, however many tasks it has', () => {
    const serial = { ...base, tasks: 10, independentParts: 6, parallelParts: 1 };
    expect(oversizedReasons(serial, DEFAULT_SIZE_THRESHOLD)).toEqual([]);
    expect(oversizedReasons({ ...serial, parallelParts: 2 }, DEFAULT_SIZE_THRESHOLD)).not.toEqual([]);
  });
  it('never flags on the text estimate, which cannot know the parallelism', () => {
    const text = estimateFromText(`${PLAN}\n8. one more\n9. and another`);
    expect(text.parallelParts ?? null).toBeNull();
    expect(oversizedReasons({ ...text, tasks: 12, independentParts: 6 }, DEFAULT_SIZE_THRESHOLD)).toEqual([]);
    expect(oversizedReasons({ ...text, tasks: 12, parallelParts: undefined }, DEFAULT_SIZE_THRESHOLD)).toEqual([]);
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
    // The old split outcomes are only read from history now: they move nothing.
    expect(nextThreshold('split_stalled', DEFAULT_SIZE_THRESHOLD)).toEqual(DEFAULT_SIZE_THRESHOLD);
    expect(nextThreshold('split_helped', DEFAULT_SIZE_THRESHOLD)).toEqual(DEFAULT_SIZE_THRESHOLD);
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
    ...rest,
  };
};
const range = prRangeOf([8, 10, 10, 12, 10]);

describe('raise: a flagged glob merged cleanly', () => {
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
});

describe('workstream shape', () => {
  it('is the longest chain and the widest level', () => {
    expect(splitShape([{ needs: [] }, { needs: [0] }, { needs: [0] }, { needs: [0] }])).toEqual({ criticalPath: 2, maxParallel: 3 });
    expect(splitShape([{ needs: [] }, { needs: [0] }, { needs: [1] }])).toEqual({ criticalPath: 3, maxParallel: 1 });
    expect(splitShape([{ needs: [] }, { needs: [] }])).toEqual({ criticalPath: 1, maxParallel: 2 });
  });
});

describe('workstream schema', () => {
  it('reads a valid workstream as it is', () => {
    const w = { name: 'A', goal: 'g', files: ['x.ts'], plan: 'p', needs: [0, 1] };
    expect(parseWorkstream(w, 2)).toEqual(w);
  });
  it('needs a name and a plan, and an object', () => {
    expect(parseWorkstream(null, 0)).toBeNull();
    expect(parseWorkstream('A', 0)).toBeNull();
    expect(parseWorkstream({ name: ' ', plan: 'p' }, 0)).toBeNull();
    expect(parseWorkstream({ name: 'A', plan: '' }, 0)).toBeNull();
    expect(parseWorkstream({ name: 'A' }, 0)).toBeNull();
  });
  it('defaults the goal from the plan, and files and needs to empty', () => {
    expect(parseWorkstream({ name: ' A ', plan: '# H\n\nWhat it does.' }, 0)).toEqual({ name: 'A', goal: 'What it does.', files: [], plan: '# H\n\nWhat it does.', needs: [] });
  });
  it('keeps only non-empty distinct file strings, and distinct needs of earlier workstreams, sorted', () => {
    const w = parseWorkstream({ name: 'A', plan: 'p', files: ['a.ts', ' a.ts ', '', 3, null, 'b.ts'], needs: [2, 0, 0, -1, 1.5, 3, 'x', 1] }, 3);
    expect(w?.files).toEqual(['a.ts', 'b.ts']);
    expect(w?.needs).toEqual([0, 1, 2]);
  });
  it('lets the first workstream need nothing', () => {
    expect(parseWorkstream({ name: 'A', plan: 'p', needs: [0] }, 0)?.needs).toEqual([]);
  });
});

describe('stored proposals', () => {
  it('reads an older check\'s parts as workstreams, and workstreams as they are', () => {
    const old = { parts: [{ title: 'Data', plan: '# Data\n\nThe table.\n- [ ] 1', after: [] }, { title: 'Web', plan: 'Cards', after: [0] }], criticalPath: 2, maxParallel: 1 };
    expect(proposalOfStored(old)).toEqual({
      workstreams: [
        { name: 'Data', goal: 'The table.', files: [], plan: '# Data\n\nThe table.\n- [ ] 1', needs: [] },
        { name: 'Web', goal: 'Cards', files: [], plan: 'Cards', needs: [0] },
      ],
      criticalPath: 2,
      maxParallel: 1,
    });
    const now = { workstreams: [{ name: 'A', goal: 'g', files: ['x.ts'], plan: 'p', needs: [] }] };
    expect(proposalOfStored(now)).toBe(now);
    expect(proposalOfStored(null)).toBeNull();
  });
});

describe('proposal from the model workstreams', () => {
  const part = (name: string, plan: string, needs: number[] = []) => ({ name, goal: `${name} goal`, files: [`${name}.ts`], plan, needs });
  it('copies a context section into every workstream, and makes workstreams that share files no need at all', () => {
    const proposal = buildProposal(PLAN, [
      part('Data', '## Tasks\n1. Add the migration in apps/server/drizzle/0001.sql'),
      part('Server', '## Tasks\n2. Endpoint in apps/server/drizzle/0001.sql'),
      part('Web', '## Tasks\n3. Card'),
    ]);
    expect(proposal?.workstreams.map((w) => w.name)).toEqual(['Data', 'Server', 'Web']);
    expect(proposal?.workstreams.map((w) => w.goal)).toEqual(['Data goal', 'Server goal', 'Web goal']);
    expect(proposal?.workstreams.map((w) => w.files)).toEqual([['Data.ts'], ['Server.ts'], ['Web.ts']]);
    expect(proposal?.workstreams[1]?.needs).toEqual([]);
    expect(proposal?.workstreams[2]?.needs).toEqual([]);
    for (const w of proposal?.workstreams ?? []) expect(w.plan).toContain('Some prose about the chat panel');
  });
  it('a shared contract first with three independent consumers: each consumer needs only the first', () => {
    const proposal = buildProposal(PLAN, [
      part('Contract', '## Tasks\n1. Add the shared schema type in packages/core/src/schema.ts'),
      part('Server', '## Tasks\n2. Endpoint in apps/server/src/http/app.ts', [0]),
      part('Web', '## Tasks\n3. Card in apps/web/src/components/card.tsx', [0]),
      part('CLI', '## Tasks\n4. CLI command\n5. LLM prompt\n6. Infra pipeline change\n7. Core tests', [0]),
    ]);
    expect(proposal?.workstreams.map((w) => w.needs)).toEqual([[], [0], [0], [0]]);
    expect(proposal).toMatchObject({ criticalPath: 2, maxParallel: 3 });
  });
  it('a chain has no parallel workstreams: its critical path is all of them', () => {
    const proposal = buildProposal(PLAN, [part('A', '## Tasks\n1. a'), part('B', '## Tasks\n2. b', [0]), part('C', '## Tasks\n3. c', [1])]);
    expect(proposal).toMatchObject({ criticalPath: 3, maxParallel: 1 });
    expect(proposal !== null && isChain(proposal)).toBe(true);
  });
  it('keeps direct needs only, and does not repeat a need reached through another', () => {
    const proposal = buildProposal(PLAN, [
      part('A', '## Tasks\n1. a in apps/server/src/a.ts'),
      part('B', '## Tasks\n2. b in apps/server/src/a.ts', [0]),
      part('C', '## Tasks\n3. c in apps/server/src/a.ts', [0, 1]),
    ]);
    expect(proposal?.workstreams.map((w) => w.needs)).toEqual([[], [0], [1]]);
    expect(proposal).toMatchObject({ criticalPath: 3, maxParallel: 1 });
  });
  it('does not repeat a section a workstream already carries, and drops bad `needs` indexes', () => {
    const proposal = buildProposal(PLAN, [part('A', '## Tasks\n1. a'), part('B', '## Chat content\nprose\n\n## Tasks\n2. b', [0, 1, 5, -1])]);
    expect(proposal?.workstreams).toHaveLength(2);
    expect(proposal?.workstreams[1]?.needs).toEqual([0]);
    expect(proposal?.workstreams[1]?.plan.match(/Chat content/g)).toHaveLength(1);
  });
  it('takes the goal from the plan when the model gave none', () => {
    const proposal = buildProposal(PLAN, [
      { name: 'A', goal: null, files: [], plan: '## Tasks\n1. a', needs: [] },
      { name: 'B', goal: null, files: [], plan: 'Make the card.\n\n## Tasks\n2. b', needs: [] },
    ]);
    expect(proposal?.workstreams.map((w) => w.goal)).toEqual(['', 'Make the card.']);
  });
  it('never makes a workstream of a context section', () => {
    const proposal = buildProposal(S15B31, [
      part('T1 and T2', '## Tasks\n- [ ] T1: First.\n- [ ] T2: Second.'),
      part('T3', '## Tasks\n- [ ] T3: Third.'),
      part('Evidence (2026-10-09)', '## Evidence (2026-10-09)\n\nIt went wrong on the board.'),
    ]);
    expect(proposal?.workstreams.map((w) => w.name)).toEqual(['T1 and T2', 'T3']);
    for (const w of proposal?.workstreams ?? []) {
      expect(w.plan).toContain('It went wrong on the board.');
      expect(w.plan).toContain('Look at the splitter');
    }
  });
  it('is null when removing context-only workstreams leaves one', () => {
    expect(buildProposal(S15B31, [part('Work', '## Tasks\n- [ ] T1: First.'), part('Evidence', '## Evidence (2026-10-09)\n\nx')])).toBeNull();
  });
  it('is null with fewer than two usable workstreams', () => {
    expect(buildProposal('## Do\n- [ ] one\n', [part('Only', '- [ ] x'), part('', 'y')])).toBeNull();
  });
});

describe('needsInvestigation', () => {
  const check = (flagged: boolean, tasks: number, partsSource: 'model' | 'text') => ({
    flagged,
    estimate: { ...estimateFromText('## Tasks\n- [ ] a\n'), tasks, partsSource },
  });

  it('investigates a flagged glob, and a plan of several tasks whose part count is only a text guess', () => {
    expect(needsInvestigation(check(true, 1, 'model'))).toBe(true);
    expect(needsInvestigation(check(false, 3, 'text'))).toBe(true);
  });

  it('leaves a model-judged small plan, a one-task plan and a glob with no check alone', () => {
    expect(needsInvestigation(check(false, 3, 'model'))).toBe(false);
    expect(needsInvestigation(check(false, 1, 'text'))).toBe(false);
    expect(needsInvestigation(null)).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { InvestigationService } from '../src/app/investigation-service.js';
import type { Result } from '../src/domain/errors.js';
import { blockProgress, defaultStepBlocks, humanSteps, isHumanStepDue, stateOf, storedBlockProgress } from '../src/domain/human-steps.js';
import type { StoredHumanStep } from '../src/domain/human-steps.js';
import { matchStoredTitles, parseRollout, plainTitle } from '../src/domain/rollout.js';
import { armOf, armsStored, rolloutWhen } from '../src/domain/rollout-stages.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-13T12:00:00.000Z';
const head = 'abc1234';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const record = (rollout: string): string => `# Implementation\n\nDid things.\n\n${rollout}\n\n## Checks\n\n- vitest passed\n`;

describe('parsing a downstream step', () => {
  it('adds a companion after the step, titled with the names and copying Why, Permissions, Run, script and Check', () => {
    const steps = parseRollout(`## Rollout
- script: Backfill the totals (downstream: int, staging, prod, blocks: sign_off, check: fileAttachments)
  - Why: old rows have no total
  - Permissions: a db admin session
  - Run: \`bash scripts/rollout/x-backfill.sh\`
  - Run: \`psql -c 'select 1'\`
  - Check: \`psql -c 'select 2'\` returns 2
  - script: scripts/rollout/x-backfill.sh
`);
    expect(steps.map((s) => [s.title, s.env, s.downstream])).toEqual([
      ['Backfill the totals', null, null],
      ['Run on int, staging, prod as each is released: Backfill the totals', null, ['int', 'staging', 'prod']],
    ]);
    const [own, companion] = steps;
    expect(own?.blocks).toEqual(['sign_off']);
    expect(own?.check).toBe('fileAttachments');
    expect(companion).toMatchObject({
      kind: 'script',
      why: 'old rows have no total',
      permissions: 'a db admin session',
      commands: ["psql -c 'select 1'"],
      verify: "psql -c 'select 2' returns 2",
      checkCommands: ["psql -c 'select 2'"],
      scriptPath: 'scripts/rollout/x-backfill.sh',
      blocks: null,
      check: null,
      once: false,
    });
  });

  it('copies a script step\'s fenced body', () => {
    const [, companion] = parseRollout('## Rollout\n- script: Reindex (downstream)\n  ```bash\n  ./reindex.sh\n  ```\n');
    expect(companion).toMatchObject({ title: 'Run on the rest of the pipeline as each is released: Reindex', script: './reindex.sh' });
  });

  it('a bare `downstream` names the rest of the pipeline; `downstream: false` is no flag; options combine with env and once', () => {
    expect(parseRollout('## Rollout\n- manual: Flip it (downstream)\n').map((s) => s.title)).toEqual(['Flip it', 'Run on the rest of the pipeline as each is released: Flip it']);
    expect(parseRollout('## Rollout\n- manual: Flip it (downstream: false)\n').map((s) => s.title)).toEqual(['Flip it']);
    const both = parseRollout('## Rollout\n- manual: Flip it (env: staging, downstream: prod)\n');
    expect(both.map((s) => [s.env, s.once, s.downstream])).toEqual([['staging', false, null], [null, false, ['prod']]]);
    expect(parseRollout('## Rollout\n- manual: Grant it (once, downstream)\n').map((s) => [s.once, s.downstream])).toEqual([[true, null], [false, []]]);
  });

  it('cuts a long companion title and keeps the rest in its detail, and numbers repeats', () => {
    const long = 'x'.repeat(100);
    const [, companion] = parseRollout(`## Rollout\n- manual: ${long} (downstream: int, staging, prod)\n`);
    expect(companion?.title.length).toBeLessThanOrEqual(120);
    expect(companion?.detail).toContain(long);
    expect(parseRollout('## Rollout\n- manual: A (downstream)\n- manual: A (downstream)\n').map((s) => s.title)).toEqual([
      'A',
      'Run on the rest of the pipeline as each is released: A',
      'A (2)',
      'Run on the rest of the pipeline as each is released: A (2)',
    ]);
  });

  it('keeps stored companion titles matching on a re-read: plainTitle leaves them as written', () => {
    const titles = parseRollout('## Rollout\n- manual: Flip it (downstream: prod)\n').map((s) => s.title);
    expect(titles.map(plainTitle)).toEqual(titles);
    expect(matchStoredTitles(titles, titles)).toEqual([0, 1]);
    expect(matchStoredTitles(titles, [...titles].reverse())).toEqual([1, 0]);
  });

  it('an unknown name in the option list still files the step, with a note', () => {
    const [step, companion] = parseRollout('## Rollout\n- manual: Flip it (downstream: a/b)\n');
    expect(step?.detail).toBe('downstream: a/b is not an environment name');
    expect(companion?.downstream).toEqual([]);
  });
});

describe('the downstream due', () => {
  const g = (patch: Partial<Glob> = {}): Glob => glob({ status: 'reviewing', runs: [], pr: { number: 1, state: 'merged', headSha: head }, labels: { CR: 'required' }, ...patch });
  const step = (patch: Partial<StoredHumanStep> = {}): StoredHumanStep => ({
    id: 'hs-down',
    boardId: 1,
    globId: 's1t1',
    kind: 'rollout',
    title: 'Run on prod as each is released: Flip it',
    detail: null,
    who: 'anyone',
    due: 'downstream',
    state: 'open',
    blocks: [],
    check: null,
    script: null,
    why: null,
    permissions: null,
    commands: [],
    verify: null,
    origin: 'rollout-section',
    createdBy: DEV,
    createdAt: NOW,
    doneBy: null,
    doneAt: null,
    dismissedReason: null,
    dueSince: null,
    ...patch,
  });

  it('is a known due that holds nothing back by default, and rolloutWhen gives it no blocks whatever the step says', () => {
    expect(isHumanStepDue('downstream')).toBe(true);
    expect(defaultStepBlocks('downstream')).toEqual([]);
    expect(rolloutWhen({ env: null, blocks: ['sign_off'], downstream: ['prod'] })).toEqual({ due: 'downstream', blocks: [] });
    expect(rolloutWhen({ env: null, blocks: null, downstream: null })).toEqual({ due: 'after_merge', blocks: ['sign_off', 'dependants'] });
  });

  it('is due once merged, pending before, and not while the glob is merging', () => {
    expect(stateOf(g(), step())).toBe('due');
    expect(stateOf(g({ status: 'signed_off' }), step())).toBe('due');
    expect(stateOf(g({ status: 'pr_open', pr: { number: 1, state: 'ready', headSha: head } }), step())).toBe('pending');
    expect(stateOf(g({ status: 'merging' }), step())).toBe('pending');
  });

  it('blocks nothing: not sign-off, dependants or reviewing', () => {
    for (const block of ['sign_off', 'dependants', 'reviewing'] as const) {
      expect(storedBlockProgress([step()], block)).toEqual({ open: 0, total: 0 });
      expect(blockProgress(humanSteps(g(), {}, [step()]), block).open).toBe(0);
    }
  });

  it('arms the system, with no stage, until it is ticked, including on a signed-off glob', () => {
    const signedOff = g({ status: 'signed_off' });
    expect(armOf(humanSteps(signedOff, {}, [step()]))).toEqual({ title: 'Run on prod as each is released: Flip it' });
    expect(armOf(humanSteps(signedOff, {}, [step({ state: 'done' })]))).toBeNull();
    expect(armsStored(step())).toBe(true);
    expect(armsStored(step({ state: 'done' }))).toBe(false);
  });

  it('arm prefers the step that runs now over the downstream one', () => {
    const now = step({ id: 'hs-main', title: 'Main', due: 'after_merge', blocks: ['sign_off', 'dependants'] });
    expect(armOf(humanSteps(g(), {}, [step(), now]))).toEqual({ title: 'Main' });
  });
});

describe('downstream steps in the services', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Ship it',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const update = async (id: string, patch: Partial<Glob>): Promise<Glob> =>
    store.transaction(async (tx) => {
      const current = (await tx.getGlob(id)) as Glob;
      const next = { ...current, ...patch, version: current.version + 1 };
      await tx.updateGlob(next, current.version);
      return next;
    });
  const newGlob = async (): Promise<Glob> => unwrap(await globs.create(DEV, input()));
  const mergeApproved = (id: string) => update(id, { status: 'reviewing', labels: { CR: 'approved' }, pr: { number: 1, state: 'merged', headSha: 'abc1234' } });
  const put = async (id: string, text: string) =>
    unwrap(await artifacts.putArtifact(DEV, id, 'implementation_plan', text, { commitSha: 'abc1234', runId: null, agentSetVersion: 3 }));
  const stepsOf = (id: string) => [...store.state.humanSteps.values()].filter((s) => s.globId === id);

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => NOW };
    runs = 0;
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const investigation = new InvestigationService({
      store,
      clock,
      notifier,
      escalate: (email, id, i) => globs.escalateToSame(email, id, i),
      predictRollout: (id) => globs.predictRollout(id),
    });
    artifacts = new ArtifactService({ store, clock, notifier, investigation, rollout: (email, id, text, source) => globs.reconcileRollout(email, id, text, source) });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [{ name: 'staging', allowBranchDeploy: true }] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('a flagged step in the record becomes the step itself plus a non-blocking downstream companion', async () => {
    const g = await newGlob();
    await put(g.id, record('## Rollout\n- manual: Flip it (downstream: int, prod)\n'));
    expect(stepsOf(g.id).map((s) => [s.title, s.due, s.blocks])).toEqual([
      ['Flip it', 'after_merge', ['sign_off', 'dependants']],
      ['Run on int, prod as each is released: Flip it', 'downstream', []],
    ]);
    await put(g.id, record('## Rollout\n- manual: Flip it (downstream: int, prod)\n'));
    expect(stepsOf(g.id)).toHaveLength(2);
  });

  it('a step for int, staging or prod (not a board environment) is the downstream step itself, title unchanged', async () => {
    const g = await newGlob();
    await put(g.id, record('## Rollout\n- manual: Flip it (env: prod, blocks: sign_off)\n- manual: Check it (env: staging)\n'));
    expect(stepsOf(g.id).map((s) => [s.title, s.due, s.blocks, s.detail])).toEqual([
      ['Flip it', 'downstream', [], null],
      ['Check it', 'after_deploy:staging', [], null],
    ]);
  });

  it('a stored step for an environment the board no longer lists is converted in place on a re-read, not duplicated', async () => {
    const g = await newGlob();
    await store.transaction((tx) =>
      tx.saveHumanSteps([
        {
          id: 'hs_old', boardId, globId: g.id, kind: 'rollout', title: 'Flip it', detail: null, who: 'anyone', due: 'after_deploy:prod', state: 'open', blocks: ['sign_off'], check: null, script: null,
          why: null, permissions: null, commands: [], verify: null, origin: 'rollout-section', createdBy: DEV, createdAt: NOW, doneBy: null, doneAt: null, dismissedReason: null, dueSince: null,
        },
      ]),
    );
    await put(g.id, record('## Rollout\n- manual: Flip it (env: prod, blocks: sign_off)\n'));
    expect(stepsOf(g.id).map((s) => [s.id, s.title, s.due, s.blocks, s.state])).toEqual([['hs_old', 'Flip it', 'downstream', [], 'open']]);
  });

  it('a downstream step does not hold sign-off: an approved merged glob signs off, and Arm system stays until the step is ticked', async () => {
    const g = await newGlob();
    await put(g.id, record('## Rollout\n- manual: Flip it (env: prod)\n'));
    await mergeApproved(g.id);
    await put(g.id, record('## Rollout\n- manual: Flip it (env: prod)\n- manual: Also this (env: int)\n'));
    expect((await globs.peek(g.id))?.status).toBe('signed_off');
    const view = unwrap(await globs.get(DEV, g.id));
    expect(view.arm).toEqual({ title: 'Flip it' });
    const [flip] = stepsOf(g.id);
    unwrap(await globs.completeHumanStep(DEV, g.id, flip?.id ?? '', null));
    const other = stepsOf(g.id).find((s) => s.title === 'Also this');
    unwrap(await globs.completeHumanStep(DEV, g.id, other?.id ?? '', null));
    expect(unwrap(await globs.get(DEV, g.id)).arm ?? null).toBeNull();
  });

  it('add_human_step: due downstream or downstream:true files the step after the merge with no blocks; blocks and a clashing due are refused', async () => {
    const g = await newGlob();
    const added = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Run it on the rest', downstream: true }));
    expect(added).toMatchObject({ due: 'downstream', blocks: [], dueSince: null });
    expect(unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Again', due: 'downstream' }))).toMatchObject({ due: 'downstream', blocks: [] });
    expect((await globs.addHumanStep(DEV, g.id, null, { title: 'Blocking', due: 'downstream', blocks: ['sign_off'] })).ok).toBe(false);
    expect((await globs.addHumanStep(DEV, g.id, null, { title: 'Clash', due: 'after_merge', downstream: true })).ok).toBe(false);
  });

  it('add_human_step and mark_environment_deployed take only the board\'s (dev) environments', async () => {
    const g = await newGlob();
    const refused = await globs.addHumanStep(DEV, g.id, null, { title: 'On prod', due: 'after_deploy:prod' });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toContain('Unknown environment prod');
    expect((await globs.addHumanStep(DEV, g.id, null, { title: 'On staging', due: 'after_deploy:staging' })).ok).toBe(true);
    const marked = await globs.markEnvironmentDeployed(DEV, g.id, 'prod');
    expect(marked.ok).toBe(false);
    expect(!marked.ok && marked.error.message).toContain("this board's environments are staging");
    expect(unwrap(await globs.markEnvironmentDeployed(DEV, g.id, 'staging'))).toEqual({ marked: 1 });
  });
});

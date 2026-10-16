import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { IntakeService } from '../src/app/intake-service.js';
import type { IntakeProposal } from '../src/app/intake-service.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent } from '../src/domain/events.js';
import { escalationOf } from '../src/domain/investigation.js';
import type { Investigation } from '../src/domain/investigation.js';
import { DEFAULT_RISK_PATHS, DEFAULT_ROLLOUT_PATHS, checkMergePolicy, parseMergePolicy, renderMergePolicy, riskPathsOf } from '../src/domain/merge-policy.js';
import { subGatePolicy, touchRiskPaths } from '../src/domain/sub-gate.js';
import { gateVerdictOf } from '../src/domain/sub-limit.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const DEV = 'dev@example.com';

describe('the riskPaths policy key', () => {
  it('is accepted, trimmed, deduplicated, and rendered after rolloutPaths', () => {
    const policy = unwrap(parseMergePolicy('{"riskPaths": [" .sstor/** ", ".sstor/**", ".claude/settings*.json"], "rolloutPaths": ["infra/**"]}'));
    expect(policy).toEqual({ rolloutPaths: ['infra/**'], riskPaths: ['.sstor/**', '.claude/settings*.json'] });
    const text = renderMergePolicy(policy);
    expect(text.indexOf('rolloutPaths')).toBeLessThan(text.indexOf('riskPaths'));
    expect(unwrap(parseMergePolicy(text))).toEqual(policy);
  });

  it('is validated like the other path lists', () => {
    for (const bad of [{ riskPaths: 'infra/**' }, { riskPaths: [1] }, { riskPaths: [''] }, { riskPaths: ['/etc/x'] }, { riskPaths: ['../x'] }, { riskPaths: ['a\nb'] }]) {
      const result = checkMergePolicy(bad);
      expect(result.ok ? null : result.error.code).toBe('invalid_input');
    }
    expect(checkMergePolicy({ riskPaths: Array.from({ length: 51 }, (_, i) => `p${String(i)}/**`) }).ok).toBe(false);
  });
});

describe('riskPathsOf', () => {
  it('is the defaults when there is no policy', () => {
    expect(riskPathsOf(null)).toEqual(DEFAULT_RISK_PATHS);
    expect(riskPathsOf({})).toEqual(DEFAULT_RISK_PATHS);
    expect(DEFAULT_RISK_PATHS).toEqual(['**/stacks/**', '**/*.properties', 'buildspec*.yml', 'infra/iam/**', 'scripts/rollout/**', '.github/workflows/**']);
  });

  it('adds the policy rolloutPaths and riskPaths to the defaults, without repeats', () => {
    const paths = riskPathsOf({ rolloutPaths: ['deploy/**', 'infra/iam/**'], riskPaths: ['.sstor/**', 'deploy/**'] });
    expect(paths).toEqual([...DEFAULT_RISK_PATHS, 'deploy/**', '.sstor/**']);
    // A policy without rolloutPaths does not pull in the rollout defaults.
    expect(riskPathsOf({})).not.toContain(DEFAULT_ROLLOUT_PATHS[0]);
  });
});

describe('touchRiskPaths: the six defaults', () => {
  it.each([
    ['services/app/stacks/app.yaml', true],
    ['stacks/x.yaml', true],
    ['services/app/stacks/app.dev.properties', true],
    ['deploy.properties', true],
    ['buildspec.yml', true],
    ['buildspec-deploy.yml', true],
    ['infra/iam/role.json', true],
    ['scripts/rollout/s1t2-do.sh', true],
    ['.github/workflows/checks.yml', true],
    ['src/a.ts', false],
    ['docs/stacks.md', false],
    ['services/buildspec.yml', false],
    ['infra/lib/stack.ts', false],
    ['scripts/build.sh', false],
  ])('%s -> %s', (file, hit) => {
    expect(touchRiskPaths([file], DEFAULT_RISK_PATHS)).toEqual(hit ? [file] : []);
  });

  it('lists each touching file once, in order, and skips empty globs', () => {
    expect(touchRiskPaths(['b/stacks/x', 'src/a.ts', 'a.properties', 'b/stacks/x'], DEFAULT_RISK_PATHS)).toEqual(['b/stacks/x', 'a.properties']);
    expect(touchRiskPaths(['src/a.ts'], [' '])).toEqual([]);
  });
});

describe('the sub gate and risk paths', () => {
  const board = { subMaxChangedLines: 100, sensitivePaths: ['secrets/**'] };

  it('flags a small diff that touches a risk path, with the cause and the files', () => {
    expect(subGatePolicy({ changedLines: 3, files: ['src/a.ts', 'svc/stacks/t.yaml'] }, board)).toEqual({
      passed: false,
      reason: 'Touches risk paths: svc/stacks/t.yaml',
      cause: 'risk_path',
      changedLines: 3,
      ignoredLines: 0,
    });
  });

  it('uses the paths it is given, and a board without a policy gets the defaults', () => {
    const diff = { changedLines: 3, files: ['.sstor/config.json'] };
    expect(subGatePolicy(diff, board)).toMatchObject({ passed: true });
    expect(subGatePolicy(diff, board, undefined, riskPathsOf({ riskPaths: ['.sstor/**'] }))).toMatchObject({ passed: false, cause: 'risk_path' });
  });

  it('keeps sensitive first and a risk path ahead of size, so the size limit never learns from it', () => {
    expect(subGatePolicy({ changedLines: 5, files: ['secrets/a', 'x/stacks/y'] }, board)).toMatchObject({ cause: 'sensitive' });
    expect(subGatePolicy({ changedLines: 500, files: ['x/stacks/y'] }, board)).toMatchObject({ cause: 'risk_path', changedLines: 500 });
  });

  it('is read back from the recorded event, and the learning does not take it for a size outcome', () => {
    const e: DomainEvent = {
      type: 'SubReviewCompleted',
      globId: 's1t1',
      actor: null,
      at: '2026-10-08T12:00:00.000Z',
      data: { sha: 'abc', passed: false, reason: 'Touches risk paths: a/stacks/b', cause: 'risk_path', changedLines: 500, limit: 100 },
    };
    expect(gateVerdictOf(e)).toMatchObject({ passed: false, cause: 'risk_path', changedLines: 500 });
  });
});

describe('escalationOf with risk paths', () => {
  const quiet: Investigation = {
    files: [{ path: 'apps/server/src/a.ts', change: 'modify' }],
    modules: ['server'],
    expectedLines: { min: 1, max: 5 },
    parts: [],
    riskTier: 'normal',
    riskAreas: [],
    needsHuman: { needed: false, reason: null },
    confidence: 'high',
    planHash: 'h',
    baseCommit: 'c',
  };

  it('leaves a quiet investigation alone', () => {
    expect(escalationOf(quiet)).toBeNull();
    expect(escalationOf(quiet, riskPathsOf(null))).toBeNull();
  });

  it('escalates files on a risk path with an explicit reason and criterion', () => {
    const found = escalationOf({ ...quiet, files: [...quiet.files, { path: 'svc/stacks/t.yaml', change: 'modify' }] }, riskPathsOf(null));
    expect(found).toMatchObject({ reason: 'Touches risk paths: svc/stacks/t.yaml', criterion: 'risk_path' });
  });

  it('escalates a predicted rollout, and keeps the other reasons after the rule', () => {
    const found = escalationOf({ ...quiet, needsRollout: true, needsHuman: { needed: true, reason: 'Open question' } });
    expect(found?.criterion).toBe('risk_path');
    expect(found?.reason).toBe('Needs rollout steps after the merge. Open question');
  });

  it('uses the board paths it is given', () => {
    const own = { ...quiet, files: [{ path: '.sstor/x.json', change: 'modify' as const }] };
    expect(escalationOf(own, riskPathsOf(null))).toBeNull();
    expect(escalationOf(own, riskPathsOf({ riskPaths: ['.sstor/**'] }))?.criterion).toBe('risk_path');
  });

  it('adds no criterion for a plain needsHuman, so it is judged by its words as before', () => {
    expect(escalationOf({ ...quiet, needsHuman: { needed: true, reason: 'Open question' } })).not.toHaveProperty('criterion');
  });
});

describe('the intake rule: risk paths and rollout steps are a same', () => {
  let store: MemoryStore;
  let answer: unknown;
  let intake: IntakeService;
  let boardId: number;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier: new RecordingNotifier() }).create(DEV, { name: 'b', repo: null, timeZone: 'UTC', environments: [] })).id;
    intake = new IntakeService({ store, llm: { complete: () => Promise.resolve(JSON.stringify(answer)) } });
  });

  const setPolicy = (content: string) =>
    store.transaction((tx) =>
      tx.saveKnowledge({ boardId, kind: 'merge_policy', name: 'merge-policy', area: null, audience: [], description: '', content, layer: 'file', version: 1, source: 'edit', updatedBy: DEV, updatedAt: '2026-10-08T12:00:00.000Z' }),
    );
  const propose = async (model: Record<string, unknown>, explicit: Record<string, unknown> = {}): Promise<IntakeProposal> => {
    answer = { title: 'T', plan: 'Do it. Done when: it is done.', type: 'sub', ...model };
    return unwrap(await intake.propose(DEV, boardId, { text: 'do the thing', explicit }));
  };

  it('makes a sub a same when its files touch a default risk path, and says why', async () => {
    const p = await propose({ files: ['src/a.ts', 'services/app/stacks/app.yaml'] });
    expect(p.type).toBe('same');
    expect(p.typeReason).toBe('Touches risk paths: services/app/stacks/app.yaml');
  });

  it('makes a sub a same when the plan has rollout steps', async () => {
    const p = await propose({ plan: 'Add the bucket.\n\n## Rollout\n\n- manual: Create the bucket in the console\n' });
    expect(p.type).toBe('same');
    expect(p.typeReason).toContain('rollout steps');
  });

  it('leaves a settled plan with a "None" rollout and quiet files a sub', async () => {
    const p = await propose({ plan: 'Fix it.\n\n## Rollout\n\nNone\n', files: ['src/a.ts'] });
    expect(p.type).toBe('sub');
  });

  it("keeps a person's explicit type, even sub on a risk path", async () => {
    const p = await propose({ files: ['svc/stacks/t.yaml'] }, { type: 'sub' });
    expect(p.type).toBe('sub');
    expect(p.typeReason).toBeNull();
  });

  it('leaves a super (a person is needed during the work) alone', async () => {
    const p = await propose({ type: 'super', files: ['svc/stacks/t.yaml'] });
    expect(p.type).toBe('super');
  });

  it("applies the board's own risk and rollout paths, and defaults with no policy", async () => {
    expect((await propose({ files: ['.sstor/x.json'] })).type).toBe('sub');
    await setPolicy('{"riskPaths": [".sstor/**"], "rolloutPaths": ["deploy/**"]}');
    expect((await propose({ files: ['.sstor/x.json'] })).type).toBe('same');
    expect((await propose({ files: ['deploy/run.sh'] })).type).toBe('same');
    expect((await propose({ files: ['x/stacks/y'] })).type).toBe('same');
  });

  it('lets an auto-trigger request stand for the same it made', async () => {
    answer = { title: 'T', plan: 'p', type: 'sub', files: ['x/stacks/y'], autoTrigger: true, autoTriggerQuote: 'implement it now' };
    const p = unwrap(await intake.propose(DEV, boardId, { text: 'Please implement it now', explicit: {} }));
    expect(p.type).toBe('same');
    expect(p.autoTrigger).toBe(true);
  });
});

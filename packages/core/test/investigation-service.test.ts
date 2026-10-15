import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { InvestigationService } from '../src/app/investigation-service.js';
import type { Result } from '../src/domain/errors.js';
import { oversizeOf, parseInvestigation, proposalFromParts } from '../src/domain/investigation.js';
import type { Investigation } from '../src/domain/investigation.js';
import { DEFAULT_SIZE_THRESHOLD } from '../src/domain/size-check.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const PLAN = '## Tasks\n- [ ] Fix the label on the card.\nDone when: the label is right.\n';

const BLOCK = {
  files: [{ path: 'apps/server/src/a.ts', change: 'modify' }],
  modules: ['server'],
  expectedLines: { min: 20, max: 80 },
  parts: [],
  riskTier: 'normal',
  riskAreas: [],
  needsHuman: { needed: false, reason: null },
  confidence: 'medium',
  planHash: 'abc123',
  baseCommit: 'def4567',
};
const THREE = [
  { name: 'core', files: ['packages/core/src/x.ts'], needs: [] },
  { name: 'server', files: ['apps/server/src/y.ts'], needs: ['core'] },
  { name: 'web', files: ['apps/web/src/z.tsx'], needs: [] },
];
const wrap = (value: unknown): string =>
  `# Investigation\n\n\`\`\`investigation\n${JSON.stringify(value)}\n\`\`\`\n`;
const read = (value: unknown): Investigation => {
  const parsed = parseInvestigation(wrap(value));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.investigation;
};

describe('acting on an investigation', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;

  const create = async (type: 'sub' | 'same'): Promise<Glob> =>
    unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'T',
        type,
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: type === 'same',
        idempotencyKey: null,
        plan: PLAN,
      }),
    );
  const submit = async (glob: Glob, value: unknown): Promise<void> => {
    const run = glob.runs.at(-1)?.id ?? null;
    unwrap(
      await artifacts.putArtifact(DEV, glob.id, 'investigation', wrap(value), {
        commitSha: null,
        runId: run,
        agentSetVersion: null,
      }),
    );
  };
  const get = async (id: string): Promise<Glob> => {
    const g = await globs.peek(id);
    if (g === null) throw new Error('missing');
    return g;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-11T12:00:00.000Z' };
    let runs = 0;
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const investigation = new InvestigationService({
      store,
      clock,
      notifier,
      escalate: (email, id, input) => globs.escalateToSame(email, id, input),
    });
    artifacts = new ArtifactService({ store, clock, notifier, investigation });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'demo',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('escalates a sub when the investigation needs a human, with the reason', async () => {
    const sub = await create('sub');
    expect(sub.type).toBe('sub');
    await submit(sub, {
      ...BLOCK,
      needsHuman: { needed: true, reason: 'The plan leaves the retention period open' },
    });
    const after = await get(sub.id);
    expect(after.type).toBe('same');
    expect(after.escalation?.reason).toContain('retention period');
  });

  it('escalates a sub that hits a risk area, and leaves a quiet one alone', async () => {
    const quiet = await create('sub');
    await submit(quiet, BLOCK);
    expect((await get(quiet.id)).type).toBe('sub');
    const risky = await create('sub');
    await submit(risky, { ...BLOCK, riskTier: 'high', riskAreas: ['auth'] });
    expect((await get(risky.id)).escalation?.reason).toContain('auth');
  });

  it('escalates a sub whose files touch a risk path, as a slop rule with criterion risk_path', async () => {
    const sub = await create('sub');
    await submit(sub, { ...BLOCK, files: [{ path: 'services/app/stacks/app.dev.properties', change: 'modify' }] });
    const after = await get(sub.id);
    expect(after.type).toBe('same');
    expect(after.escalation).toMatchObject({ criterion: 'risk_path', reason: 'Touches risk paths: services/app/stacks/app.dev.properties' });
  });

  it('escalates a sub that needs rollout, and reads the board policy for the paths', async () => {
    const rollout = await create('sub');
    await submit(rollout, { ...BLOCK, needsRollout: true });
    expect((await get(rollout.id)).escalation).toMatchObject({ criterion: 'risk_path', reason: 'Needs rollout steps after the merge' });
    await store.transaction((tx) =>
      tx.saveKnowledge({ boardId, kind: 'merge_policy', name: 'merge-policy', area: null, audience: [], description: '', content: '{"riskPaths": [".sstor/**"]}', layer: 'file', version: 1, source: 'edit', updatedBy: ADMIN, updatedAt: '2026-10-11T12:00:00.000Z' }),
    );
    const own = await create('sub');
    await submit(own, { ...BLOCK, files: [{ path: '.sstor/x.json', change: 'modify' }] });
    expect((await get(own.id)).escalation?.criterion).toBe('risk_path');
  });

  it('does not touch a same, and does not act on a block that fails validation', async () => {
    const same = await create('same');
    await submit(same, { ...BLOCK, needsHuman: { needed: true, reason: 'x' } });
    expect((await get(same.id)).escalation ?? null).toBeNull();
    const sub = await create('sub');
    await submit(sub, { ...BLOCK, needsHuman: { needed: true, reason: null } });
    expect((await get(sub.id)).type).toBe('sub');
  });

  it('raises the oversize flag with a proposal from three independent parts', async () => {
    const sub = await create('sub');
    await submit(sub, { ...BLOCK, parts: THREE });
    const check = await store.transaction((tx) => tx.getSizeCheck(sub.id));
    expect(check).toMatchObject({ flagged: true, decision: null });
    expect(check?.reasons[0]).toContain('3 independent parts');
    // Each part after the ones it needs: stable order, server after core; web is free.
    expect(check?.proposal?.workstreams.map((w) => w.name)).toEqual(['core', 'server', 'web']);
    expect(check?.proposal?.workstreams.map((w) => w.needs)).toEqual([[], [0], []]);
    expect(check?.proposal?.workstreams.map((w) => w.files)).toEqual([
      THREE[0]?.files,
      THREE[1]?.files,
      THREE[2]?.files,
    ]);
  });

  it('keeps a person’s answer to the flag, and ignores a single part', async () => {
    const one = await create('sub');
    await submit(one, { ...BLOCK, parts: [THREE[0]] });
    expect(await store.transaction((tx) => tx.getSizeCheck(one.id))).toSatisfy(
      (c: { flagged: boolean } | null) => c === null || !c.flagged,
    );
    const sub = await create('sub');
    await submit(sub, { ...BLOCK, parts: THREE });
    await store.transaction(async (tx) => {
      const check = await tx.getSizeCheck(sub.id);
      if (check !== null)
        await tx.upsertSizeCheck({
          ...check,
          decision: 'split',
          decidedBy: DEV,
          decidedAt: check.updatedAt,
        });
    });
    await submit(sub, {
      ...BLOCK,
      parts: [...THREE, { name: 'cli', files: ['apps/cli/x.ts'], needs: [] }],
    });
    expect((await store.transaction((tx) => tx.getSizeCheck(sub.id)))?.reasons[0]).toContain(
      '3 independent parts',
    );
  });
});

describe('oversizeOf and proposalFromParts', () => {
  it('flags at the board limit, not below it', () => {
    expect(
      oversizeOf(read({ ...BLOCK, parts: THREE.slice(0, 2) }), DEFAULT_SIZE_THRESHOLD, PLAN),
    ).toBeNull();
    expect(
      oversizeOf(read({ ...BLOCK, parts: THREE }), DEFAULT_SIZE_THRESHOLD, PLAN)?.proposal?.workstreams,
    ).toHaveLength(3);
  });

  it('names new-style parts by their title and gives each its own goal, files and plan', () => {
    const plan = `${PLAN}\n## Why\nThe cards are unreadable.\n`;
    const parts = [
      {
        name: 'core',
        title: 'Add the schema',
        summary: 'Schema first.',
        plan: '## Tasks\n- [ ] Schema.\nDone when: it parses.',
        files: ['a'],
        needs: [],
      },
      {
        name: 'web',
        title: 'Show it',
        summary: 'Show the parts.',
        plan: '## Tasks\n- [ ] UI.\nDone when: shown.',
        files: ['b'],
        needs: ['core'],
      },
    ];
    const built = proposalFromParts(read({ ...BLOCK, parts }).parts, plan)?.workstreams ?? [];
    expect(built.map((w) => w.name)).toEqual(['Add the schema', 'Show it']);
    expect(built.map((w) => w.files)).toEqual([['a'], ['b']]);
    expect(built[0]?.goal).toBe('Done when: it parses.');
    expect(built[0]?.plan).toContain('Schema.');
    expect(built[0]?.plan).not.toContain('UI.');
    expect(built[1]?.plan).toContain('## Why');
    expect(built[1]?.needs).toEqual([0]);
  });

  it('falls back to the name and the whole plan for old-style parts', () => {
    const built =
      oversizeOf(read({ ...BLOCK, parts: THREE }), DEFAULT_SIZE_THRESHOLD, PLAN)?.proposal
        ?.workstreams ?? [];
    expect(built[0]?.name).toBe('core');
    expect(built[0]?.goal).toBe('Scope: core');
    expect(built[0]?.plan).toContain('Fix the label on the card.');
  });

  it('cuts a long name to 120 characters', () => {
    const parts = THREE.map((p, i) => (i === 0 ? { ...p, title: 'x'.repeat(200) } : p));
    const built = proposalFromParts(read({ ...BLOCK, parts }).parts, PLAN)?.workstreams ?? [];
    expect(built[0]?.name).toHaveLength(120);
  });

  it('accepts parts with and without the new fields and rejects non-string ones', () => {
    expect(parseInvestigation(wrap({ ...BLOCK, parts: THREE })).ok).toBe(true);
    expect(parseInvestigation(wrap({ ...BLOCK, parts: [{ ...THREE[0], title: 3 }] })).ok).toBe(
      false,
    );
  });

  it('gives no proposal for parts that need each other in a circle', () => {
    const circle = [
      { name: 'a', files: ['a'], needs: ['b'] },
      { name: 'b', files: ['b'], needs: ['a'] },
    ];
    expect(proposalFromParts(read({ ...BLOCK, parts: circle }).parts, PLAN)).toBeNull();
  });
});

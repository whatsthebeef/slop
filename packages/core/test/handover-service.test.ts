import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob as fixture, run } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OTHER = 'other@example.com';
const NOW = '2026-10-08T12:00:00.000Z';
const HEAD = 'a2a88c8aaaa';

describe('hand-over brief in the services', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let runs: number;
  let seq: number;

  const insert = async (patch: Partial<Glob>): Promise<Glob> => {
    const id = `s${String(boardId)}t${String(++seq)}`;
    const made = fixture({ id, boardId, ...patch });
    await store.transaction((tx) => tx.insertGlob(made, null));
    return made;
  };
  const handovers = (id: string) =>
    store
      .transaction((tx) => tx.listArtifacts(id, 'attachment'))
      .then((all) => all.filter((a) => a.label === 'Handover'));
  const artifactHints = () => notifier.hints.filter((h) => h.kind === 'glob.artifacts');

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    runs = 0;
    seq = 0;
    const boards = new BoardService({ store, notifier });
    const clock = { now: () => NOW };
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${String(++runs)}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    artifacts = new ArtifactService({ store, notifier, clock });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OTHER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'demo',
        repo: null,
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardId, OTHER, 'dev'));
  });

  const failed = (decision?: string) =>
    insert({
      status: 'failed',
      implementer: null,
      failure: {
        reason: 'Needs a call',
        at: NOW,
        ...(decision === undefined ? {} : { kind: 'needs_pairing' as const, decision }),
      },
    });

  it('records the brief from the glob as it was before a pick-up cleared its failure', async () => {
    const made = await failed('Keep the old API?');
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    expect(picked.failure).toBeNull();
    const [handover] = await handovers(made.id);
    expect(handover?.content).toContain('Failed: Needs a call');
    expect(handover?.content).toContain('Decision needed: Keep the old API?');
    expect(handover).toMatchObject({
      kind: 'attachment',
      label: 'Handover',
      commitSha: 'aaa',
      version: 1,
    });
    expect(artifactHints()).toHaveLength(1);
  });

  it('records a take-over from the pre-transition glob, and a second hand-over is version 2', async () => {
    const made = await insert({
      status: 'pr_open',
      implementer: DEV,
      pr: { number: 7, state: 'ready', headSha: HEAD },
      runs: [
        run({
          state: 'watching',
          lastProgressAt: '2026-10-08T10:00:00.000Z',
          sessionUrl: 'https://claude.ai/code/session_1',
        }),
      ],
      headChecks: {
        sha: HEAD,
        state: 'failed',
        at: NOW,
        failure: { name: 'ci', step: 'test', lines: ['Error: boom'], url: 'https://ci.example/1' },
      },
    });
    const taken = unwrap(await globs.pickUp(OTHER, made.id, made.version, true));
    const first = await handovers(made.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ version: 1, commitSha: HEAD });
    expect(first[0]?.content).toContain('Error: boom');
    expect(first[0]?.content).toContain('The run has made no progress for 120 minutes.');
    expect(first[0]?.content).toContain('Session: https://claude.ai/code/session_1');

    // The glob is still failing for the next person: another hand-over is the next version.
    unwrap(await globs.pickUp(DEV, taken.id, taken.version, false));
    const second = await handovers(made.id);
    expect(second[0]).toMatchObject({ version: 2 });
  });

  it('writes nothing when the pick-up changes nothing', async () => {
    const made = await failed('Decide');
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    const before = (await handovers(made.id))[0]?.version;
    const hints = artifactHints().length;
    // The same person picking up again is a no-op, whatever the brief of the glob as it stands now.
    unwrap(await globs.pickUp(DEV, picked.id, picked.version, false));
    expect((await handovers(made.id))[0]?.version).toBe(before);
    expect(artifactHints()).toHaveLength(hints);
  });

  it('writes nothing when there is no brief', async () => {
    const made = await insert({ status: 'planning' });
    unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    expect(await handovers(made.id)).toEqual([]);
    expect(artifactHints()).toEqual([]);
  });

  it('records the brief on start anyway', async () => {
    const waited = await insert({
      status: 'in_progress',
      implementer: DEV,
      failure: { reason: 'Gave up', at: NOW },
      runs: [],
    });
    unwrap(await globs.startAnyway(DEV, waited.id, waited.version));
    expect((await handovers(waited.id))[0]?.content).toContain('Failed: Gave up');
  });

  it('get and context include the brief, null when nothing is wrong', async () => {
    const bad = await insert({
      status: 'in_progress',
      implementer: DEV,
      failure: { reason: 'Gave up', at: NOW },
    });
    const good = await insert({ status: 'in_progress', implementer: DEV });
    expect(unwrap(await globs.get(DEV, bad.id)).handover?.why).toEqual(['Failed: Gave up']);
    expect(unwrap(await globs.get(DEV, good.id)).handover).toBeNull();
    expect(unwrap(await artifacts.context(DEV, bad.id)).handover?.next).toMatch(
      /^Fix the cause, then continue from phase 1\./,
    );
    expect(unwrap(await artifacts.context(DEV, good.id)).handover).toBeNull();
  });

  it('counts the newest local review in-scope findings and the phase from the artifacts', async () => {
    const made = await insert({
      status: 'in_progress',
      implementer: DEV,
      pr: { number: 7, state: 'draft', headSha: HEAD },
    });
    unwrap(
      await artifacts.putArtifact(DEV, made.id, 'implementation_plan', '# Record', {
        commitSha: HEAD,
        runId: null,
        agentSetVersion: null,
      }),
    );
    unwrap(
      await artifacts.putArtifact(DEV, made.id, 'local_review', '# Review', {
        commitSha: HEAD,
        runId: null,
        agentSetVersion: null,
      }),
    );
    const [source] = await store.transaction((tx) => tx.listReviewSources(made.id));
    await store.transaction(async (tx) => {
      await tx.insertFindings(
        [
          {
            boardId,
            globId: made.id,
            sourceId: source?.id ?? 0,
            source: 'local_review',
            commitSha: HEAD,
            agentSetVersion: null,
            severity: 'in_scope',
            round: 1,
            path: 'a.ts',
            line: null,
            text: 'Fix a',
            resolved: false,
            fingerprint: 'fa',
          },
        ],
        NOW,
      );
      const [found] = await tx.listFindings(made.id);
      if (found !== undefined)
        await tx.updateFinding(
          { ...found, state: 'classified', class: 'other', version: found.version + 1 },
          found.version,
        );
    });
    const brief = unwrap(await globs.get(DEV, made.id)).handover;
    expect(brief).toMatchObject({
      why: ['1 in-scope review finding still open.'],
      next: 'Fix all review comments.',
    });
  });
});

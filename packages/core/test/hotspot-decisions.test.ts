import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { DecisionGlobService } from '../src/app/decision-glob-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { HotspotDecisions } from '../src/app/hotspot-decisions.js';
import { HotspotService } from '../src/app/hotspot-service.js';
import type { Llm } from '../src/app/intake-service.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import { hotspotOf, decisionOf } from '../src/domain/decision-glob.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent } from '../src/domain/events.js';
import type { Board, Glob } from '../src/domain/types.js';
import type { BranchFiles } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const HOT = 'apps/web/src/components/glob-dialog.tsx';
const NOW = '2026-10-13T12:00:00.000Z';
const day = (d: number): string => `2026-10-${String(d).padStart(2, '0')}T00:00:00.000Z`;
const DAY_MS = 24 * 60 * 60 * 1000;

class FakeBranchFiles implements BranchFiles {
  readonly files = new Map<string, readonly string[] | null>();
  filesOf(_board: Board, glob: Glob): Promise<readonly string[] | null> {
    return Promise.resolve(this.files.get(glob.id) ?? null);
  }
}

class FakeLlm implements Llm {
  prompts: string[] = [];
  fail = false;
  complete(request: { prompt: string }): Promise<string> {
    this.prompts.push(request.prompt);
    return this.fail ? Promise.reject(new Error('down')) : Promise.resolve('Split the dialog into one component per section.');
  }
}

describe('hotspot decisions', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let globs: GlobService;
  let decisions: DecisionGlobService;
  let hotspots: HotspotService;
  let llm: FakeLlm;
  let branches: FakeBranchFiles;
  let boardId: number;
  let now: string;
  const clock = { now: () => now };

  const flagged = (globId: string, when: string, files: string[], kind = 'additive'): DomainEvent[] => [
    { type: 'ConflictFlagged', globId, at: when, actor: null, data: { base: 'main', files, since: null } },
    { type: 'ConflictCleared', globId, at: when, actor: null, data: { base: 'main', files, since: null, by: 'run', kind } },
  ];
  const conflicts = async (globIds: string[], when: string): Promise<void> => {
    await store.transaction((tx) => tx.appendEvents(globIds.flatMap((id) => flagged(id, when, [HOT]))));
  };
  const work = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> =>
    unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'Work',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        ...patch,
      }),
    );
  const hotDecisions = async (): Promise<Glob[]> => (await store.transaction((tx) => tx.listGlobs(boardId, { include: 'decisions', origins: ['hotspot'] }))).sort((a, b) => a.id.localeCompare(b.id));
  const glob = async (id: string): Promise<Glob> => {
    const found = await store.transaction((tx) => tx.getGlob(id));
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const runJob = () => hotspots.run(boardId, now);
  const decide = async (id: string, input: Parameters<DecisionGlobService['decide']>[3]) => {
    const current = await glob(id);
    if (current.status === 'planning') unwrap(await globs.pickUp(ADMIN, id, current.version, false));
    return decisions.decide(ADMIN, id, (await glob(id)).version, input);
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = NOW;
    llm = new FakeLlm();
    branches = new FakeBranchFiles();
    const catalog = { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'h', files: [] }) };
    const knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'run-1' }, routines: { hasRoutine: () => Promise.resolve(true) }, branchFiles: branches });
    decisions = new DecisionGlobService({ store, clock, notifier, knowledge, globs });
    hotspots = new HotspotService({ store, clock, decisions: new HotspotDecisions({ store, clock, notifier, llm }) });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('raises one decision for a hot file, with the numbers and the drafted proposal', async () => {
    const [a, b, c] = [await work(), await work(), await work()];
    await conflicts([a.id, b.id, c.id], day(12));
    const result = await runJob();
    expect(result.raised).toHaveLength(1);
    const [decision] = await hotDecisions();
    expect(decision && hotspotOf(decision)).toBe(HOT);
    expect(decision?.title).toBe('glob-dialog.tsx is a conflict hotspot: 3 conflicts across 3 globs in 7 days');
    const plan = (await store.transaction((tx) => tx.listArtifacts(decision?.id ?? '', 'plan')))[0]?.content ?? '';
    expect(plan).toContain('Split the dialog into one component per section.');
    expect(llm.prompts).toHaveLength(1);
    expect(decision && decisionOf(decision)?.origin).toEqual({ kind: 'hotspot', path: HOT });
  });

  it('says how many conflicts were between workstreams of a glob, in the prompt and the decision, and says nothing otherwise', async () => {
    const [a, b] = [await work(), await work()];
    const recorded: DomainEvent = {
      type: 'WorkstreamsRecorded',
      globId: a.id,
      at: day(12),
      actor: null,
      data: { workstreams: [{ name: 'W1', conflicts: [HOT] }, { name: 'W2', conflicts: [HOT] }] },
    };
    await store.transaction((tx) => tx.appendEvents([recorded, ...flagged(b.id, day(12), [HOT])]));
    await runJob();
    const [decision] = await hotDecisions();
    const plan = (await store.transaction((tx) => tx.listArtifacts(decision?.id ?? '', 'plan')))[0]?.content ?? '';
    expect(plan).toContain('2 conflicts were between workstreams integrated within a glob.');
    expect(llm.prompts[0]).toContain('2 of them were integration conflicts between workstreams of the same glob.');
  });

  it('does not mention workstreams when none of the conflicts were between them', async () => {
    const [a, b, c] = [await work(), await work(), await work()];
    await conflicts([a.id, b.id, c.id], day(12));
    await runJob();
    expect(llm.prompts[0]).not.toContain('workstream');
  });

  it('falls back to a generic proposal when the model fails', async () => {
    llm.fail = true;
    const ids = [(await work()).id, (await work()).id, (await work()).id];
    await conflicts(ids, day(12));
    await runJob();
    const [decision] = await hotDecisions();
    const plan = (await store.transaction((tx) => tx.listArtifacts(decision?.id ?? '', 'plan')))[0]?.content ?? '';
    expect(plan).toContain('## Proposal');
  });

  it('does not raise a file that is not hot, nor a second decision while one is open', async () => {
    const ids = [(await work()).id, (await work()).id];
    await conflicts(ids, day(12));
    expect((await runJob()).raised).toBeUndefined();
    await conflicts([(await work()).id], day(12));
    await runJob();
    expect((await runJob()).raised).toBeUndefined();
    expect(await hotDecisions()).toHaveLength(1);
  });

  it('does not raise it again after a rejection inside the window, and does once the window has passed', async () => {
    const ids = [(await work()).id, (await work()).id, (await work()).id];
    await conflicts(ids, day(12));
    await runJob();
    const [decision] = await hotDecisions();
    unwrap(await decide(decision?.id ?? '', { outcome: 'reject', reason: 'Not now' }));
    now = new Date(Date.parse(now) + DAY_MS).toISOString();
    await conflicts(ids, now);
    expect((await runJob()).raised).toBeUndefined();
    expect(await hotDecisions()).toHaveLength(1);
    // Eight days on, the rejection has left the window and the file's new conflicts are the only ones in it.
    now = new Date(Date.parse(now) + 7 * DAY_MS).toISOString();
    await conflicts(ids, now);
    expect((await runJob()).raised).toHaveLength(1);
    expect(await hotDecisions()).toHaveLength(2);
  });

  it('accepting creates the refactor glob, waiting for the open globs changing the file, and records it', async () => {
    const touching = await work({ title: 'Touches the dialog' });
    const other = await work({ title: 'Elsewhere' });
    const third = await work();
    unwrap(await globs.pickUp(DEV, touching.id, touching.version, false));
    unwrap(await globs.pickUp(DEV, other.id, other.version, false));
    branches.files.set(touching.id, [HOT]);
    branches.files.set(other.id, ['README.md']);
    await conflicts([touching.id, other.id, third.id], day(12));
    await runJob();
    const [decision] = await hotDecisions();
    const accepted = unwrap(await decide(decision?.id ?? '', { outcome: 'accept' }));
    const linked = decisionOf(accepted)?.outcome?.linkedGlobId;
    expect(linked).toBeDefined();
    const refactor = await glob(linked ?? '');
    expect(refactor.title).toBe('Refactor glob-dialog.tsx so parallel work stops conflicting');
    expect([...store.state.relations.values()].filter((r) => r.from === refactor.id).map((r) => [r.to, r.gate, r.source])).toEqual([[touching.id, 'start', 'person']]);
    expect(refactor.category).toBe('task');
    // Repeating the accept's creation step makes no second glob.
    const again = unwrap(await globs.create(ADMIN, { boardId, title: 'x', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: `hotspot-refactor:${decision?.id ?? ''}`, plan: 'x' }));
    expect(again.id).toBe(refactor.id);
  });

  it('raises nothing while the accepted refactor is open', async () => {
    const ids = [(await work()).id, (await work()).id, (await work()).id];
    await conflicts(ids, day(12));
    await runJob();
    const [decision] = await hotDecisions();
    unwrap(await decide(decision?.id ?? '', { outcome: 'accept' }));
    now = new Date(Date.parse(now) + 30 * DAY_MS).toISOString();
    await conflicts(ids, now);
    expect((await runJob()).raised).toBeUndefined();
    expect(await hotDecisions()).toHaveLength(1);
  });

  it('holds a new glob that names the file in its tasks while the refactor is open', async () => {
    const ids = [(await work()).id, (await work()).id, (await work()).id];
    await conflicts(ids, day(12));
    await runJob();
    const [decision] = await hotDecisions();
    const accepted = unwrap(await decide(decision?.id ?? '', { outcome: 'accept' }));
    const refactorId = decisionOf(accepted)?.outcome?.linkedGlobId ?? '';
    const waiting = await work({ type: 'sub', plan: `## Tasks\n\n- Add a field to ${HOT}\n` });
    expect(waiting.impliedAfter?.map((h) => h.id)).toEqual([refactorId]);
    expect(waiting.impliedAfter?.[0]?.paths).toEqual([HOT]);
    const unrelated = await work({ type: 'sub', plan: '## Tasks\n\n- Fix the readme\n' });
    expect(unrelated.impliedAfter ?? []).toEqual([]);
    // Prose that merely mentions the file holds nothing.
    const prose = await work({ type: 'sub', plan: `## Why\n\n${HOT} is large.\n\n## Tasks\n\n- Fix the readme\n` });
    expect(prose.impliedAfter ?? []).toEqual([]);
  });

  it('releases the hold once the refactor has merged', async () => {
    const ids = [(await work()).id, (await work()).id, (await work()).id];
    await conflicts(ids, day(12));
    await runJob();
    const [decision] = await hotDecisions();
    const accepted = unwrap(await decide(decision?.id ?? '', { outcome: 'accept' }));
    const refactor = await glob(decisionOf(accepted)?.outcome?.linkedGlobId ?? '');
    await store.transaction((tx) => tx.updateGlob({ ...refactor, status: 'signed_off' }, refactor.version));
    const later = await work({ type: 'sub', plan: `## Tasks\n\n- Add a field to ${HOT}\n` });
    expect(later.impliedAfter ?? []).toEqual([]);
  });

  it('the refactor waits only for globs with a branch that changes the file, never for Planning ones', async () => {
    const planning = await work({ title: 'Still planning' });
    const doing = await work({ title: 'Doing' });
    unwrap(await globs.pickUp(DEV, doing.id, doing.version, false));
    branches.files.set(planning.id, [HOT]);
    branches.files.set(doing.id, [HOT]);
    expect(await globs.openGlobsTouching(boardId, HOT)).toEqual([doing.id]);
  });

  it('a hotspot decision is not a rule for later work', async () => {
    const ids = [(await work()).id, (await work()).id, (await work()).id];
    await conflicts(ids, day(12));
    await runJob();
    const [decision] = await hotDecisions();
    unwrap(await decide(decision?.id ?? '', { outcome: 'accept' }));
    const later = await work();
    const context = await store.transaction((tx) => tx.listArtifacts(later.id, 'attachment'));
    expect(context.map((a) => a.content).join('')).not.toContain('conflict hotspot');
  });
});

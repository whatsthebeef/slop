import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { IntakeService, LlmUnavailable, categoryFor, waitedForIn } from '../src/app/intake-service.js';
import { INTAKE_PROMPT_VERSION } from '../src/domain/intake-learning.js';
import type { Result } from '../src/domain/errors.js';
import { DEFAULT_RISK_AREAS } from '../src/domain/risk-area.js';
import { INTAKE_SYSTEM, boardContextBlock } from '../src/app/intake-service.js';
import type { LlmRequest } from '../src/app/intake-service.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const DEV = 'dev@example.com';

describe('intake', () => {
  let store: MemoryStore;
  let answer: string;
  let intake: IntakeService;
  let boardId: number;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    const globs = new GlobService({ store, notifier, clock: { now: () => '2026-10-05T12:00:00.000Z' }, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    unwrap(await globs.create(DEV, { boardId, title: 'x', type: 'same', category: 'task', group: 'Device Sync', environment: null, autoTrigger: false, idempotencyKey: null }));
    intake = new IntakeService({ store, llm: { complete: () => Promise.resolve(answer) } });
  });

  const propose = (text: string, explicit = {}) => intake.propose(DEV, boardId, { text, explicit }).then(unwrap);

  it('uses the model answer, matching an existing group', async () => {
    answer = '```json\n{"title":"Fix sync retry","plan":"Retries stop after a timeout. Done when: they resume.","type":"sub","category":"bug","group":"device-sync","autoTrigger":false,"autoTriggerQuote":null}\n```';
    expect(await propose('sync retries stop after a timeout')).toEqual({
      title: 'Fix sync retry',
      plan: 'Retries stop after a timeout. Done when: they resume.',
      type: 'sub',
      typeReason: null,
      category: 'bug',
      fix: true,
      fixSource: 'inferred',
      fixReason: null,
      workKind: 'maintenance',
      workKindSource: 'inferred',
      workKindReason: null,
      group: 'Device Sync',
      environment: null,
      autoTrigger: false,
      autoTriggerReason: null,
      files: [],
      suggestedAfter: [],
      categoryConfidence: null,
      categoryReason: null,
      examples: [],
      needsConfirmation: false,
      model: null,
      promptVersion: INTAKE_PROMPT_VERSION,
      oversized: [],
    });
  });

  describe('type: when a person is needed', () => {
    it('the prompt asks by when a person is needed, not by size', () => {
      expect(INTAKE_SYSTEM).toMatch(/WHEN A PERSON IS NEEDED/);
      expect(INTAKE_SYSTEM).toMatch(/"super": the plan still has decisions only a person can make/);
      expect(INTAKE_SYSTEM).toMatch(/"same": the plan is settled, but a person must review/);
      expect(INTAKE_SYSTEM).toMatch(/big settled work stays one glob/);
      expect(INTAKE_SYSTEM).toMatch(/A "super" is for unsettled work that needs a person to pair/);
      expect(INTAKE_SYSTEM).not.toMatch(/first output is the split|is split later/);
    });

    it('the board block keeps settled work beyond the sub size whole instead of splitting it', () => {
      const block = boardContextBlock([], 300);
      expect(block).toMatch(/stays one glob, sized for one review/);
      expect(block).not.toMatch(/split into parts/);
    });

    it('a settled small change is a sub, a risk-area change a same, open design questions a super, each with its reason', async () => {
      const cases = [
        { type: 'sub', reason: 'Settled plan, no open questions' },
        { type: 'same', reason: 'Touches auth, which a person reviews afterwards' },
        { type: 'super', reason: 'The plan leaves the storage design open' },
      ] as const;
      for (const c of cases) {
        answer = JSON.stringify({ title: 'T', summary: 'S', type: c.type, typeReason: c.reason, category: 'feature' });
        expect(await propose('some work')).toMatchObject({ type: c.type, typeReason: c.reason });
      }
    });

    it('an explicit type wins and carries no reason; a missing reason is null; a bug cannot be a super', async () => {
      answer = JSON.stringify({ title: 'T', summary: 'S', type: 'super', typeReason: 'Open design', category: 'feature' });
      expect(await propose('work', { type: 'same' })).toMatchObject({ type: 'same', typeReason: null });
      answer = JSON.stringify({ title: 'T', summary: 'S', type: 'sub' });
      expect((await propose('work')).typeReason).toBeNull();
      answer = JSON.stringify({ title: 'T', summary: 'S', type: 'super', typeReason: 'Open design', category: 'bug' });
      expect((await propose('work')).type).not.toBe('super');
    });
  });

  it('does not call a plan oversized by its text: only the model can say its parts run in parallel', async () => {
    const plan = '## Tasks\n' + Array.from({ length: 7 }, (_, i) => `${i + 1}. Step ${i + 1}`).join('\n');
    answer = JSON.stringify({ title: 'Big', summary: 's', plan, type: 'same', category: 'feature' });
    expect((await propose('a big piece of work')).oversized).toEqual([]);
  });

  it('keeps the model\'s file guesses that look like repo paths, and suggests globs the request waits for', async () => {
    answer = JSON.stringify({ title: 'T', summary: 'S', files: ['apps/server/drizzle/0023_x.sql', '/etc/passwd', '../x', 3, ' src/a.ts '] });
    const open = `s${String(boardId)}t1`;
    const p = await propose(`Add a column once ${open} is merged. Ignore s9t9 and mention ${open} again; also s${String(boardId)}t99 does not exist.`);
    expect(p.files).toEqual(['apps/server/drizzle/0023_x.sql', 'src/a.ts']);
    expect(p.suggestedAfter).toEqual([open]);
    // A mention without a waiting cue, or a glob that merged, is not suggested.
    expect((await propose(`This relates to ${open} but is separate`)).suggestedAfter).toEqual([]);
    expect(waitedForIn(`wait for ${open}`, new Set())).toEqual([]);
    expect(waitedForIn(`Start after ${open.toUpperCase()}.`, new Set([open]))).toEqual([open]);
    // A decision glob (k) is a glob too.
    expect(waitedForIn('Start once s1k3 is accepted.', new Set(['s1k3']))).toEqual(['s1k3']);
  });

  it('never suggests waiting on a decision glob: only work globs can be waited for', async () => {
    answer = JSON.stringify({ title: 'T', summary: 'S' });
    const decision = glob({ id: `s${String(boardId)}k3`, boardId, category: 'decision', status: 'planning', type: null });
    await store.transaction((tx) => tx.insertGlob(decision, null));
    expect((await propose(`Start once ${decision.id} is accepted, and after s${String(boardId)}t1.`)).suggestedAfter).toEqual([`s${String(boardId)}t1`]);
  });

  it('keeps the spec in plan', async () => {
    answer = '{"title":"T","plan":"The full spec.\\nDone when: it works.","type":"same","category":"task","group":null,"autoTrigger":false,"autoTriggerQuote":null}';
    const p = await propose('the whole request');
    expect(p.plan).toBe('The full spec.\nDone when: it works.');
    // No plan from the model: the request as written.
    answer = '{"title":"T"}';
    expect((await propose('the whole request')).plan).toBe('the whole request');
  });

  it('keeps a model answer of sub + feature, and repairs the matrix around explicit fields', async () => {
    answer = '{"title":"T","summary":"S","type":"sub","category":"feature","group":null,"autoTrigger":false,"autoTriggerQuote":null}';
    const p = await propose('add export', { type: 'sub' });
    // An old model answer of feature still reads as R&D, but the proposal's category is a task.
    expect([p.type, p.category, p.workKind]).toEqual(['sub', 'task', 'rnd']);
    const q = await propose('add export');
    expect([q.type, q.category, q.workKind]).toEqual(['sub', 'task', 'rnd']);
    answer = '{"title":"T","summary":"S","type":"super","category":"bug","group":null,"autoTrigger":false,"autoTriggerQuote":null}';
    const r = await propose('fix it');
    // An invalid combination is repaired optimistically: a bug can be a sub.
    expect([r.type, r.category]).toEqual(['sub', 'bug']);
    const s = await propose('fix it', { type: 'super' });
    expect([s.type, s.category]).toEqual(['super', 'task']);
  });

  it("suggests a branch-deploy environment the request names as a target; explicit fields win", async () => {
    await store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) throw new Error('no board');
      await tx.updateBoard(
        {
          ...board,
          environments: [
            { name: 'main', allowBranchDeploy: false },
            { name: 'Staging', allowBranchDeploy: true },
            { name: 'dev', allowBranchDeploy: true },
          ],
          version: board.version + 1,
        },
        board.version,
      );
    });
    answer = '{"title":"T","summary":"S","type":"super","category":"feature","group":null,"autoTrigger":false,"autoTriggerQuote":null}';
    expect((await propose('Pair on the export and deploy it to staging.')).environment).toBe('Staging');
    expect((await propose('Rework the developer settings')).environment).toBeNull();
    expect((await propose('Fix the main menu')).environment).toBeNull();
    // Named without a target cue ("to/on/in/into <env>"): not a suggestion.
    expect((await propose('Add a dev-only flag and a dev toggle')).environment).toBeNull();
    expect((await propose('Ship it into the dev environment')).environment).toBe('dev');
    expect((await propose('Try it on staging', { environment: 'dev' })).environment).toBe('dev');
  });

  it('auto-triggers a same only on an instruction actually in the request', async () => {
    answer = '{"title":"T","summary":"S","type":"same","category":"task","group":null,"autoTrigger":true,"autoTriggerQuote":"start it right away"}';
    expect((await propose('Rename the setting, please start it right away')).autoTrigger).toBe(true);
    expect((await propose('Rename the setting')).autoTrigger).toBe(false);
  });

  it('falls back to safe defaults when the model answer is unusable', async () => {
    answer = 'Sorry, I cannot help with that.';
    expect(await propose('Make the login page faster\nmore details')).toMatchObject({
      title: 'Make the login page faster',
      type: 'sub',
      category: 'task',
      autoTrigger: false,
    });
  });
  it('is optimistic: the prompt names the risk areas and the sub size, and never the overlap clause', async () => {
    const seen: LlmRequest[] = [];
    const inspecting = new IntakeService({
      store,
      llm: {
        complete: (request) => {
          seen.push(request);
          return Promise.resolve('{"title":"T","summary":"S","category":"task"}');
        },
      },
    });
    const p = unwrap(await inspecting.propose(DEV, boardId, { text: 'Tidy the settings page', explicit: {} }));
    const [request] = seen;
    const all = `${request?.system ?? ''}\n${request?.prompt ?? ''}`;
    for (const area of DEFAULT_RISK_AREAS) expect(all).toContain(area.name);
    expect(all).toContain('**/drizzle/**/*rewrite*');
    expect(all).toContain('about 2000 changed lines');
    expect(all).toMatch(/When unsure, choose "sub"/);
    expect(all).toMatch(/matched against/);
    expect(all).not.toMatch(/overlaps an open glob/);
    expect(INTAKE_SYSTEM).not.toMatch(/large or multi-area/);
    // No type in the answer: the optimistic default.
    expect(p.type).toBe('sub');
    // The call goes to the board's ledger as intake (no glob yet).
    expect(request?.spend).toEqual({ boardId, source: 'intake' });
  });

  it('shows the board\'s learned risk areas and sub size', async () => {
    await store.transaction(async (tx) => {
      await tx.putRiskArea({ boardId, name: 'Learned: apps/billing', pathPatterns: ['apps/billing/**'], why: 'A sub that changed it was reverted', source: 'learned', strength: 1, cleanCount: 0, updatedAt: '2026-10-05T12:00:00.000Z' });
      await tx.setSubLimit(boardId, 2000, 3500);
    });
    const seen: string[] = [];
    const inspecting = new IntakeService({ store, llm: { complete: (r) => { seen.push(r.prompt); return Promise.resolve('{}'); } } });
    unwrap(await inspecting.propose(DEV, boardId, { text: 'x', explicit: {} }));
    expect(seen[0]).toContain('apps/billing/**');
    expect(seen[0]).toContain('about 3500 changed lines');
  });

  it('answers llm_unavailable with the reason and fix when the model is unavailable', async () => {
    const down = new IntakeService({
      store,
      llm: { complete: () => Promise.reject(new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`')) },
    });
    expect(await down.propose(DEV, boardId, { text: 'add export', explicit: {} })).toEqual({
      ok: false,
      error: {
        code: 'llm_unavailable',
        message: 'AI unavailable: AWS sign-in expired. Run `aws sso login`',
        reason: 'AWS sign-in expired',
        fix: 'Run `aws sso login`',
      },
    });
  });

  it('still throws ordinary model failures', async () => {
    const failing = new IntakeService({ store, llm: { complete: () => Promise.reject(new Error('Too many requests')) } });
    await expect(failing.propose(DEV, boardId, { text: 'add export', explicit: {} })).rejects.toThrow('Too many requests');
  });

  describe('fix and work kind', () => {
    it('derives only task or bug as the category: R&D work is a task', () => {
      expect(categoryFor(false)).toBe('task');
      expect(categoryFor(true)).toBe('bug');
    });

    it('reads the new shape with a reason each', async () => {
      answer = '{"title":"T","plan":"p","type":"sub","fix":true,"fixReason":"Sync crashes","workKind":"maintenance","workKindReason":"A repair","confidence":"low"}';
      const p = await propose('sync crashes on retry');
      expect(p).toMatchObject({ fix: true, fixSource: 'inferred', fixReason: 'Sync crashes', workKind: 'maintenance', workKindReason: 'A repair', category: 'bug', categoryConfidence: 'low' });
      answer = '{"title":"T","plan":"p","type":"sub","fix":false,"workKind":"rnd"}';
      expect(await propose('add export')).toMatchObject({ fix: false, workKind: 'rnd', category: 'task' });
    });

    it('still reads the old category answer, with its reason and confidence', async () => {
      answer = '{"title":"T","plan":"p","type":"sub","category":"feature","categoryConfidence":"medium","categoryReason":"New capability"}';
      expect(await propose('x')).toMatchObject({ fix: false, workKind: 'rnd', fixReason: 'New capability', categoryConfidence: 'medium' });
      answer = '{"title":"T","plan":"p","type":"sub","category":"task"}';
      expect(await propose('x')).toMatchObject({ fix: false, workKind: 'maintenance', category: 'task' });
    });

    it('falls back to the words of the request when the model gives neither', async () => {
      answer = '{"title":"T"}';
      for (const word of ['fails', 'is broken', 'throws an error', 'a regression', 'crashes']) {
        const p = await propose(`The export ${word} for big boards`);
        expect(p).toMatchObject({ fix: true, workKind: 'maintenance', fixSource: 'inferred' });
        expect(p.fixReason).toMatch(/mentions/);
      }
      expect(await propose('Add a CSV export')).toMatchObject({ fix: false, workKind: 'rnd' });
      expect(await propose('Rename the settings page')).toMatchObject({ fix: false, workKind: 'maintenance' });
    });

    it('a person\'s fix, work kind or old category is a person\'s source and wins over the model', async () => {
      answer = '{"title":"T","plan":"p","type":"sub","fix":true,"workKind":"maintenance"}';
      expect(await propose('x', { fix: false, workKind: 'rnd' })).toMatchObject({ fix: false, fixSource: 'person', fixReason: null, workKind: 'rnd', workKindSource: 'person', category: 'task', needsConfirmation: false });
      expect(await propose('x', { category: 'bug' })).toMatchObject({ fix: true, fixSource: 'person', workKind: 'maintenance', workKindSource: 'person' });
      expect(await propose('x', { category: 'feature' })).toMatchObject({ fix: false, workKind: 'rnd', category: 'task' });
    });

    it('never makes an explicit super a fix', async () => {
      answer = '{"title":"T","plan":"p","type":"sub","fix":true,"workKind":"maintenance"}';
      expect(await propose('x', { type: 'super' })).toMatchObject({ type: 'super', fix: false, category: 'task' });
      expect(await propose('x', { type: 'super', fix: true })).toMatchObject({ type: 'sub', fix: true });
    });

    it('inferWork gives the model\'s answer, fills gaps and falls back when the model is down', async () => {
      answer = '{"fix":true,"fixReason":"It crashes","workKind":"maintenance","workKindReason":"A repair"}';
      expect(await intake.inferWork(boardId, { title: 'x', plan: 'y' })).toEqual({ fix: true, fixReason: 'It crashes', workKind: 'maintenance', workKindReason: 'A repair' });
      answer = 'not json';
      expect(await intake.inferWork(boardId, { title: 'Add export', plan: '' })).toMatchObject({ fix: false, workKind: 'rnd' });
      const down = new IntakeService({ store, llm: { complete: () => Promise.reject(new LlmUnavailable('down', 'later')) } });
      expect(await down.inferWork(boardId, { title: 'Login is broken', plan: '' })).toMatchObject({ fix: true, workKind: 'maintenance' });
    });
  });

  describe('re-inference on plan change', () => {
    const NOW = '2026-10-05T12:00:00.000Z';
    const make = async () => {
      const notifier = new RecordingNotifier();
      const globs = new GlobService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) } });
      const created = unwrap(await globs.create(DEV, { boardId, title: 'Export', type: 'same', category: 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
      return { globs, id: created.id, version: created.version };
    };
    const setPlan = (id: string, content: string) => store.transaction((tx) => tx.insertArtifact({ globId: id, kind: 'plan', label: '', content, link: null, commitSha: null, provenance: { by: 'human', actor: DEV, runId: null, agentSetVersion: null }, createdAt: NOW }));
    const read = async (id: string) => {
      const g = await store.transaction((tx) => tx.getGlob(id));
      if (g === null) throw new Error('missing');
      return g;
    };
    const infer = (g: GlobService, id: string) => g.reinferWork(id, (input) => intake.inferWork(boardId, input));

    it('updates an inferred fix and work kind and the reason, silently', async () => {
      const { globs, id } = await make();
      await setPlan(id, 'The export crashes on big boards.');
      answer = '{"fix":true,"fixReason":"It crashes","workKind":"maintenance","workKindReason":"A repair"}';
      await infer(globs, id);
      const g = await read(id);
      expect(g).toMatchObject({ fix: true, fixSource: 'inferred', workKind: 'maintenance', inferenceReason: 'It crashes A repair' });
    });

    it('never overwrites what a person set', async () => {
      const { globs, id, version } = await make();
      await setPlan(id, 'The export crashes.');
      unwrap(await globs.update(DEV, id, version, { workKind: 'rnd' }));
      answer = '{"fix":true,"fixReason":"It crashes","workKind":"maintenance","workKindReason":"A repair"}';
      await infer(globs, id);
      const g = await read(id);
      expect(g).toMatchObject({ workKind: 'rnd', workKindSource: 'person', fix: true, fixSource: 'inferred' });
      const fixed = unwrap(await globs.update(DEV, id, g.version, { fix: false }));
      expect(fixed).toMatchObject({ fix: false, fixSource: 'person' });
      await infer(globs, id);
      expect(await read(id)).toMatchObject({ fix: false, fixSource: 'person', workKind: 'rnd' });
    });
  });
});

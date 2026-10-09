import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { IntakeService, LlmUnavailable, waitedForIn } from '../src/app/intake-service.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

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
    unwrap(await globs.create(DEV, { boardId, title: 'x', summary: '', type: 'same', category: 'task', group: 'Device Sync', environment: null, autoTrigger: false, idempotencyKey: null }));
    intake = new IntakeService({ store, llm: { complete: () => Promise.resolve(answer) } });
  });

  const propose = (text: string, explicit = {}) => intake.propose(DEV, boardId, { text, explicit }).then(unwrap);

  it('uses the model answer, matching an existing group', async () => {
    answer = '```json\n{"title":"Fix sync retry","summary":"Retries stop.","plan":"Retries stop after a timeout. Done when: they resume.","type":"sub","category":"bug","group":"device-sync","autoTrigger":false,"autoTriggerQuote":null}\n```';
    expect(await propose('sync retries stop after a timeout')).toEqual({
      title: 'Fix sync retry',
      summary: 'Retries stop.',
      plan: 'Retries stop after a timeout. Done when: they resume.',
      type: 'sub',
      category: 'bug',
      group: 'Device Sync',
      environment: null,
      autoTrigger: false,
      autoTriggerReason: null,
      files: [],
      suggestedAfter: [],
    });
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
  });

  it('keeps the spec in plan, so the short summary never replaces it', async () => {
    answer = '{"title":"T","summary":"Short.","plan":"The full spec.\\nDone when: it works.","type":"same","category":"task","group":null,"autoTrigger":false,"autoTriggerQuote":null}';
    const p = await propose('the whole request');
    expect([p.summary, p.plan]).toEqual(['Short.', 'The full spec.\nDone when: it works.']);
    // An explicit summary wins for the card only; plan still comes from the request.
    const q = await propose('the whole request', { summary: 'Mine.' });
    expect([q.summary, q.plan]).toEqual(['Mine.', 'The full spec.\nDone when: it works.']);
    // No plan from the model: the request as written.
    answer = '{"title":"T","summary":"Short."}';
    expect((await propose('the whole request')).plan).toBe('the whole request');
  });

  it('lets explicit fields win and repairs the matrix around them', async () => {
    answer = '{"title":"T","summary":"S","type":"sub","category":"feature","group":null,"autoTrigger":false,"autoTriggerQuote":null}';
    const p = await propose('add export', { type: 'sub' });
    expect(p.type).toBe('sub');
    expect(p.category).toBe('task');
    const q = await propose('add export');
    expect([q.type, q.category]).toEqual(['same', 'feature']);
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
      type: 'same',
      category: 'task',
      autoTrigger: false,
    });
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
});

import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import type { AgentSet } from '../src/app/knowledge-service.js';
import { KnowledgePageService, KNOWLEDGE_PAGE_SPEND_SOURCE, KNOWLEDGE_PAGE_WAIT_REASON, parseDecisionGroups } from '../src/app/knowledge-page-service.js';
import { SpendService } from '../src/app/spend-service.js';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import { err, notFound, ok } from '../src/domain/errors.js';
import type { Result } from '../src/domain/errors.js';
import { knowledgePageEffect } from '../src/domain/events.js';
import { KNOWLEDGE_PAGE_INTERVAL_DEFAULT, KNOWLEDGE_PAGE_PROMPT_VERSION } from '../src/domain/knowledge-page.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob as globFixture } from './fixtures.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const START = '2026-10-05T12:00:00.000Z';
const MINUTE = 60_000;

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

class FakeLlm implements Llm {
  readonly calls: Pick<LlmRequest, 'system' | 'prompt' | 'spend'>[] = [];
  private readonly answers: (string | Error)[] = [];
  answer(...answers: (string | Error)[]): void {
    this.answers.push(...answers);
  }
  complete(request: LlmRequest): Promise<string> {
    this.calls.push({ system: request.system, prompt: request.prompt, spend: request.spend });
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

const IMPLEMENTER = '---\nname: implementer\ndescription: Implements plans\n---\n# Implementer\n';
const TESTER = '---\nname: tester\ndescription: Runs the tests\n---\n# Tester\n';

const groups = (...entries: { area: string; text: string; globIds: string[]; key?: boolean }[]) =>
  JSON.stringify({ groups: entries.map((e) => ({ area: e.area, entries: [{ text: e.text, rationale: 'Because', globIds: e.globIds, ...(e.key === undefined ? {} : { key: e.key }) }] })) });

describe('knowledge page', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let llm: FakeLlm;
  let page: KnowledgePageService;
  let boardId: number;
  let now: string;
  let set: AgentSet;
  let nextKb = 1;

  const advance = (ms: number) => {
    now = new Date(Date.parse(now) + ms).toISOString();
  };
  const versions = () => store.state.knowledgePages.filter((v) => v.boardId === boardId);
  const latest = () => {
    const found = versions().at(-1);
    if (found === undefined) throw new Error('no version');
    return found;
  };
  const jobs = () => store.state.outbox.filter((e) => e.kind === 'regenerate_knowledge_page');

  /** An accepted decision glob (in Reviewing), as the decision flow leaves it. */
  const accepted = async (patch: Partial<Glob> = {}, attributes: Partial<DecisionAttributes> = {}, statement?: string): Promise<Glob> => {
    const id = patch.id ?? `s1k${String(nextKb++)}`;
    const g = globFixture({
      id,
      boardId,
      category: 'decision',
      status: 'reviewing',
      title: `Decision ${id}`,
      pr: null,
      attributes: {
        scope: { kind: 'project', ref: null },
        origin: { kind: 'manual' },
        channel: 'human',
        outcome: { kind: 'accept', by: ADMIN, at: now, reason: `Reason of ${id}` },
        ...attributes,
      },
      ...patch,
    });
    await store.transaction(async (tx) => {
      await tx.insertGlob(g, null);
      // The statement is the first line of the decision's plan.md.
      await tx.insertArtifact({
        globId: id,
        kind: 'plan',
        label: '',
        content: `${statement ?? `Statement of ${id}`}\n\n## Source\n\nA meeting.\n`,
        link: null,
        commitSha: null,
        provenance: { by: 'human', actor: ADMIN, runId: null, agentSetVersion: null },
        createdAt: now,
      });
    });
    return g;
  };

  /** A decision glob that goes back to Doing: no longer in force. */
  const reopen = (id: string) =>
    store.transaction(async (tx) => {
      const g = await tx.getGlob(id);
      if (g === null) throw new Error(`No glob ${id}`);
      await tx.updateGlob({ ...g, status: 'in_progress' }, g.version);
    });

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    llm = new FakeLlm();
    now = START;
    nextKb = 1;
    set = { version: 1, files: [{ path: 'agents/implementer.md', content: IMPLEMENTER }], localRun: null, localRunProblem: null };
    const clock = { now: () => now };
    page = new KnowledgePageService({
      store,
      clock,
      notifier,
      llm,
      model: 'test-model',
      spend: new SpendService({ store, clock }),
      knowledge: { agentSetForDownload: (): Promise<Result<AgentSet>> => Promise.resolve(ok(set)) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    // The default is daily; most tests step by an hour.
    const created = unwrap(await boards.get(ADMIN, boardId)).board;
    expect(created.knowledgePageIntervalMinutes).toBe(KNOWLEDGE_PAGE_INTERVAL_DEFAULT);
    unwrap(await boards.updateSettings(ADMIN, boardId, created.version, { knowledgePageIntervalMinutes: 60 }));
    notifier.hints.length = 0;
  });

  it('writes the first version: agents from data, decisions from one model call over every decision in force', async () => {
    const a = await accepted({ id: 's1k1' });
    await accepted({ id: 's1k2' }, { target: { suggested: null, routed: { kind: 'agent', name: 'agents/implementer.md', section: null, newDocument: null } } });
    llm.answer(groups({ area: 'Testing', text: 'Run the suite', globIds: [a.id], key: true }));

    expect(await page.regenerate(boardId, false)).toBe('done');

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.prompt).toContain('Statement of s1k1');
    // The agent's own learning targets its file: it is in the agent set already, so the page leaves it out.
    expect(llm.calls[0]?.prompt).not.toContain('Statement of s1k2');
    const v = latest();
    expect(v).toMatchObject({ version: 1, reason: 'first', changed: { agents: true, decisions: true } });
    expect(v.sections).not.toHaveProperty('changes');
    expect(v.sections.agents).toMatchObject([
      { path: 'agents/implementer.md', kind: 'agent', name: 'implementer', description: 'Implements plans', changedInAgentSet: null, decisionGlobId: 's1k2' },
    ]);
    expect(v.sections.decisions).toEqual([{ area: 'Testing', entries: [{ text: 'Run the suite', rationale: 'Because', globIds: ['s1k1'], key: true, at: START }] }]);
    expect(Object.keys(v.basis.decisions)).toEqual(['s1k1']);
    expect(v.basis.promptVersion).toBe(KNOWLEDGE_PAGE_PROMPT_VERSION);
    expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });
    expect(store.state.llmSpend).toMatchObject([{ boardId, source: KNOWLEDGE_PAGE_SPEND_SOURCE, model: 'test-model', ref: '1' }]);
  });

  it('leaves its model call untagged and writes exactly one spend row of its own, so it is not counted twice (s15f60)', async () => {
    const a = await accepted({ id: 's1k1' });
    llm.answer(groups({ area: 'Testing', text: 'Run the suite', globIds: [a.id] }));

    expect(await page.regenerate(boardId, false)).toBe('done');

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.spend).toBeUndefined();
    expect(store.state.llmSpend).toHaveLength(1);
    expect(store.state.llmSpend[0]).toMatchObject({ boardId, source: KNOWLEDGE_PAGE_SPEND_SOURCE });
  });

  it('writes nothing and calls no model when nothing the page is built from changed', async () => {
    const a = await accepted();
    llm.answer(groups({ area: 'Testing', text: 'Run the suite', globIds: [a.id] }));
    await page.regenerate(boardId, false);
    advance(2 * 60 * MINUTE);

    expect(await page.regenerate(boardId, false)).toBe('done');
    expect(versions()).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('holds a regeneration inside the interval (no model call, nothing written) and runs it after', async () => {
    const a = await accepted();
    llm.answer(groups({ area: 'Testing', text: 'Run the suite', globIds: [a.id] }));
    await page.regenerate(boardId, false);

    const b = await accepted();
    advance(10 * MINUTE);
    expect(await page.regenerate(boardId, false)).toEqual({ state: 'pending', retryAfterMs: 50 * MINUTE, reason: KNOWLEDGE_PAGE_WAIT_REASON });
    advance(5 * MINUTE);
    expect(await page.regenerate(boardId, false)).toMatchObject({ state: 'pending', retryAfterMs: 45 * MINUTE });
    expect(versions()).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);

    advance(50 * MINUTE);
    llm.answer(groups({ area: 'Testing', text: 'Run the suite and more', globIds: [a.id, b.id] }));
    expect(await page.regenerate(boardId, false)).toBe('done');
    // Both triggers fell inside the interval and made one new version.
    expect(versions().map((v) => [v.version, v.reason])).toEqual([[1, 'first'], [2, 'delta']]);
  });

  it('uses the board setting for the interval', async () => {
    const boards = new BoardService({ store, notifier });
    const board = unwrap(await boards.get(ADMIN, boardId)).board;
    unwrap(await boards.updateSettings(ADMIN, boardId, board.version, { knowledgePageIntervalMinutes: 5 }));
    const a = await accepted();
    llm.answer(groups({ area: 'Testing', text: 'Run the suite', globIds: [a.id] }));
    await page.regenerate(boardId, false);
    advance(6 * MINUTE);
    await accepted();
    llm.answer(groups({ area: 'Testing', text: 'Two', globIds: ['s1k1', 's1k2'] }));
    expect(await page.regenerate(boardId, false)).toBe('done');
    expect(versions()).toHaveLength(2);
  });

  it('defaults a board to one regeneration a day', () => {
    expect(KNOWLEDGE_PAGE_INTERVAL_DEFAULT).toBe(1440);
  });

  it('rejects an interval outside 5 to 1440 minutes', async () => {
    const boards = new BoardService({ store, notifier });
    const board = unwrap(await boards.get(ADMIN, boardId)).board;
    for (const bad of [4, 1441, 1.5]) {
      const result = await boards.updateSettings(ADMIN, boardId, board.version, { knowledgePageIntervalMinutes: bad });
      expect(result.ok).toBe(false);
    }
  });

  it('accepting a decision that changes an agent: agents from data, one model call that sees the previous section and the change only', async () => {
    const a = await accepted({ id: 's1k1' }, {}, 'Alpha statement');
    const b = await accepted({ id: 's1k2' }, {}, 'Beta statement');
    llm.answer(groups({ area: 'Testing', text: 'Written alpha and beta', globIds: [a.id, b.id] }));
    await page.regenerate(boardId, false);
    expect(llm.calls).toHaveLength(1);

    advance(61 * MINUTE);
    const c = await accepted({ id: 's1k3' }, {}, 'Gamma statement');
    await accepted({ id: 's1k4' }, { target: { suggested: null, routed: { kind: 'agent', name: 'agents/implementer.md', section: null, newDocument: null } } }, 'Delta statement');
    set = { ...set, version: 2, files: [{ path: 'agents/implementer.md', content: `${IMPLEMENTER}\n## Board rules\n\n- Gamma.\n` }, { path: 'agents/tester.md', content: TESTER }] };
    llm.answer(groups({ area: 'Testing', text: 'Written alpha and beta', globIds: [a.id, b.id] }, { area: 'Agents', text: 'Gamma applies', globIds: [c.id] }));

    expect(await page.regenerate(boardId, false)).toBe('done');

    expect(llm.calls).toHaveLength(2);
    const prompt = llm.calls[1]?.prompt ?? '';
    // The previous section and the change; none of the unchanged decisions' own text.
    expect(prompt).toContain('Written alpha and beta');
    expect(prompt).toContain('Gamma statement');
    // The agent-targeted learning is not a page decision, but the agent still links to it.
    expect(prompt).not.toContain('Delta statement');
    expect(prompt).not.toContain('Alpha statement');
    expect(prompt).not.toContain('Beta statement');
    const v = latest();
    expect(v).toMatchObject({ version: 2, reason: 'delta', changed: { agents: true, decisions: true } });
    expect(v.sections.agents.map((x) => [x.path, x.changedInAgentSet, x.decisionGlobId])).toEqual([
      ['agents/implementer.md', 2, 's1k4'],
      ['agents/tester.md', 2, null],
    ]);
    expect(v.basis.agentSetBumps).toEqual([{ version: 2, at: now, changedPaths: ['agents/implementer.md', 'agents/tester.md'] }]);
    expect(v.sections.decisions.map((g) => g.area)).toEqual(['Testing', 'Agents']);
  });

  it('copies the decisions section and asks nothing when only the agents moved', async () => {
    const a = await accepted();
    llm.answer(groups({ area: 'Testing', text: 'Run the suite', globIds: [a.id] }));
    await page.regenerate(boardId, false);
    advance(61 * MINUTE);
    set = { ...set, version: 2, files: [{ path: 'agents/implementer.md', content: `${IMPLEMENTER}\nMore.\n` }] };

    expect(await page.regenerate(boardId, false)).toBe('done');

    expect(llm.calls).toHaveLength(1);
    expect(latest()).toMatchObject({ version: 2, reason: 'delta', changed: { agents: true, decisions: false } });
    expect(latest().sections.decisions).toEqual(versions()[0]?.sections.decisions);
    expect(store.state.llmSpend).toHaveLength(1);
  });

  it('drops an entry whose decisions all left force without asking, and asks when one of several left', async () => {
    const a = await accepted({ id: 's1k1' });
    const b = await accepted({ id: 's1k2' });
    const c = await accepted({ id: 's1k3' });
    llm.answer(
      JSON.stringify({
        groups: [
          { area: 'Testing', entries: [{ text: 'A alone', rationale: '', globIds: [a.id] }, { text: 'B and C', rationale: '', globIds: [b.id, c.id] }] },
        ],
      }),
    );
    await page.regenerate(boardId, false);

    advance(61 * MINUTE);
    await reopen(a.id);
    expect(await page.regenerate(boardId, false)).toBe('done');
    expect(llm.calls).toHaveLength(1);
    expect(latest().sections.decisions).toEqual([{ area: 'Testing', entries: [{ text: 'B and C', rationale: '', globIds: ['s1k2', 's1k3'], key: false, at: START }] }]);

    advance(61 * MINUTE);
    await reopen(b.id);
    llm.answer(groups({ area: 'Testing', text: 'C only', globIds: [c.id] }));
    await page.regenerate(boardId, false);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.prompt).toContain('No longer in force: s1k2');
    expect(latest().sections.decisions[0]?.entries[0]?.text).toBe('C only');
  });

  it('rebuilds every section on an admin\'s rebuild, inside the interval', async () => {
    const a = await accepted({ id: 's1k1' }, {}, 'Alpha statement');
    const b = await accepted({ id: 's1k2' }, {}, 'Beta statement');
    llm.answer(groups({ area: 'Testing', text: 'Both', globIds: [a.id, b.id] }));
    await page.regenerate(boardId, false);
    advance(MINUTE);

    llm.answer(groups({ area: 'Testing', text: 'Both again', globIds: [a.id, b.id] }));
    expect(await page.regenerate(boardId, true)).toBe('done');

    expect(latest()).toMatchObject({ version: 2, reason: 'rebuild', changed: { decisions: true } });
    // A rebuild shows the model every decision, not only what changed.
    expect(llm.calls[1]?.prompt).toContain('Alpha statement');
    expect(llm.calls[1]?.prompt).toContain('Beta statement');
    expect(llm.calls[1]?.prompt).toContain('There is no previous section');
  });

  it('rebuilds in full when the prompt version changed', async () => {
    const a = await accepted({}, {}, 'Alpha statement');
    llm.answer(groups({ area: 'Testing', text: 'One', globIds: [a.id] }));
    await page.regenerate(boardId, false);
    const old = latest();
    store.state.knowledgePages = [{ ...old, basis: { ...old.basis, promptVersion: KNOWLEDGE_PAGE_PROMPT_VERSION - 1 } }];
    advance(61 * MINUTE);

    llm.answer(groups({ area: 'Testing', text: 'One, reworded', globIds: [a.id] }));
    expect(await page.regenerate(boardId, false)).toBe('done');
    expect(latest()).toMatchObject({ version: 2, reason: 'prompt' });
    expect(llm.calls[1]?.prompt).toContain('Alpha statement');
  });

  it('leaves out learnings that target any file of the agent set, and keeps project decisions and document learnings', async () => {
    const target = (kind: 'agent' | 'command' | 'hook' | 'settings' | 'mcp' | 'claude_md' | 'doc', name: string) => ({
      target: { suggested: null, routed: { kind, name, section: null, newDocument: null } },
    });
    await accepted({ id: 's1k1' });
    await accepted({ id: 's1k2' }, { origin: { kind: 'inbox', id: 1 } });
    await accepted({ id: 's1k3' }, target('doc', 'docs/build.md'));
    for (const [n, kind] of (['agent', 'command', 'hook', 'settings', 'mcp', 'claude_md'] as const).entries()) {
      await accepted({ id: `s1k${String(10 + n)}` }, target(kind, `file-${kind}`));
    }
    llm.answer(groups({ area: 'Testing', text: 'Kept', globIds: ['s1k1', 's1k2', 's1k3'] }));
    await page.regenerate(boardId, false);
    expect(Object.keys(latest().basis.decisions).sort()).toEqual(['s1k1', 's1k2', 's1k3']);
    expect(llm.calls[0]?.prompt).not.toContain('"id":"s1k10"');
    expect(llm.calls[0]?.prompt).not.toContain('"id":"s1k15"');
  });

  it('reads key from the answer, treats a missing or non-boolean key as false, and stamps each entry with its newest decision time', async () => {
    const a = await accepted({ id: 's1k1' });
    advance(MINUTE);
    const b = await accepted({ id: 's1k2' });
    llm.answer(
      JSON.stringify({
        groups: [
          {
            area: 'Testing',
            entries: [
              { text: 'Key', rationale: '', globIds: [a.id, b.id], key: true },
              { text: 'No flag', rationale: '', globIds: [a.id] },
              { text: 'Odd flag', rationale: '', globIds: [b.id], key: 'yes' },
            ],
          },
        ],
      }),
    );
    await page.regenerate(boardId, false);
    expect(latest().sections.decisions[0]?.entries.map((e) => [e.text, e.key, e.at])).toEqual([
      ['Key', true, now],
      ['No flag', false, START],
      ['Odd flag', false, now],
    ]);
  });

  it('shows the model the previous entries with their key flag', async () => {
    const a = await accepted({ id: 's1k1' });
    llm.answer(groups({ area: 'Testing', text: 'Run it', globIds: [a.id], key: true }));
    await page.regenerate(boardId, false);
    advance(61 * MINUTE);
    const b = await accepted({ id: 's1k2' });
    llm.answer(groups({ area: 'Testing', text: 'Run it', globIds: [a.id], key: true }, { area: 'Other', text: 'More', globIds: [b.id], key: false }));
    await page.regenerate(boardId, false);
    expect(llm.calls[1]?.prompt).toContain('"text":"Run it","rationale":"Because","globIds":["s1k1"],"key":true');
    expect(llm.calls[1]?.system).toContain('"key"');
  });

  it('writes no recent changes, and keeps the history of agent-set versions in the basis', async () => {
    const a = await accepted();
    llm.answer(groups({ area: 'Testing', text: 'Run the suite', globIds: [a.id] }));
    await page.regenerate(boardId, false);
    expect(latest().sections).not.toHaveProperty('changes');
    expect(latest().changed).not.toHaveProperty('changes');
    expect(latest().basis).not.toHaveProperty('changesHash');
  });

  it('refuses an answer once, asks again with the validation error, and writes the corrected section', async () => {
    const a = await accepted();
    const b = await accepted();
    llm.answer(groups({ area: 'Testing', text: 'Only one', globIds: [a.id] }), groups({ area: 'Testing', text: 'Both', globIds: [a.id, b.id], key: true }));
    expect(await page.regenerate(boardId, false)).toBe('done');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]?.prompt).not.toContain('previous answer was refused');
    expect(llm.calls[1]?.prompt).toContain('Your previous answer was refused: The model left decisions out of the section: s1k2');
    expect(versions()).toHaveLength(1);
    expect(latest().sections.decisions[0]?.entries[0]?.text).toBe('Both');
    // Spend covers both calls, recorded once.
    expect(store.state.llmSpend).toHaveLength(1);
  });

  it('retries a reply that is not JSON', async () => {
    const a = await accepted();
    llm.answer('Sorry, here are some thoughts', groups({ area: 'Testing', text: 'Fine', globIds: [a.id] }));
    expect(await page.regenerate(boardId, false)).toBe('done');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.prompt).toContain('did not answer with a list of groups');
  });

  it('does not retry when the model itself is unavailable', async () => {
    await accepted();
    llm.answer(new LlmUnavailable('down', 'Fix it'));
    await page.regenerate(boardId, false);
    expect(llm.calls).toHaveLength(1);
  });

  it('leaves out a decision glob that a newer decision replaced', async () => {
    const row = await store.transaction((tx) =>
      tx.upsertDecision({
        boardId,
        itemId: 1,
        globId: null,
        group: null,
        statement: 'Old',
        quote: 'Old',
        decidedBy: null,
        decidedAt: START,
        sourceKind: 'inbox',
        sourceRef: 'inbox:1:x',
        sourceLabel: 'x',
        sourceUrl: null,
        createdAt: START,
      }),
    );
    const a = await accepted({ id: 's1k1' }, { origin: { kind: 'extracted', decisionId: row.id } });
    const b = await accepted({ id: 's1k2' });
    await store.transaction((tx) => tx.updateDecision(row.id, { replaceState: 'applied', replacedBy: row.id + 1 }));
    llm.answer(groups({ area: 'Testing', text: 'Only B', globIds: [b.id] }));
    await page.regenerate(boardId, false);
    expect(Object.keys(latest().basis.decisions)).toEqual([b.id]);
    expect(llm.calls[0]?.prompt).not.toContain(`"id":"${a.id}"`);
  });

  it('waits without spending an attempt when the model is unavailable, writing nothing', async () => {
    await accepted();
    llm.answer(new LlmUnavailable('AWS sign-in expired', 'Sign in again'));
    const outcome = await page.regenerate(boardId, false);
    expect(outcome).toMatchObject({ state: 'pending', retryAfterMs: 60_000, reason: 'AI unavailable: AWS sign-in expired' });
    expect(versions()).toEqual([]);
  });

  it('throws when the second answer also leaves a decision out, so the job is retried and the previous version stays', async () => {
    const a = await accepted();
    const b = await accepted();
    llm.answer(groups({ area: 'Testing', text: 'Both', globIds: [a.id, b.id] }));
    await page.regenerate(boardId, false);
    advance(61 * MINUTE);
    await accepted();
    const bad = groups({ area: 'Testing', text: 'Only one', globIds: [a.id] });
    llm.answer(bad, bad);
    await expect(page.regenerate(boardId, false)).rejects.toThrow(/left decisions out/);
    expect(llm.calls).toHaveLength(3);
    expect(versions()).toHaveLength(1);
    expect(store.state.llmSpend).toHaveLength(1);
  });

  it('writes a first version without a model call when there are no decisions', async () => {
    expect(await page.regenerate(boardId, false)).toBe('done');
    expect(llm.calls).toEqual([]);
    expect(latest()).toMatchObject({ version: 1, reason: 'first', sections: { decisions: [] } });
  });

  it('drops the job for a board that is gone', async () => {
    expect(await page.regenerate(999, false)).toBe('dropped');
  });

  describe('the guide and the verdicts (s15f63)', () => {
    const verdict = (globIds: string[], v: 'pin' | 'hide' | null, who = ADMIN) => page.setVerdict(who, boardId, globIds, v);
    const firstPage = async () => {
      const a = await accepted({ id: 's1k1', title: 'Alpha title' });
      const b = await accepted({ id: 's1k2', title: 'Beta title' });
      llm.answer(
        JSON.stringify({
          groups: [
            {
              area: 'Testing',
              entries: [
                { text: 'Alpha', rationale: '', globIds: [a.id], key: true },
                { text: 'Beta', rationale: '', globIds: [b.id], key: false },
              ],
            },
          ],
        }),
      );
      await page.regenerate(boardId, false);
      advance(61 * MINUTE);
      return { a, b };
    };
    const entry = (text: string) => latest().sections.decisions.flatMap((g) => g.entries).find((e) => e.text === text);

    it('seeds the guide on first use, puts it in the prompt and writes its version into the basis', async () => {
      const a = await accepted();
      llm.answer(groups({ area: 'Testing', text: 'One', globIds: [a.id] }));
      await page.regenerate(boardId, false);

      const doc = await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', 'knowledge-page-guide'));
      expect(doc).toMatchObject({ version: 1, area: 'knowledge-page', audience: [] });
      expect(doc?.description).toContain('what the knowledge page shows as key decisions');
      expect(llm.calls[0]?.prompt).toContain("The board's rules for what is key:");
      expect(llm.calls[0]?.prompt).toContain('not obvious from the code');
      expect(latest().basis.guideVersion).toBe(1);
    });

    it('rebuilds with the new text when the guide changes, and not before', async () => {
      const { a } = await firstPage();
      expect(await page.regenerate(boardId, false)).toBe('done');
      expect(versions()).toHaveLength(1);

      await store.transaction(async (tx) => {
        const doc = await tx.getKnowledge(boardId, 'doc', 'knowledge-page-guide');
        if (doc === null) throw new Error('no guide');
        await tx.saveKnowledge({ ...doc, content: 'Only product behaviour is key.', version: doc.version + 1 });
      });
      llm.answer(groups({ area: 'Testing', text: 'Alpha again', globIds: [a.id, 's1k2'], key: false }));
      expect(await page.regenerate(boardId, false)).toBe('done');

      expect(latest()).toMatchObject({ version: 2, reason: 'guide', basis: { guideVersion: 2 } });
      expect(llm.calls[1]?.prompt).toContain('Only product behaviour is key.');
      expect(llm.calls[1]?.prompt).toContain('There is no previous section');
    });

    it('lets a verdict win over the model, with no model call, and gives the model\'s word back when it is undone', async () => {
      const { a, b } = await firstPage();
      unwrap(await verdict([a.id], 'hide'));
      unwrap(await verdict([b.id], 'pin'));

      expect(await page.regenerate(boardId, false)).toBe('done');
      expect(llm.calls).toHaveLength(1);
      expect(latest()).toMatchObject({ version: 2, reason: 'delta', changed: { decisions: true } });
      expect(entry('Alpha')).toMatchObject({ key: false, modelKey: true });
      expect(entry('Beta')).toMatchObject({ key: true, modelKey: false });
      expect(latest().basis.feedback).toEqual({ s1k1: 'hide', s1k2: 'pin' });

      advance(61 * MINUTE);
      unwrap(await verdict([a.id, b.id], null));
      expect(await page.regenerate(boardId, false)).toBe('done');
      expect(llm.calls).toHaveLength(1);
      expect(entry('Alpha')).toMatchObject({ key: true });
      expect(entry('Alpha')).not.toHaveProperty('modelKey');
      expect(entry('Beta')).toMatchObject({ key: false });
    });

    it('keeps a verdict over a later model answer for the same decision', async () => {
      const { a } = await firstPage();
      unwrap(await verdict([a.id], 'hide'));
      const c = await accepted({ id: 's1k3', title: 'Gamma title' });
      llm.answer(
        JSON.stringify({
          groups: [{ area: 'Testing', entries: [{ text: 'Alpha', rationale: '', globIds: [a.id, 's1k2'], key: true }, { text: 'Gamma', rationale: '', globIds: [c.id], key: true }] }],
        }),
      );
      await page.regenerate(boardId, false);
      expect(entry('Alpha')).toMatchObject({ key: false });
      expect(entry('Gamma')).toMatchObject({ key: true });
    });

    it('shows the model the newest 20 verdicts as examples, each with its decision title', async () => {
      const ids: string[] = [];
      for (let i = 1; i <= 22; i++) ids.push((await accepted({ id: `s1k${String(i)}`, title: `Title ${String(i)}` })).id);
      llm.answer(groups({ area: 'Testing', text: 'All', globIds: ids }));
      await page.regenerate(boardId, false);
      advance(61 * MINUTE);
      for (const [n, id] of ids.entries()) {
        unwrap(await verdict([id], n % 2 === 0 ? 'pin' : 'hide'));
        advance(MINUTE);
      }
      const extra = await accepted({ id: 's1k99', title: 'Fresh title' });
      llm.answer(groups({ area: 'Testing', text: 'All', globIds: [...ids, extra.id] }));
      await page.regenerate(boardId, false);

      const prompt = llm.calls[1]?.prompt ?? '';
      expect(prompt).toContain('- not key: Title 22');
      expect(prompt).toContain('- pinned: Title 21');
      expect(prompt).toContain('- not key: Title 4');
      expect(prompt).not.toContain('Title 2\n');
      expect(prompt).not.toContain('- pinned: Title 1\n');
      expect(prompt.split('\n').filter((l) => /^- (pinned|not key): /.test(l))).toHaveLength(20);
    });

    it('shows the model its own earlier key flag, not a verdict\'s', async () => {
      const { a, b } = await firstPage();
      unwrap(await verdict([a.id], 'hide'));
      await page.regenerate(boardId, false);
      advance(61 * MINUTE);
      await accepted({ id: 's1k3' });
      llm.answer(
        JSON.stringify({ groups: [{ area: 'Testing', entries: [{ text: 'Alpha', rationale: '', globIds: [a.id], key: true }, { text: 'Beta', rationale: '', globIds: [b.id], key: false }, { text: 'New', rationale: '', globIds: ['s1k3'], key: false }] }] }),
      );
      await page.regenerate(boardId, false);
      expect(llm.calls[1]?.prompt).toContain('"text":"Alpha","rationale":"","globIds":["s1k1"],"key":true');
    });

    it('lets admins and POs give verdicts, others not, and only on decisions of the board', async () => {
      const { a } = await firstPage();
      const boards = new BoardService({ store, notifier });
      await store.transaction((tx) => tx.upsertUser({ email: 'po@example.com', name: 'po', active: true }));
      unwrap(await boards.setMember(ADMIN, boardId, 'po@example.com', 'po'));

      expect((await verdict([a.id], 'pin', DEV)).ok).toBe(false);
      expect((await verdict([a.id], 'pin', 'po@example.com')).ok).toBe(true);
      expect((await verdict(['s1k404'], 'pin')).ok).toBe(false);
      expect((await verdict([], 'pin')).ok).toBe(false);
      const view = unwrap(await page.view(DEV, boardId));
      expect(view.feedback).toMatchObject([{ globId: a.id, verdict: 'pin', by: 'po@example.com' }]);
      expect(jobs().length).toBeGreaterThan(0);
    });
  });

  describe('reading and rebuilding', () => {
    it('serves the current version, the history and whether a regeneration waits', async () => {
      expect(unwrap(await page.view(DEV, boardId))).toEqual({ current: null, history: [], nextRegenerationAt: null, pending: false, agentSetHistory: [], feedback: [] });
      await page.regenerate(boardId, false);
      advance(MINUTE);
      await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId)]));
      const view = unwrap(await page.view(DEV, boardId));
      expect(view.current?.version).toBe(1);
      expect(view.history).toEqual([{ version: 1, createdAt: START, reason: 'first' }]);
      expect(view).toMatchObject({ pending: true, nextRegenerationAt: new Date(Date.parse(START) + 60 * MINUTE).toISOString() });
      expect(unwrap(await page.version(DEV, boardId, 1)).version).toBe(1);
      const missing = await page.version(DEV, boardId, 2);
      expect(missing).toEqual(notFound("No version 2 of board 1's knowledge page"));
    });

    it('serves the last 10 observed agent-set versions, newest first', async () => {
      await page.regenerate(boardId, false);
      for (let v = 2; v <= 14; v++) {
        advance(1440 * MINUTE);
        set = { ...set, version: v, files: [{ path: 'agents/implementer.md', content: `${IMPLEMENTER}\nEdit ${String(v)}\n` }] };
        await page.regenerate(boardId, false);
      }
      const history = unwrap(await page.view(DEV, boardId)).agentSetHistory;
      expect(history.map((h) => h.version)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
      expect(history[0]).toMatchObject({ changedPaths: ['agents/implementer.md'] });
      expect(history[0]?.at).toBe(now);
    });

    it('is for members only', async () => {
      const outsider = 'outsider@example.com';
      await store.transaction((tx) => tx.upsertUser({ email: outsider, name: outsider, active: true }));
      expect((await page.view(outsider, boardId)).ok).toBe(false);
      expect((await page.version(outsider, boardId, 1)).ok).toBe(false);
    });

    it('queues a full rebuild for admins only', async () => {
      expect(await page.requestRebuild(DEV, boardId)).toMatchObject(err({ code: 'forbidden', message: 'Only board admins can do this' }));
      expect(unwrap(await page.requestRebuild(ADMIN, boardId))).toEqual({ queued: true });
      expect(jobs()).toEqual([{ kind: 'regenerate_knowledge_page', globId: `board-${String(boardId)}`, boardId, full: true }]);
    });
  });

  describe('the queue', () => {
    it('keeps one waiting job per board, and a rebuild upgrades it instead of adding another', async () => {
      await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId), knowledgePageEffect(boardId)]));
      await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId)]));
      expect(jobs()).toEqual([knowledgePageEffect(boardId)]);
      await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId, true)]));
      expect(jobs()).toEqual([knowledgePageEffect(boardId, true)]);
      expect(store.state.outboxJobs.filter((j) => j.kind === 'regenerate_knowledge_page')).toHaveLength(1);
      // Another board has its own.
      await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId + 1)]));
      expect(jobs()).toHaveLength(2);
    });

    it('queues a new job once the waiting one is claimed', async () => {
      await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId)]));
      store.state.outboxJobs = store.state.outboxJobs.map((j) => ({ ...j, attempts: 1 }));
      await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId)]));
      expect(jobs()).toHaveLength(2);
    });
  });
});

describe('parseDecisionGroups', () => {
  const allowed = new Set(['s1k1', 's1k2']);

  it('strips ids it was not given, drops entries left with none, and names an unnamed area General', () => {
    const answer = JSON.stringify({
      groups: [
        { area: '  ', entries: [{ text: ' Keep ', rationale: ' why ', globIds: ['s1k1', 's9k9', 's1k1'] }, { text: 'Gone', rationale: '', globIds: ['s9k9'] }, { text: '', rationale: '', globIds: ['s1k2'] }] },
        { area: 'Empty', entries: [] },
      ],
    });
    expect(parseDecisionGroups(`Here you go:\n${answer}`, allowed, new Set(['s1k1']))).toEqual([{ area: 'General', entries: [{ text: 'Keep', rationale: 'why', globIds: ['s1k1'], key: false }] }]);
  });

  it('reads key as true only for a boolean true', () => {
    const answer = JSON.stringify({
      groups: [
        {
          area: 'A',
          entries: [
            { text: 'one', rationale: '', globIds: ['s1k1'], key: true },
            { text: 'two', rationale: '', globIds: ['s1k2'], key: false },
            { text: 'three', rationale: '', globIds: ['s1k1'] },
            { text: 'four', rationale: '', globIds: ['s1k2'], key: 'true' },
          ],
        },
      ],
    });
    expect(parseDecisionGroups(answer, allowed, new Set()).flatMap((g) => g.entries.map((e) => e.key))).toEqual([true, false, false, false]);
  });

  it('refuses an answer that is not a list of groups, or that leaves a required decision out', () => {
    expect(() => parseDecisionGroups('nope', allowed, new Set())).toThrow(/list of groups/);
    expect(() => parseDecisionGroups('{"groups": []}', allowed, new Set(['s1k2']))).toThrow(/left decisions out of the section: s1k2/);
    expect(parseDecisionGroups('{"groups": []}', allowed, new Set())).toEqual([]);
  });
});

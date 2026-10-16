import { beforeEach, describe, expect, it } from 'vitest';
import { AgentSetCommitService, isAgentSetGlobOpen } from '../src/app/agent-set-commit-service.js';
import { BoardService } from '../src/app/board-service.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import { agentSetManifest, agentSetVersionOfTitle, isAgentSetGlob, managedRepoFiles, parseAgentSetManifest } from '../src/domain/agent-set.js';
import type { Result } from '../src/domain/errors.js';
import { agentSetCommitEffect } from '../src/domain/events.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { dev, glob as globFixture } from './fixtures.js';
import type { Catalog, CatalogAgentSet } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const NOW = '2026-10-05T12:00:00.000Z';

describe('the agent set commit', () => {
  let store: MemoryStore;
  let knowledge: KnowledgeService;
  let service: AgentSetCommitService;
  let boardId: number;
  let catalogSet: CatalogAgentSet;
  let committed: number | null;

  const catalog: Catalog = { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve(catalogSet) };
  const jobs = () => store.state.outboxJobs.filter((j) => j.kind === 'commit_agent_set');
  const bump = async (hash: string) => {
    catalogSet = { ...catalogSet, hash };
    await knowledge.syncCatalogAgentSet();
  };
  const agentSetGlobs = () => store.transaction((tx) => tx.findGlobsByCreationKeyPrefix(boardId, `agent-set:${String(boardId)}:`));
  const patch = async (id: string, change: Partial<Glob>) =>
    store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null) throw new Error(`no ${id}`);
      await tx.updateGlob({ ...glob, ...change }, glob.version);
    });

  beforeEach(async () => {
    catalogSet = {
      hash: 'h1',
      files: [
        { path: 'agents/tester.md', content: '# Tester\n' },
        { path: 'settings.json', content: '{}\n' },
        { path: 'hooks/after_push.sh', content: 'echo pushed\n' },
      ],
    };
    committed = null;
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => NOW };
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    service = new AgentSetCommitService({ store, clock, notifier, knowledge, repo: { committedVersion: () => Promise.resolve(committed) } });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(ADMIN, { name: 'b', repo: 'acme/app', timeZone: 'UTC', environments: [] })).id;
    unwrap(await knowledge.adoptCatalogAgentSet(ADMIN, boardId));
  });

  it('keeps one waiting job per board however many bumps arrive', async () => {
    await bump('h2');
    await bump('h3');
    await bump('h4');
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]?.effect).toEqual(agentSetCommitEffect(boardId));
    // Another board has its own; a claimed job gets a sibling.
    await store.transaction((tx) => tx.enqueueEffects([agentSetCommitEffect(boardId + 1)]));
    expect(jobs()).toHaveLength(2);
    store.state.outboxJobs = store.state.outboxJobs.map((j) => ({ ...j, attempts: 1 }));
    await store.transaction((tx) => tx.enqueueEffects([agentSetCommitEffect(boardId)]));
    expect(jobs()).toHaveLength(3);
  });

  it('opens one "Agent set vN" glob, waits for its branch, and retitles it instead of opening another', async () => {
    await bump('h2');
    const first = await service.prepare(boardId);
    expect(first.kind).toBe('waiting');
    const [glob] = await agentSetGlobs();
    expect(glob).toMatchObject({ title: 'Agent set v2', type: 'same', category: 'task', status: 'in_progress', implementer: 'slop', provisioning: 'pending' });
    // Slop picked it up, so the branch is provisioned and no run is queued.
    expect(store.state.outbox.filter((e) => e.kind === 'provision' && e.globId === glob?.id)).toHaveLength(1);
    expect(store.state.outbox.filter((e) => e.kind === 'fire_routine')).toHaveLength(0);

    await bump('h3');
    expect((await service.prepare(boardId)).kind).toBe('waiting');
    const globs = await agentSetGlobs();
    expect(globs.map((g) => g.id)).toEqual([glob?.id]);
    expect(globs[0]?.title).toBe('Agent set v3');
    // The same version again changes nothing.
    const version = globs[0]?.version;
    await service.prepare(boardId);
    expect((await agentSetGlobs())[0]?.version).toBe(version);
  });

  it('is ready once the branch exists, with the managed files, executable hooks and a manifest', async () => {
    await bump('h2');
    await service.prepare(boardId);
    const [glob] = await agentSetGlobs();
    if (glob === undefined) throw new Error('no glob');
    await patch(glob.id, { provisioning: 'ok' });
    const ready = await service.prepare(boardId);
    if (ready.kind !== 'ready') throw new Error(ready.kind);
    expect(ready.version).toBe(2);
    expect(ready.glob.id).toBe(glob.id);
    expect(ready.files.map((f) => [f.path, f.executable])).toEqual([
      ['.claude/agents/tester.md', false],
      ['.claude/hooks/after_push.sh', true],
      ['.claude/slop-agent-set.json', false],
    ]);
    const manifest = ready.files.at(-1);
    expect(parseAgentSetManifest(manifest?.content ?? '')).toEqual({ version: 2, files: ['.claude/agents/tester.md', '.claude/hooks/after_push.sh'] });
    expect(JSON.parse(manifest?.content ?? '')).toMatchObject({ board: boardId, fetchedAt: '2026-10-05T12:00:00Z' });
  });

  it('drops the job when the repo holds the board version and no glob is open, or there is no repo', async () => {
    await bump('h2');
    committed = 2;
    expect(await service.prepare(boardId)).toEqual({ kind: 'dropped' });
    expect(await agentSetGlobs()).toHaveLength(0);
    expect(await service.prepare(boardId + 7)).toEqual({ kind: 'dropped' });
    const noRepo = unwrap(await new BoardService({ store, notifier: new RecordingNotifier() }).create(ADMIN, { name: 'c', repo: null, timeZone: 'UTC', environments: [] })).id;
    expect(await service.prepare(noRepo)).toEqual({ kind: 'dropped' });
  });

  it('opens a new glob when the earlier one merged and the repo is behind again', async () => {
    await bump('h2');
    await service.prepare(boardId);
    const [first] = await agentSetGlobs();
    if (first === undefined) throw new Error('no glob');
    await patch(first.id, { status: 'signed_off', pr: { number: 3, state: 'merged', headSha: 'abc' } });
    committed = 2;
    await bump('h3');
    expect((await service.prepare(boardId)).kind).toBe('waiting');
    const globs = await agentSetGlobs();
    expect(globs).toHaveLength(2);
    expect(globs.filter((g) => g.status !== 'signed_off').map((g) => g.title)).toEqual(['Agent set v3']);
    expect(await service.openGlobId(boardId)).toBe(globs.find((g) => g.status !== 'signed_off')?.id);
  });
});

describe('a closed agent-set PR', () => {
  it('is not open: the next prepare opens agent-set:<b>:2', async () => {
    const store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => NOW };
    const catalog: Catalog = { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'h1', files: [{ path: 'agents/a.md', content: 'a\n' }] }) };
    const knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    const service = new AgentSetCommitService({ store, clock, notifier, knowledge, repo: { committedVersion: () => Promise.resolve(null) } });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    const boardId = unwrap(await new BoardService({ store, notifier }).create(ADMIN, { name: 'b', repo: 'acme/app', timeZone: 'UTC', environments: [] })).id;
    unwrap(await knowledge.adoptCatalogAgentSet(ADMIN, boardId));
    await service.prepare(boardId);
    const key = `agent-set:${String(boardId)}:`;
    const [first] = await store.transaction((tx) => tx.findGlobsByCreationKeyPrefix(boardId, key));
    if (first === undefined) throw new Error('no glob');
    expect(isAgentSetGlobOpen(first)).toBe(true);
    const closed = { ...first, status: 'failed' as const, pr: { number: 3, state: 'closed' as const, headSha: 'a' } };
    expect(isAgentSetGlobOpen(closed)).toBe(false);
    await store.transaction((tx) => tx.updateGlob(closed, first.version));
    expect((await service.prepare(boardId)).kind).toBe('waiting');
    const globs = await store.transaction((tx) => tx.findGlobsByCreationKeyPrefix(boardId, key));
    expect(globs).toHaveLength(2);
    expect(globs.find((g) => g.id !== first.id)?.pr).toBeNull();
    expect(await service.openGlobId(boardId)).not.toBe(first.id);
  });
});

describe('agent set files for the repo', () => {
  it('maps agents, commands and hooks under .claude, leaves merged files out, and writes the manifest like sstor init', () => {
    const files = managedRepoFiles([
      { path: 'settings.json', content: '{}' },
      { path: 'mcp.json', content: '{}' },
      { path: 'claude_md.md', content: 'x' },
      { path: 'commands/b.md', content: 'b' },
      { path: 'agents/a.md', content: 'a' },
      { path: 'hooks/h.sh', content: 'h' },
    ]);
    expect(files.map((f) => f.path)).toEqual(['.claude/agents/a.md', '.claude/commands/b.md', '.claude/hooks/h.sh']);
    expect(agentSetManifest(15, 7, files, '2026-10-12T10:20:08.123Z')).toBe(
      '{\n  "board": 15,\n  "version": 7,\n  "files": [\n    ".claude/agents/a.md",\n    ".claude/commands/b.md",\n    ".claude/hooks/h.sh"\n  ],\n  "fetchedAt": "2026-10-12T10:20:08Z"\n}\n',
    );
    expect(parseAgentSetManifest('nope')).toBeNull();
    expect(parseAgentSetManifest('{"version":"3"}')).toBeNull();
  });
});

describe("slop's agent-set glob in the machine", () => {
  const agentSet = (patch: Partial<Glob> = {}): Glob =>
    globFixture({ title: 'Agent set v58', category: 'task', type: 'same', status: 'in_progress', implementer: 'slop', runs: [], pr: { number: 3, state: 'draft', headSha: 'a' }, ...patch });
  const passed = { sha: 'a', state: 'passed' } as const;

  it('is recognised by its title and implementer, not by any other glob', () => {
    expect(isAgentSetGlob(agentSet())).toBe(true);
    expect(isAgentSetGlob(agentSet({ implementer: 'dev@example.com' }))).toBe(false);
    expect(isAgentSetGlob(agentSet({ title: 'Agent set vNext' }))).toBe(false);
    expect(agentSetVersionOfTitle('Agent set v58')).toBe(58);
    expect(agentSetVersionOfTitle('Agent set')).toBeNull();
  });

  it('offers review, mark ready and delete while the PR is a draft: no pick up, hand to routine or start again', () => {
    expect(machine.allowedActions(agentSet(), dev)).toEqual(['review_now', 'mark_ready', 'delete']);
  });

  it('offers merge on the ready PR (it arms while the checks run), and cancel merge once armed', () => {
    const ready = agentSet({ status: 'pr_open', pr: { number: 3, state: 'ready', headSha: 'a' } });
    expect(machine.allowedActions(ready, dev)).toEqual(['review_now', 'merge', 'delete']);
    expect(machine.allowedActions({ ...ready, headChecks: passed }, dev)).toEqual(['review_now', 'merge', 'delete']);
    expect(machine.allowedActions({ ...ready, mergeMode: 'when_green' }, dev)).toEqual(['review_now', 'cancel_merge', 'delete']);
    expect(machine.allowedActions({ ...ready, headChecks: { sha: 'a', state: 'failed' } }, dev)).toEqual(['retry_checks', 'review_now', 'delete']);
  });

  it('is marked ready from the board without an implementation record', () => {
    const step = machine.readyRequested(agentSet(), null, { actor: dev, now: NOW, newRunId: () => 'r', routineOwnerFor: () => '' }, { from: 'board', facts: {} });
    expect(step.ok && step.value.effects.map((e) => e.kind)).toEqual(['mark_pr_ready']);
  });
});

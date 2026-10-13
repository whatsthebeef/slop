import { AGENT_SET_COMMIT_DELAY_MS, AgentSetCommitService, BoardService, KnowledgeService, agentSetCommitEffect, agentSetManifest, managedRepoFiles } from '@slop/core';
import type { AgentSetPrepared, Board, Catalog, Glob, Result } from '@slop/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSetExecutors, readCommittedAgentSetVersion } from '../src/agent-set-executors.js';
import type { BranchFile } from '../src/codehost.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';
import { fakeCodeHost } from './support/fake-codehost.js';

const ADMIN = 'admin@example.com';
const NOW = '2026-10-12T10:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('the agent set commit job in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let service: AgentSetCommitService;
  let knowledge: KnowledgeService;
  let hash = 'h1';
  const committed: number | null = null;

  const catalog: Catalog = {
    kbEntries: () => Promise.resolve([]),
    agentSet: () => Promise.resolve({ hash, files: [{ path: 'agents/tester.md', content: '# Tester\n' }, { path: 'settings.json', content: '{}\n' }] }),
  };
  const jobs = async () => (await database.db.select().from(schema.outbox)).filter((r) => r.kind === 'commit_agent_set');

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('agentset'));
    store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    const clock = { now: () => NOW };
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    service = new AgentSetCommitService({ store, clock, notifier, knowledge, repo: { committedVersion: () => Promise.resolve(committed) } });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: 'Admin', active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(ADMIN, { name: 'b', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await knowledge.adoptCatalogAgentSet(ADMIN, boardId));
  });

  afterAll(() => drop());

  it('keeps one unclaimed job per board and pushes its runAfter out on every bump', async () => {
    const delay = (row: { runAfter: Date }) => row.runAfter.getTime() - Date.now();
    await store.transaction((tx) => tx.enqueueEffects([agentSetCommitEffect(boardId), agentSetCommitEffect(boardId)]));
    const [first] = await jobs();
    expect(await jobs()).toHaveLength(1);
    expect(first?.lane).toBe('default');
    expect(delay(first ?? { runAfter: new Date(0) })).toBeGreaterThan(AGENT_SET_COMMIT_DELAY_MS - 5_000);
    // Age the job, then bump again: the same job is due a full delay after the new bump.
    const early = new Date(Date.now() + 60_000);
    await database.db.update(schema.outbox).set({ runAfter: early }).where(eq(schema.outbox.id, first?.id ?? 0));
    await store.transaction((tx) => tx.enqueueEffects([agentSetCommitEffect(boardId)]));
    const [again] = await jobs();
    expect(await jobs()).toHaveLength(1);
    expect(again?.id).toBe(first?.id);
    expect(again?.runAfter.getTime()).toBeGreaterThan(early.getTime() + AGENT_SET_COMMIT_DELAY_MS - 120_000);
    // A claimed job (an attempt spent) is not touched: the new bump queues a sibling.
    await database.db.update(schema.outbox).set({ attempts: 1 }).where(eq(schema.outbox.id, first?.id ?? 0));
    await store.transaction((tx) => tx.enqueueEffects([agentSetCommitEffect(boardId)]));
    expect(await jobs()).toHaveLength(2);
    // Another board has its own.
    await store.transaction((tx) => tx.enqueueEffects([agentSetCommitEffect(boardId + 1)]));
    expect(await jobs()).toHaveLength(3);
  });

  it('opens one glob, finds it by creation key prefix and retitles it on a newer version', async () => {
    hash = 'h2';
    await knowledge.syncCatalogAgentSet();
    expect((await service.prepare(boardId)).kind).toBe('waiting');
    hash = 'h3';
    await knowledge.syncCatalogAgentSet();
    expect((await service.prepare(boardId)).kind).toBe('waiting');
    const globs = await store.transaction((tx) => tx.findGlobsByCreationKeyPrefix(boardId, `agent-set:${String(boardId)}:`));
    expect(globs).toHaveLength(1);
    expect(globs[0]).toMatchObject({ title: 'Agent set v3', status: 'in_progress', implementer: 'slop' });
    expect(await service.openGlobId(boardId)).toBe(globs[0]?.id);
    const provisions = (await database.db.select().from(schema.outbox)).filter((r) => r.kind === 'provision' && r.globId === globs[0]?.id);
    expect(provisions).toHaveLength(1);
    // Another board's prefix doesn't match.
    expect(await store.transaction((tx) => tx.findGlobsByCreationKeyPrefix(boardId + 1, `agent-set:${String(boardId)}:`))).toEqual([]);
  });

  it('reads the committed version from the base branch manifest', async () => {
    const board = await store.transaction((tx) => tx.getBoard(boardId));
    if (board === null) throw new Error('no board');
    const host = fakeCodeHost({ readFile: (_repo, ref, path) => Promise.resolve(ref === 'main' && path === '.claude/slop-agent-set.json' ? '{"version":9,"files":[]}' : null) });
    expect(await readCommittedAgentSetVersion(host, board)).toBe(9);
    expect(await readCommittedAgentSetVersion(fakeCodeHost(), board)).toBeNull();
    expect(await readCommittedAgentSetVersion(host, { ...board, repo: null })).toBeNull();
  });
});

describe('the commit_agent_set executor', () => {
  const board = { id: 15, repo: 'acme/app', baseBranch: 'main' } as unknown as Board;
  const glob = { id: 's15t9', status: 'in_progress', pr: { number: 4, state: 'draft', headSha: 'a' } } as unknown as Glob;
  const files = [...managedRepoFiles([{ path: 'agents/a.md', content: 'A\n' }, { path: 'hooks/h.sh', content: 'h\n' }])];
  const ready = (version: number): AgentSetPrepared => ({
    kind: 'ready',
    glob,
    board,
    version,
    files: [...files, { path: '.claude/slop-agent-set.json', content: agentSetManifest(15, version, files, NOW), executable: false }],
  });

  /** A host holding a branch: its manifest is the one committed last (or `previous`). */
  const setup = (prepared: AgentSetPrepared, previous: string | null, current: Glob | null = glob) => {
    const commits: { branch: string; files: readonly BranchFile[]; deletions: readonly string[]; message: string }[] = [];
    let manifest = previous;
    const host = fakeCodeHost({
      readFile: (_repo, ref, path) => Promise.resolve(ref === 's15t9' && path === '.claude/slop-agent-set.json' ? manifest : null),
      commitToBranch: (_repo, branch, committedFiles, deletions, message) => {
        commits.push({ branch, files: committedFiles, deletions, message });
        manifest = committedFiles.find((f) => f.path === '.claude/slop-agent-set.json')?.content ?? manifest;
        return Promise.resolve({ sha: 'c1', changed: true });
      },
    });
    const run = agentSetExecutors({ prepare: () => Promise.resolve(prepared) }, host, () => Promise.resolve(current)).commit_agent_set;
    if (run === undefined) throw new Error('no executor');
    return { commits, run: () => run(agentSetCommitEffect(15), null, { globs: undefined as never }) };
  };

  it('commits the files and the manifest to the glob branch, removes what the old manifest listed, and ends with the trailer', async () => {
    const old = JSON.stringify({ board: 15, version: 41, files: ['.claude/agents/a.md', '.claude/agents/gone.md'], fetchedAt: NOW });
    const { commits, run } = setup(ready(42), old);
    expect(await run()).toBe('done');
    expect(commits).toHaveLength(1);
    const [commit] = commits;
    expect(commit?.branch).toBe('s15t9');
    expect(commit?.files.map((f) => [f.path, f.executable ?? false])).toEqual([
      ['.claude/agents/a.md', false],
      ['.claude/hooks/h.sh', true],
      ['.claude/slop-agent-set.json', false],
    ]);
    expect(commit?.deletions).toEqual(['.claude/agents/gone.md']);
    expect(commit?.message.split('\n')[0]).toBe('Agent set v42');
    expect(commit?.message).toContain('from v41 to v42');
    expect(commit?.message.trimEnd().split('\n').at(-1)).toBe('Slop-Agent-Set: 42');
    expect(JSON.parse(commit?.files.at(-1)?.content ?? '')).toMatchObject({ board: 15, version: 42 });
  });

  it('does nothing the second time: the branch manifest already says the version', async () => {
    const { commits, run } = setup(ready(42), null);
    expect(await run()).toBe('done');
    expect(await run()).toBe('done');
    expect(commits).toHaveLength(1);
  });

  it('drops, waits without spending an attempt, and retries when the glob merged meanwhile', async () => {
    expect(await setup({ kind: 'dropped' }, null).run()).toBe('dropped');
    const waiting = await setup({ kind: 'waiting', reason: 'Waiting for the branch of s15t9' }, null).run();
    expect(waiting).toMatchObject({ state: 'pending', reason: 'Waiting for the branch of s15t9' });
    const merged = setup(ready(42), null, { ...glob, status: 'signed_off' });
    expect(await merged.run()).toMatchObject({ state: 'pending' });
    expect(merged.commits).toHaveLength(0);
    const closed = setup(ready(42), null, { ...glob, status: 'failed', pr: { number: 4, state: 'closed', headSha: 'a' } });
    expect(await closed.run()).toMatchObject({ state: 'pending' });
    expect(closed.commits).toHaveLength(0);
  });
});

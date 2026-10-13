import { ArtifactService, FakeEmbedder, GlobService, InboxService, IntakeService, SearchService, vectorOf } from '@slop/core';
import type { Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface Body {
  plan: { content: string };
  implementationRecord: { content: string } | null;
  attachments: { label: string }[];
  available: { kind: string }[];
  content: string;
  related?: { citation: { title: string; link: string | null; globId: string | null } }[];
}

describe('MCP get_context include and get_artifact', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let client: Client;
  let globId: string;
  let store: PgStore;
  let boardId: number;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('mcp_context'));
    store = new PgStore(database.db);
    const deps = {
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
    };
    const globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const search = new SearchService({ store, clock: deps.clock, embedder: new FakeEmbedder() });
    const artifacts = new ArtifactService({ ...deps, related: (tx, glob) => search.related(tx, glob) });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
    globId = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Super',
        summary: 'Idea',
        type: 'super',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
    const put = (kind: 'postplan' | 'implementation_plan' | 'local_review', content: string) =>
      artifacts.putArtifact(DEV, globId, kind, content, {
        commitSha: 'abc123',
        runId: null,
        agentSetVersion: null,
      });
    unwrap(await put('postplan', '# Record\n\nWhat was built.'));
    unwrap(await put('implementation_plan', '# Record\n\n**Decision.** Why.'));
    unwrap(await put('local_review', '# Review\n\nAll fine.'));
    unwrap(
      await artifacts.attach(DEV, globId, { label: 'Clarifications', text: 'Use X.', link: null }),
    );
    unwrap(
      await artifacts.attach(DEV, globId, { label: 'Notes', text: 'Side notes.', link: null }),
    );

    // Material about the same topic: one item of another glob, one of the super itself (left out of related).
    await store.transaction(async (tx) => {
      const item = (ref: string, linked: string) =>
        tx.replaceItem(
          {
            boardId,
            sourceType: 'glob_plan',
            externalRef: ref,
            title: ref,
            occurredAt: new Date().toISOString(),
            authority: 'approved_plan',
            status: 'active',
            supersededBy: null,
            globIds: [linked],
            globGroup: null,
            externalUrl: `/boards/${String(boardId)}?glob=${linked}`,
            contentHash: ref,
            state: 'ready',
          },
          [{ position: 0, header: `[${ref}]`, text: 'Super idea about plans' }],
        );
      await item('earlier-work', 's9t9');
      await item('own-work', globId);
      const pending = await tx.chunksToEmbed(100);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(c.text) })));
    });

    const intake = new IntakeService({
      store,
      llm: { complete: () => Promise.resolve(JSON.stringify({ title: 'Design it', summary: 'S', type: 'super', typeReason: 'Open design', category: 'feature' })) },
    });
    const inbox = new InboxService(deps);
    const outbox = { drain: () => Promise.resolve() };
    const server = buildServer({ artifacts, globs, intake, outbox, inbox } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { type: string; text: string }[];
    return {
      isError: result.isError === true,
      body: JSON.parse(first?.text ?? 'null') as Body,
    };
  };

  it('get_context sends plan.md, the implementation record and Clarifications in full and lists the rest with sizes', async () => {
    const { body } = await call('get_context', { id: globId });
    expect(body.plan.content).toBe('Idea');
    expect(body.attachments.map((a: { label: string }) => a.label)).toEqual(['Clarifications']);
    expect(body.implementationRecord?.content).toContain('**Decision.**');
    expect(body.available).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'local_review', description: 'Review' }),
        expect.objectContaining({ kind: 'attachment', label: 'Notes' }),
      ]),
    );
    expect(body.available).toHaveLength(2);
  });

  it('get_context adds cited related material for the glob and not its own items', async () => {
    const { body } = await call('get_context', { id: globId });
    expect(body.related?.map((h) => h.citation.title)).toEqual(['earlier-work']);
    expect(body.related?.[0]?.citation.link).toContain('s9t9');
  });

  it('get_context include returns the named artifacts in full', async () => {
    const { body } = await call('get_context', {
      id: globId,
      include: ['attachment:Notes'],
    });
    expect(body.implementationRecord?.content).toContain('**Decision.**');
    expect(body.attachments.map((a: { label: string }) => a.label).sort()).toEqual([
      'Clarifications',
      'Notes',
    ]);
    expect(body.available.map((a: { kind: string }) => a.kind)).toEqual(['local_review']);
    expect((await call('get_context', { id: globId, include: ['all'] })).body.available).toEqual(
      [],
    );
  });

  it('put_artifact keeps valid reviewStats on a local review and refuses invalid ones (s15f8)', async () => {
    const stats = { riskTier: 'high', reviewRounds: 3, maxReviewRounds: 3, testFailRounds: 1 };
    const latest = async () => (await store.transaction((tx) => tx.listArtifacts(globId, 'local_review'))).at(-1);
    const before = (await latest())?.version ?? 0;
    const put = (reviewStats: Record<string, unknown>) =>
      client.callTool({ name: 'put_artifact', arguments: { id: globId, kind: 'local_review', content: '# Review\n\nRound 3.', reviewStats } });
    expect((await put(stats)).isError).not.toBe(true);
    expect(await latest()).toMatchObject({ version: before + 1, provenance: { reviewStats: stats } });
    for (const bad of [
      { ...stats, riskTier: 'extreme' },
      { ...stats, reviewRounds: 21 },
      { ...stats, testFailRounds: -1 },
      { ...stats, maxReviewRounds: 1.5 },
      { riskTier: 'normal', reviewRounds: 1 },
    ]) {
      expect((await put(bad)).isError).toBe(true);
    }
    expect((await latest())?.version).toBe(before + 1);
  });

  it('save_plan saves plan.md conditional on the version read (s15f16)', async () => {
    const save = (version: number, content: string) =>
      client.callTool({ name: 'save_plan', arguments: { id: globId, version, content } });
    expect((await save(0, '# Plan v1')).isError).not.toBe(true);
    expect((await save(1, '# Plan v2')).isError).not.toBe(true);
    const stale = await save(1, '# Stale');
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain('version_conflict');
    const plans = await store.transaction((tx) => tx.artifactVersions(globId, 'plan', ''));
    expect(plans.map((p) => [p.version, p.content])).toEqual([[1, '# Plan v1'], [2, '# Plan v2']]);
    expect((await client.callTool({ name: 'save_plan', arguments: { id: globId, version: 2, content: '' } })).isError).toBe(true);
  });

  it('get_artifact returns one artifact in full, or an error when there is none', async () => {
    expect(
      (await call('get_artifact', { id: globId, kind: 'implementation_plan' })).body.content,
    ).toContain('# Record');
    expect(
      (await call('get_artifact', { id: globId, kind: 'attachment', label: 'Notes' })).body.content,
    ).toBe('Side notes.');
    expect(
      (await call('get_artifact', { id: globId, kind: 'attachment', label: 'Nope' })).isError,
    ).toBe(true);
  });

  it('create_glob parks a super that intake chose in Planning, but a super asked for by type starts in Doing', async () => {
    const created = async (args: Record<string, unknown>) =>
      (await call('create_glob', { board: boardId, ...args })).body as unknown as { status: string; type: string };
    const chosen = await created({ input: 'Design the export format with the PO', idempotencyKey: 'intake-super' });
    expect(chosen).toMatchObject({ type: 'super', status: 'planning' });
    const asked = await created({ title: 'Pair on it', type: 'super', category: 'feature', idempotencyKey: 'typed-super' });
    expect(asked).toMatchObject({ type: 'super', status: 'in_progress' });
    const parked = await created({ title: 'Parked', type: 'super', category: 'feature', start: false, idempotencyKey: 'parked-super' });
    expect(parked).toMatchObject({ status: 'planning' });
  });

  it('create_glob attaches an inbox item of the board and refuses another one', async () => {
    const added = (await call('add_to_inbox', { board: boardId, text: 'Notes: we should export CSV from the report page.' })).body as unknown as { id: number };
    const made = (await call('create_glob', { board: boardId, title: 'Export CSV', category: 'feature', type: 'same', inboxItem: added.id, idempotencyKey: 'from-inbox' })).body as unknown as { id: string };
    const ctx = (await call('get_context', { id: made.id })).body as unknown as { inbox: { id: number }[] };
    expect(ctx.inbox.map((i) => i.id)).toEqual([added.id]);
    expect((await store.transaction((tx) => tx.getInboxItem(boardId, added.id)))?.status).toBe('attached');
    const bad = await call('create_glob', { board: boardId, title: 'No such item', category: 'task', type: 'same', inboxItem: 99999, idempotencyKey: 'bad-item' });
    expect(bad.isError).toBe(true);
  });

  it('create_glob stores attachments with the glob, refuses a bad one and does not duplicate them on retry', async () => {
    const args = {
      board: boardId,
      title: 'With files',
      category: 'task',
      type: 'same',
      idempotencyKey: 'with-attachments',
      attachments: [{ label: 'Notes', text: 'pasted notes' }, { label: 'Spec', link: 'https://example.com/spec' }],
    };
    const made = (await call('create_glob', args)).body as unknown as { id: string };
    const ctx = (await call('get_context', { id: made.id, include: ['all'] })).body as unknown as { attachments: { label: string; content: string; link: string | null }[] };
    const mine = ctx.attachments.filter((a) => ['Notes', 'Spec'].includes(a.label));
    expect(mine.find((a) => a.label === 'Notes')).toMatchObject({ content: 'pasted notes', link: null });
    expect(mine.find((a) => a.label === 'Spec')).toMatchObject({ link: 'https://example.com/spec' });
    const again = (await call('create_glob', args)).body as unknown as { id: string };
    expect(again.id).toBe(made.id);
    const stored = await store.transaction((tx) => tx.listArtifacts(made.id, 'attachment'));
    expect(stored.filter((x) => x.label === 'Notes').map((x) => x.version)).toEqual([1]);
    const bad = await call('create_glob', { ...args, title: 'Bad', idempotencyKey: 'bad-attachment', attachments: [{ label: 'Empty' }] });
    expect(bad.isError).toBe(true);
    expect(await store.transaction((tx) => tx.findGlobByCreationKey(boardId, 'bad-attachment'))).toBeNull();
  });
});

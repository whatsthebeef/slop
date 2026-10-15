import { ArtifactService, AttachmentService, FakeEmbedder, FakeObjectStore, GlobService, InboxService, IntakeService, SearchService, vectorOf } from '@slop/core';
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
  handover?: { why: string[]; next: string; detail: string[] } | null;
  related?: { citation: { title: string; link: string | null; globId: string | null } }[];
}

describe('MCP get_context include and get_artifact', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let client: Client;
  let globId: string;
  let store: PgStore;
  let boardId: number;
  let objects: FakeObjectStore;

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
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      return board.id;
    });
    globId = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Super',
        plan: 'Idea',
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
      llm: { complete: (req) => Promise.resolve(req.system.includes('choose the group') ? JSON.stringify({ group: 'Exports' }) : JSON.stringify({ title: 'Design it', summary: 'S', type: 'super', typeReason: 'Open design', category: 'feature' })) },
    });
    const inbox = new InboxService(deps);
    const outbox = { drain: () => Promise.resolve() };
    objects = new FakeObjectStore();
    let ids = 0;
    const attachments = new AttachmentService({ ...deps, objects, newId: () => `id-${String(++ids)}` });
    const server = buildServer({ artifacts, globs, intake, outbox, inbox, attachments, deploys: { history: () => Promise.resolve({ ok: true, value: [] }) } } as unknown as McpDeps, DEV, 'http://localhost');
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

  it('get_glob and get_context return the hand-over brief, null when nothing is wrong', async () => {
    expect((await call('get_context', { id: globId })).body.handover).toBeNull();
    expect((await call('get_glob', { id: globId })).body.handover).toBeNull();
    await store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) throw new Error('no glob');
      await tx.updateGlob({ ...glob, failure: { reason: 'Needs a call', at: new Date().toISOString() }, version: glob.version + 1 }, glob.version);
    });
    for (const tool of ['get_glob', 'get_context']) {
      const { body } = await call(tool, { id: globId });
      expect(body.handover?.why).toEqual(['Failed: Needs a call']);
      expect(body.handover?.next).toMatch(/^Fix the cause, then continue from phase \d\./);
    }
    await store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) throw new Error('no glob');
      await tx.updateGlob({ ...glob, failure: null, version: glob.version + 1 }, glob.version);
    });
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
    expect((await save(0, '# Stale')).isError).toBe(true);
    expect((await save(1, '# Plan v2')).isError).not.toBe(true);
    expect((await save(2, '# Plan v3')).isError).not.toBe(true);
    const stale = await save(2, '# Stale');
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain('version_conflict');
    const plans = await store.transaction((tx) => tx.artifactVersions(globId, 'plan', ''));
    expect(plans.map((p) => [p.version, p.content])).toEqual([[1, 'Idea'], [2, '# Plan v2'], [3, '# Plan v3']]);
    expect((await client.callTool({ name: 'save_plan', arguments: { id: globId, version: 3, content: '' } })).isError).toBe(true);
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

  describe('actor, mode, fix and work kind', () => {
    interface KindBody {
      id: string;
      version: number;
      type: string | null;
      category: string;
      actor: string;
      mode: string;
      fix: boolean;
      fixSource: string;
      workKind: string;
      workKindSource: string;
      inferenceReason?: string;
    }
    const made = async (args: Record<string, unknown>) => {
      const r = await call('create_glob', { board: boardId, ...args });
      return { error: r.isError, body: r.body as unknown as KindBody };
    };

    it('accepts the old category and type as aliases and returns actor, mode, fix and workKind', async () => {
      const { body } = await made({ title: 'Old style bug', type: 'same', category: 'bug', idempotencyKey: 'kind-alias-bug' });
      expect(body).toMatchObject({ type: 'same', category: 'bug', actor: 'machine', mode: 'same', fix: true, fixSource: 'person', workKind: 'maintenance' });
      const feature = await made({ title: 'Old style feature', type: 'same', category: 'feature', idempotencyKey: 'kind-alias-feature' });
      expect(feature.body).toMatchObject({ actor: 'machine', mode: 'same', fix: false, workKind: 'rnd' });
    });

    it('takes actor, mode, fix and workKind, and a person choice is stored as such', async () => {
      const { body } = await made({ title: 'New style', actor: 'machine', mode: 'same', fix: false, workKind: 'rnd', idempotencyKey: 'kind-new' });
      expect(body).toMatchObject({ type: 'same', actor: 'machine', mode: 'same', fix: false, fixSource: 'person', workKind: 'rnd', workKindSource: 'person', category: 'feature' });
    });

    it('infers fix and workKind for a titled create that gives none, with the reason', async () => {
      const { body } = await made({ title: 'Fix the broken CSV export', type: 'same', idempotencyKey: 'kind-inferred' });
      expect(body).toMatchObject({ fix: true, fixSource: 'inferred', workKind: 'maintenance', workKindSource: 'inferred' });
      expect(body.inferenceReason).toContain('broken');
    });

    it('never makes a super a fix when it is inferred', async () => {
      const { body } = await made({ title: 'Fix the broken design', mode: 'super', idempotencyKey: 'kind-super' });
      expect(body).toMatchObject({ mode: 'super', fix: false });
    });

    it('creates a human action from actor and mode, and refuses a mix that means nothing', async () => {
      const { body } = await made({ title: 'Rotate the token', actor: 'human', idempotencyKey: 'kind-action' });
      expect(body).toMatchObject({ actor: 'human', mode: 'action', category: 'action', type: null, fix: false });
      expect((await made({ title: 'x', actor: 'machine', mode: 'action', idempotencyKey: 'kind-bad-1' })).error).toBe(true);
      expect((await made({ title: 'x', actor: 'human', mode: 'sub', idempotencyKey: 'kind-bad-2' })).error).toBe(true);
      expect((await made({ title: 'x', mode: 'same', type: 'sub', idempotencyKey: 'kind-bad-3' })).error).toBe(true);
    });

    it('lists with actor, mode, fix and workKind, and filters by them (category stays an alias)', async () => {
      const list = async (args: Record<string, unknown>) =>
        (await call('list_globs', { board: boardId, ...args })).body as unknown as KindBody[];
      const fixes = await list({ fix: true });
      expect(fixes.length).toBeGreaterThan(0);
      expect(fixes.every((g) => g.fix && g.actor === 'machine')).toBe(true);
      expect((await list({ workKind: 'rnd' })).every((g) => g.workKind === 'rnd')).toBe(true);
      expect((await list({ mode: 'super' })).every((g) => g.mode === 'super')).toBe(true);
      const human = await list({ actor: 'human' });
      expect(human.some((g) => g.mode === 'action')).toBe(true);
      expect(human.every((g) => g.actor === 'human')).toBe(true);
      expect((await list({ category: 'bug' })).every((g) => g.category === 'bug')).toBe(true);
    });

    it('update_glob flips fix and workKind as a person, and a human mode cannot be set', async () => {
      const { body } = await made({ title: 'Flip me', type: 'same', category: 'task', idempotencyKey: 'kind-flip' });
      const flipped = (await call('update_glob', { id: body.id, version: body.version, fix: true, workKind: 'rnd' })).body as unknown as KindBody;
      expect(flipped).toMatchObject({ fix: true, fixSource: 'person', workKind: 'rnd', workKindSource: 'person' });
      const moved = (await call('update_glob', { id: body.id, version: flipped.version, mode: 'same' })).body as unknown as KindBody;
      expect(moved).toMatchObject({ actor: 'machine', mode: 'same' });
      const get = (await call('get_glob', { id: body.id })).body as unknown as KindBody;
      expect(get).toMatchObject({ actor: 'machine', mode: 'same', fix: true, workKind: 'rnd' });
    });

    it('split_glob parts take mode, fix and workKind', async () => {
      const { body } = await made({ title: 'Split me', type: 'same', category: 'task', plan: 'Two things', idempotencyKey: 'kind-split' });
      const split = (
        await call('split_glob', {
          id: body.id,
          version: body.version,
          idempotencyKey: 'kind-split-key',
          parts: [
            { title: 'Split me: one', plan: 'One' },
            { title: 'Split me: two', plan: 'Two', fix: true, workKind: 'rnd' },
          ],
        })
      ).body as unknown as { parts: KindBody[] };
      expect(split.parts[1]).toMatchObject({ actor: 'machine', fix: true, workKind: 'rnd' });
    });
  });

  it('create_glob chooses a group for a titled create, and an explicit group or null wins', async () => {
    const groupOf = async (args: Record<string, unknown>) =>
      ((await call('create_glob', { board: boardId, category: 'task', type: 'same', ...args })).body as unknown as { group: string | null }).group;
    expect(await groupOf({ title: 'Export CSV', idempotencyKey: 'grp-suggested' })).toBe('Exports');
    expect(await groupOf({ title: 'Export PDF', group: 'Mine', idempotencyKey: 'grp-explicit' })).toBe('Mine');
    expect(await groupOf({ title: 'Export XML', group: null, idempotencyKey: 'grp-null' })).toBeNull();
    expect(await groupOf({ title: 'Export TXT', group: '', idempotencyKey: 'grp-empty' })).toBeNull();
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

  it('create_glob takes files and replies with upload links and ready curl commands; the old attachments field is gone', async () => {
    const args = { board: boardId, title: 'With files', category: 'task', type: 'same', idempotencyKey: 'with-files', files: [{ fileName: 'shot.png' }, { fileName: 'notes.txt', label: 'Notes file' }] };
    const made = (await call('create_glob', args)).body as unknown as { id: string; next: string; uploads: { fileName: string; label: string; url: string; fields: Record<string, string>; curl: string }[] };
    expect(made.uploads.map((u) => [u.fileName, u.label])).toEqual([['shot.png', 'shot.png'], ['notes.txt', 'Notes file']]);
    expect(made.next).toContain('Run each curl command now');
    const [shot] = made.uploads;
    expect(shot?.curl).toContain('curl -sS -f -X POST');
    expect(shot?.curl).toContain(`-F 'key=${shot?.fields.key ?? ''}'`);
    expect(shot?.curl).toContain("-F 'Content-Type=image/png'");
    expect(shot?.curl.indexOf('-F file=@<path>')).toBeGreaterThan(shot?.curl.indexOf('Content-Type') ?? 0);
    expect(shot?.curl.endsWith(`'${shot.url}'`)).toBe(true);
    const ctx = (await call('get_context', { id: made.id })).body as unknown as { files: { label: string; state: string; downloadUrl?: string }[] };
    expect(ctx.files.map((f) => [f.label, f.state]).sort()).toEqual([['Notes file', 'pending'], ['shot.png', 'pending']]);
    const bad = await call('create_glob', { ...args, title: 'Bad', idempotencyKey: 'bad-file', files: [{ fileName: 'tool.exe' }] });
    expect(bad.isError).toBe(true);
    expect(await store.transaction((tx) => tx.findGlobByCreationKey(boardId, 'bad-file'))).toBeNull();
    const withOld = await call('create_glob', { board: boardId, title: 'Old', category: 'task', type: 'same', idempotencyKey: 'old-field', attachments: [{ label: 'x', text: 'y' }] });
    const stored = await store.transaction((tx) => tx.listArtifacts((withOld.body as unknown as { id: string }).id, 'attachment'));
    expect(stored.filter((a) => a.label === 'x')).toEqual([]);
  });

  it('attachment_upload_url mints a link for an existing glob and refuses a label that already holds a file', async () => {
    const first = (await call('attachment_upload_url', { id: globId, fileName: 'diagram.pdf' })).body as unknown as { uploads: { attachmentId: number; curl: string }[]; next: string };
    expect(first.uploads).toHaveLength(1);
    expect(first.uploads[0]?.curl).toContain("-F 'Content-Type=application/pdf'");
    expect(first.next).toContain('no further call is needed');
    const again = await call('attachment_upload_url', { id: globId, fileName: 'diagram.pdf' });
    expect(again.isError).toBe(true);
    expect((await call('attachment_upload_url', { id: globId, fileName: 'a.exe' })).isError).toBe(true);
  });

  it('get_context and get_artifact give a stored file a fresh download link, and a missing one a note', async () => {
    const made = (await call('attachment_upload_url', { id: globId, fileName: 'stored.png' })).body as unknown as { uploads: { fields: { key: string } }[] };
    objects.put(made.uploads[0]?.fields.key ?? '', { size: 5, contentType: 'image/png' });
    const attachments = new AttachmentService({ store, notifier: { publish: () => undefined }, clock: { now: () => new Date().toISOString() }, objects, newId: () => 'x' });
    await attachments.objectArrived(made.uploads[0]?.fields.key ?? '');
    const ctx = (await call('get_context', { id: globId })).body as unknown as { files: { label: string; state: string; downloadUrl?: string }[] };
    const file = ctx.files.find((f) => f.label === 'stored.png');
    expect(file).toMatchObject({ state: 'stored' });
    expect(file?.downloadUrl).toContain('fake-bucket');
    const artifact = (await call('get_artifact', { id: globId, kind: 'attachment', label: 'stored.png' })).body as unknown as { downloadUrl?: string };
    expect(artifact.downloadUrl).toContain('fake-bucket');
  });
});

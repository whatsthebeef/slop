import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { Result } from '../src/domain/errors.js';
import { agentSetKind, docName, parseFrontmatter } from '../src/domain/knowledge.js';
import type { Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';

const BUILD_DOC = `---
area: build
audience: [implementer, tester, change_reviewer]
description: Build, test and lint commands.
---

# Build

\`\`\`bash
pnpm -r build
\`\`\`
`;

const catalog: Catalog = {
  kbEntries: () =>
    Promise.resolve([
      { id: 'typescript_conventions', version: 2, fileName: 'typescript_conventions.md', content: '---\narea: conventions\naudience: [implementer, change_reviewer]\ndescription: TS.\n---\nNo any.\n' },
    ]),
  agentSet: () =>
    Promise.resolve([
      { path: 'agents/orchestrator.md', content: '---\nname: orchestrator\n---\nRun the phases.\n' },
      { path: 'commands/run-glob.md', content: 'Run a glob.\n' },
      { path: 'settings.json', content: '{}\n' },
      { path: 'README.md', content: 'not part of the delivered set' },
    ]),
};

describe('frontmatter and names', () => {
  it('reads area, audience and description, and strips the block', () => {
    const meta = parseFrontmatter(BUILD_DOC);
    expect(meta.area).toBe('build');
    expect(meta.audience).toEqual(['implementer', 'tester', 'change_reviewer']);
    expect(meta.description).toBe('Build, test and lint commands.');
    expect(meta.body.startsWith('\n# Build')).toBe(true);
  });

  it('treats documents without frontmatter as plain content', () => {
    expect(parseFrontmatter('# Hello\n')).toMatchObject({ area: null, audience: [], body: '# Hello\n' });
  });

  it('names documents after their file and classifies agent-set paths', () => {
    expect(docName('.sstor/docs/build_test_lint.md')).toBe('build_test_lint');
    expect(agentSetKind('agents/tester.md')).toBe('agent');
    expect(agentSetKind('hooks/slop_after_push.sh')).toBe('hook');
    expect(agentSetKind('README.md')).toBeNull();
  });
});

describe('knowledge and artifacts', () => {
  let store: MemoryStore;
  let knowledge: KnowledgeService;
  let artifacts: ArtifactService;
  let globs: GlobService;
  let notifier: RecordingNotifier;
  let boardId: number;
  const clock = { now: () => '2026-10-05T12:00:00.000Z' };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    const boards = new BoardService({ store, notifier });
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    artifacts = new ArtifactService({ store, clock, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => 'run-1' },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('forks the agent set and bumps its version only when something changed', async () => {
    const first = unwrap(await knowledge.forkAgentSet(ADMIN, boardId));
    expect(first.created).toEqual(['agents/orchestrator.md', 'commands/run-glob.md', 'settings.json']);
    const set = unwrap(await knowledge.agentSet(DEV, boardId));
    expect(set.version).toBe(1);
    expect(set.files.map((f) => f.path)).toEqual(['agents/orchestrator.md', 'commands/run-glob.md', 'settings.json']);
    const again = unwrap(await knowledge.forkAgentSet(ADMIN, boardId));
    expect(again.unchanged).toHaveLength(3);
    expect(unwrap(await knowledge.agentSet(DEV, boardId)).version).toBe(1);
  });

  it('imports documents for admins only, versioning real changes', async () => {
    expect((await knowledge.importDocuments(DEV, boardId, [{ fileName: 'build_test_lint.md', content: BUILD_DOC }], 'upload')).ok).toBe(false);
    unwrap(await knowledge.importDocuments(ADMIN, boardId, [{ fileName: 'build_test_lint.md', content: BUILD_DOC }], 'import'));
    const changed = unwrap(
      await knowledge.importDocuments(ADMIN, boardId, [{ fileName: 'build_test_lint.md', content: BUILD_DOC.replace('pnpm', 'npm') }], 'upload'),
    );
    expect(changed.updated).toEqual(['build_test_lint']);
    const [entry] = unwrap(await knowledge.index(DEV, boardId));
    expect(entry).toMatchObject({ name: 'build_test_lint', area: 'build', version: 2, source: 'upload' });
    // Importing documents never changes the agent set.
    expect(unwrap(await knowledge.agentSet(DEV, boardId)).version).toBe(0);
  });

  it('serves documents by area or by name', async () => {
    unwrap(await knowledge.importCatalogEntries(ADMIN, boardId, ['typescript_conventions']));
    unwrap(await knowledge.importDocuments(ADMIN, boardId, [{ fileName: 'build_test_lint.md', content: BUILD_DOC }], 'import'));
    expect(unwrap(await knowledge.documents(DEV, boardId, 'conventions')).map((d) => d.source)).toEqual([
      'catalog:typescript_conventions@2',
    ]);
    expect(unwrap(await knowledge.documents(DEV, boardId, 'build_test_lint'))[0]?.content).toContain('pnpm -r build');
    expect((await knowledge.documents(DEV, boardId, 'nope')).ok).toBe(false);
  });

  it('builds a basic context from plan.md and attachments', async () => {
    const glob = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Plan me',
        summary: 'First idea',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    expect(unwrap(await artifacts.context(DEV, glob.id)).plan).toEqual({ version: 0, content: 'First idea' });
    unwrap(await artifacts.putPlan(DEV, glob.id, '# Plan\n\nDone when: it works.'));
    unwrap(await artifacts.attach(DEV, glob.id, { label: 'Meeting', text: 'We decided X.', link: null }));
    const context = unwrap(await artifacts.context(DEV, glob.id));
    expect(context.plan).toEqual({ version: 1, content: '# Plan\n\nDone when: it works.' });
    expect(context.attachments).toEqual([{ label: 'Meeting', content: 'We decided X.', link: null }]);
    expect(unwrap(await artifacts.plan(DEV, glob.id, null)).versions).toHaveLength(1);
  });

  it('ignores artifacts from a run that is not current', async () => {
    const glob = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Sub',
        summary: '',
        type: 'sub',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    const stale = unwrap(
      await artifacts.putArtifact(DEV, glob.id, 'implementation_plan', 'plan', { commitSha: null, runId: 'old', agentSetVersion: 1 }),
    );
    expect(stale).toMatchObject({ ignored: true });
    expect(store.state.events.filter((e) => e.type === 'ArtifactAdded')).toHaveLength(0);
    expect(notifier.hints.filter((h) => h.kind === 'glob.artifacts')).toHaveLength(0);
    const fresh = unwrap(
      await artifacts.putArtifact(DEV, glob.id, 'implementation_plan', 'plan', { commitSha: 'abc', runId: 'run-1', agentSetVersion: 1 }),
    );
    expect(fresh).toMatchObject({ version: 1, provenance: { by: 'routine', runId: 'run-1', agentSetVersion: 1 } });
  });

  const createGlob = async (title: string, type: 'same' | 'super' = 'same') =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title,
        summary: '',
        type,
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );

  it('records ArtifactAdded and publishes a hint without bumping the glob version', async () => {
    const glob = await createGlob('Review me', 'super');
    notifier.hints.length = 0;
    const review = unwrap(
      await artifacts.putArtifact(DEV, glob.id, 'local_review', '# Review\n\nLooks fine.', {
        commitSha: 'abc123',
        runId: null,
        agentSetVersion: 4,
      }),
    );
    expect(review).toMatchObject({ kind: 'local_review', version: 1, provenance: { by: 'sessionator' } });
    const added = store.state.events.filter((e) => e.type === 'ArtifactAdded');
    expect(added).toEqual([
      {
        type: 'ArtifactAdded',
        globId: glob.id,
        actor: DEV,
        at: clock.now(),
        data: { kind: 'local_review', label: '', version: 1, commitSha: 'abc123', runId: null, agentSetVersion: 4 },
      },
    ]);
    expect(notifier.hints).toEqual([{ kind: 'glob.artifacts', boardId, globId: glob.id }]);
    expect(unwrap(await globs.get(DEV, glob.id)).glob.version).toBe(glob.version);
  });

  it('lists artifact summaries per kind with the latest version and a version count', async () => {
    const glob = await createGlob('Super', 'super');
    const other = await createGlob('Other');
    unwrap(await artifacts.putPlan(DEV, glob.id, '# Plan'));
    const options = { runId: null, agentSetVersion: null };
    unwrap(await artifacts.putArtifact(DEV, glob.id, 'local_review', 'first', { ...options, commitSha: 'aaa' }));
    unwrap(await artifacts.putArtifact(DEV, glob.id, 'local_review', 'second', { ...options, commitSha: 'bbb' }));
    unwrap(await artifacts.putArtifact(DEV, glob.id, 'postplan', 'post', { ...options, commitSha: 'bbb' }));
    unwrap(await artifacts.putArtifact(DEV, other.id, 'postplan', 'other', { ...options, commitSha: null }));

    const view = unwrap(await globs.get(DEV, glob.id));
    expect(view.artifacts.map((a) => [a.kind, a.version, a.versions, a.commitSha])).toEqual([
      ['plan', 1, 1, null],
      ['postplan', 1, 1, 'bbb'],
      ['local_review', 2, 2, 'bbb'],
    ]);
    expect(view.artifacts[2]).toMatchObject({ by: 'sessionator', actor: DEV, createdAt: clock.now() });
    expect(view.artifacts[2]).not.toHaveProperty('content');
    const history = unwrap(await artifacts.versions(DEV, glob.id, 'local_review', ''));
    expect(history.map((a) => [a.version, a.content, a.commitSha])).toEqual([
      [1, 'first', 'aaa'],
      [2, 'second', 'bbb'],
    ]);
    expect((await artifacts.versions('stranger@example.com', glob.id, 'local_review', '')).ok).toBe(false);

    const board = unwrap(await globs.listWithArtifacts(DEV, boardId, {}));
    const kinds = Object.fromEntries(board.map((g) => [g.glob.id, g.artifacts.map((a) => a.kind)]));
    expect(kinds).toEqual({ [glob.id]: ['plan', 'postplan', 'local_review'], [other.id]: ['postplan'] });
    // Globs the board doesn't show are dropped before their summaries are read.
    const shown = unwrap(await globs.listWithArtifacts(DEV, boardId, {}, (g) => g.id === other.id));
    expect(shown.map((g) => g.glob.id)).toEqual([other.id]);
    expect((await globs.listWithArtifacts('stranger@example.com', boardId, {})).ok).toBe(false);
  });

  it('deletes a glob\'s artifacts with the glob', async () => {
    const glob = await createGlob('Short-lived');
    unwrap(await artifacts.putPlan(DEV, glob.id, '# Plan'));
    const current = unwrap(await globs.get(DEV, glob.id)).glob;
    unwrap(await globs.delete(DEV, glob.id, current.version));
    expect(store.state.artifacts.filter((a) => a.globId === glob.id)).toEqual([]);
    expect(await store.transaction((tx) => tx.listArtifactSummaries(boardId, [glob.id]))).toEqual([]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewInputService } from '../src/app/review-input-service.js';
import type { Result } from '../src/domain/errors.js';
import type { NewKnowledgeItem } from '../src/domain/search.js';
import { filterDiff, planSummary, renderHistoryBriefing } from '../src/domain/review-input.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { glob as makeGlob } from './fixtures.js';

const NOW = '2026-10-05T12:00:00.000Z';
const DEV = 'dev@example.com';

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

const section = (path: string, body = '@@ -1,2 +1,2 @@\n context\n-old\n+new') =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

describe('filterDiff', () => {
  it('keeps changed code and leaves out lockfiles, generated files, ignored paths and binaries, naming them', () => {
    const diff = [
      section('src/pay.ts'),
      section('pnpm-lock.yaml'),
      section('apps/web/dist/main.js'),
      section('docs/notes.md'),
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ',
      section('src/ok.ts'),
    ].join('\n');
    const result = filterDiff(diff, [/^docs\//]);
    expect(result.files).toEqual(['src/pay.ts', 'src/ok.ts']);
    expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([
      ['pnpm-lock.yaml', 'lockfile-or-generated'],
      ['apps/web/dist/main.js', 'lockfile-or-generated'],
      ['docs/notes.md', 'ignored'],
      ['logo.png', 'binary'],
    ]);
    expect(result.diff).toContain('+new');
    expect(result.diff).not.toContain('lock.yaml\n---');
    expect(result.diff).toMatch(/\[not shown: pnpm-lock\.yaml, .*logo\.png/);
  });

  it('uses the old path for a deletion and returns a diff without git sections unchanged', () => {
    const gone = filterDiff(
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x',
      [],
    );
    expect(gone.files).toEqual(['src/a.ts']);
    const plain = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b';
    expect(filterDiff(plain)).toEqual({ diff: plain, files: [], skipped: [] });
  });

  it('adds no note when nothing is skipped', () => {
    expect(filterDiff(section('src/a.ts')).diff).not.toContain('not shown');
  });
});

describe('planSummary', () => {
  it('holds the title, summary and the Done when lines, not the rest of the plan', () => {
    const plan =
      '- [ ] T4: Input assembly. Done when: only changed code is sent.\n\n## Goal\n\nLong prose.\n\nDone when: the guide is included.';
    const out = planSummary({ title: 'Part 1', summary: 'Prepare inputs.' }, plan);
    expect(out).toBe(
      'Part 1\n\nPrepare inputs.\n\nDone when:\n- T4: Input assembly. Done when: only changed code is sent.\n- Done when: the guide is included.',
    );
    expect(out).not.toContain('Long prose');
  });

  it('is just the title and summary when the plan has no Done when line', () => {
    expect(planSummary({ title: 'T', summary: '' }, null)).toBe('T');
  });
});

describe('renderHistoryBriefing', () => {
  const file = (path: string, n = 1) => ({
    path,
    changes: Array.from({ length: n }, (_, i) => ({
      globId: `s1t${i}`,
      title: `Change ${i}`,
      date: NOW,
      summary: 'x'.repeat(2000),
    })),
    problems: [],
    decisions: [],
  });

  it('is empty when no file has history', () => {
    expect(
      renderHistoryBriefing([{ path: 'a.ts', changes: [], problems: [], decisions: [] }]),
    ).toBe('');
  });

  it('stays within the token budget and says how many files it left out', () => {
    const out = renderHistoryBriefing([file('a.ts', 4), file('b.ts', 4), file('c.ts', 4)], 600);
    expect(out).toContain('### a.ts');
    expect(out).not.toContain('### c.ts');
    expect(out).toMatch(/History for \d+ more changed files? left out/);
  });

  it('labels a superseded decision as history', () => {
    const out = renderHistoryBriefing([
      {
        path: 'a.ts',
        changes: [],
        problems: [],
        decisions: [{ globId: 's1t1', statement: 'Use X', date: NOW, superseded: true }],
      },
    ]);
    expect(out).toContain('Replaced choice (history only)');
  });
});

describe('ReviewInputService', () => {
  let store: MemoryStore;
  let service: ReviewInputService;
  let boardId: number;

  const addGlob = (id: string, title: string, summary = '') =>
    store.transaction((tx) => tx.insertGlob(makeGlob({ id, boardId, title, summary }), null));
  const addChange = (sha: string, globId: string, text: string, occurredAt: string) => {
    const item: NewKnowledgeItem = {
      boardId,
      sourceType: 'change_summary',
      externalRef: `change:${sha}`,
      title: `${globId} change`,
      occurredAt,
      authority: 'merged_code',
      status: 'active',
      supersededBy: null,
      globIds: [globId],
      globGroup: null,
      externalUrl: null,
      contentHash: sha,
      state: 'ready',
    };
    return store.transaction((tx) => tx.replaceItem(item, [{ position: 0, header: '[c]', text }]));
  };

  beforeEach(async () => {
    store = new MemoryStore();
    service = new ReviewInputService({ store });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
      boardId = (
        await tx.insertBoard({
          name: 'b',
          repo: null,
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [],
          sensitivePaths: [],
        })
      ).id;
    });
  });

  it('assembles changed code with the plan summary, the review guide and no lockfiles', async () => {
    await addGlob('s1t1', 'Retry jobs', 'Retry failed jobs.');
    await store.transaction(async (tx) => {
      await tx.insertArtifact({
        globId: 's1t1',
        kind: 'plan',
        label: '',
        content: '- [ ] T1: Retry. Done when: a failed job runs again.',
        link: null,
        commitSha: null,
        provenance: { by: 'human', actor: DEV, runId: null, agentSetVersion: null },
        createdAt: NOW,
      });
      await tx.saveKnowledge({
        boardId,
        kind: 'doc',
        name: 'guide',
        area: 'review_guide',
        audience: [],
        description: 'g',
        content: 'Prefer early returns.',
        layer: 'file',
        version: 1,
        source: 'upload',
        updatedBy: DEV,
        updatedAt: NOW,
      });
    });
    const { input, files, skipped } = unwrap(
      await service.assemble({
        boardId,
        globId: 's1t1',
        diff: [section('src/job.ts'), section('pnpm-lock.yaml')].join('\n'),
      }),
    );
    expect(files).toEqual(['src/job.ts']);
    expect(skipped.map((s) => s.path)).toEqual(['pnpm-lock.yaml']);
    expect(input.diff).toContain('+new');
    expect(input.plan).toContain('Retry jobs');
    expect(input.plan).toContain('a failed job runs again');
    expect(input.reviewGuide).toBe('Prefer early returns.');
    expect(input.context).toBe('');
  });

  it('briefs on an earlier glob that changed the file: its summary, its past findings and failing test runs', async () => {
    await addGlob('s1t1', 'Retry jobs');
    await addGlob('s1t2', 'Add timeouts');
    await addGlob('s1t3', 'Unrelated');
    await addChange(
      'aaa',
      's1t1',
      'Files: src/job.ts, src/queue.ts\n\nAdded retries because jobs were lost.',
      '2026-09-01T00:00:00.000Z',
    );
    await addChange(
      'bbb',
      's1t3',
      'Files: src/other.ts\n\nNot this file.',
      '2026-09-02T00:00:00.000Z',
    );
    await addChange(
      'ccc',
      's1t2',
      'Files: src/job.ts\n\nThe change under review, already merged.',
      '2026-09-03T00:00:00.000Z',
    );
    await store.transaction(async (tx) => {
      const source = await tx.insertReviewSource({
        boardId,
        globId: 's1t1',
        kind: 'local_review',
        artifactId: null,
        externalId: null,
        commitSha: null,
        agentSetVersion: null,
        content: 'r',
        path: null,
        line: null,
        createdAt: NOW,
      });
      if (source === null) throw new Error('no source');
      const base = {
        boardId,
        globId: 's1t1',
        sourceId: source.id,
        source: 'local_review' as const,
        commitSha: null,
        agentSetVersion: null,
        round: 1,
        line: '10',
      };
      await tx.insertFindings(
        [
          {
            ...base,
            severity: 'in_scope',
            path: 'src/job.ts',
            text: 'Retry loop never stops',
            fingerprint: 'a',
          },
          {
            ...base,
            severity: 'in_scope',
            path: 'src/queue.ts',
            text: 'About another file',
            fingerprint: 'b',
          },
          {
            ...base,
            severity: 'suggestion',
            path: 'src/job.ts',
            text: 'Rename it',
            fingerprint: 'c',
          },
        ],
        NOW,
      );
      await tx.insertTestRun({
        boardId,
        kind: 'atf',
        globId: 's1t1',
        environment: null,
        sha: 'abcdef1234',
        passed: 3,
        failed: 2,
        skipped: 0,
        url: null,
        finishedAt: NOW,
        eventId: 'e1',
      });
      const decision = await tx.upsertDecision({
        boardId,
        itemId: 0,
        globId: 's1t1',
        group: null,
        statement: 'Retry at most five times',
        quote: 'q',
        decidedBy: null,
        decidedAt: NOW,
        sourceKind: 'plan',
        sourceRef: 'r',
        sourceLabel: 'l',
        sourceUrl: null,
        createdAt: NOW,
      });
      await tx.updateDecision(decision.id, { replacedBy: 99, replaceState: 'applied' });
    });

    const { input } = unwrap(
      await service.assemble({ boardId, globId: 's1t2', diff: section('src/job.ts') }),
    );
    const context = input.context ?? '';
    expect(context).toContain('### src/job.ts');
    expect(context).toContain('Added retries because jobs were lost');
    expect(context).toContain('Retry loop never stops');
    expect(context).toContain('failed 2 tests');
    expect(context).toContain('Replaced choice (history only)');
    expect(context).not.toContain('Not this file');
    expect(context).not.toContain('already merged');
    expect(context).not.toContain('About another file');
    expect(context).not.toContain('Rename it');
  });

  it('refuses a glob from another board', async () => {
    await addGlob('s1t1', 'T');
    const result = await service.assemble({ boardId: boardId + 1, globId: 's1t1', diff: '' });
    expect(result.ok).toBe(false);
  });
});

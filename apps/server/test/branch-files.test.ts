import type { Board, Glob } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { HostBranchFiles } from '../src/branch-files.js';

const NOW = '2026-10-08T12:00:00.000Z';
const board: Board = {
  id: 1,
  name: 'demo',
  repo: 'acme/app',
  baseBranch: 'main',
  timeZone: 'UTC',
  defaultRoutineOwner: null,
  environments: [],
  sensitivePaths: [],
  deploy: null,
  readinessTicks: {},
  agentSetVersion: 1,
  agentCatalogHash: null,
  runNoProgressHours: 2,
  runReadyHours: 8,
  runStartMinutes: 30,
  runRespondMinutes: 30,
  subMaxChangedLines: 2000,
  effectCheckGlobs: 10,
  agentKbApproval: 'docs',
  version: 1,
};
const glob = (patch: Partial<Glob> = {}): Glob => ({
  id: 's1t1',
  boardId: 1,
  title: 'Work',
  summary: '',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  status: 'in_progress',
  version: 1,
  generation: 1,
  creator: 'dev@example.com',
  planner: 'dev@example.com',
  implementer: null,
  labels: {},
  checklists: {},
  pr: { number: 1, state: 'draft', headSha: 'aaa' },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: NOW,
  updatedAt: NOW,
  signedOffAt: null,
  doingSince: NOW,
  ...patch,
});

describe('HostBranchFiles', () => {
  const setup = (fail = false) => {
    const calls: string[] = [];
    const logs: string[] = [];
    let now = 0;
    const files = new HostBranchFiles(
      () => ({
        configured: true,
        diffSummary: (_repo, ref) => {
          calls.push(ref);
          return fail ? Promise.reject(new Error('boom')) : Promise.resolve({ changedLines: 3, files: ['a.ts'] });
        },
      }),
      (task, message) => logs.push(`${task}: ${message}`),
      () => now,
    );
    return { files, calls, logs, advance: (ms: number) => (now += ms) };
  };

  it('compares the glob branch against the base and caches per head for a minute', async () => {
    const { files, calls, advance } = setup();
    expect(await files.filesOf(board, glob())).toEqual(['a.ts']);
    expect(await files.filesOf(board, glob())).toEqual(['a.ts']);
    expect(calls).toEqual(['s1t1']);
    // A new head is a new read; so is the same head a minute on.
    await files.filesOf(board, glob({ pr: { number: 1, state: 'draft', headSha: 'bbb' } }));
    advance(61_000);
    await files.filesOf(board, glob());
    expect(calls).toHaveLength(3);
  });

  it('reads as unknown without a branch, and when the host fails (logged, never thrown)', async () => {
    const quiet = setup();
    expect(await quiet.files.filesOf(board, glob({ provisioning: 'none' }))).toBeNull();
    expect(quiet.calls).toEqual([]);
    const failing = setup(true);
    expect(await failing.files.filesOf(board, glob())).toBeNull();
    expect(failing.logs[0]).toContain('Reading the files of s1t1 failed: boom');
  });
});

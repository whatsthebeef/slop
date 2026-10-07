import type { Context } from '../src/domain/machine.js';
import type { Actor, Board, Glob, Run } from '../src/domain/types.js';

export const NOW = '2026-10-05T12:00:00.000Z';

export const board: Board = {
  id: 1,
  name: 'demo',
  repo: 'acme/app',
  baseBranch: 'main',
  timeZone: 'UTC',
  defaultRoutineOwner: 'owner@example.com',
  environments: [
    { name: 'dev', allowBranchDeploy: true },
    { name: 'prod', allowBranchDeploy: false },
  ],
  sensitivePaths: [],
  deploy: { provider: 'codebuild', region: 'us-east-1', defaultProject: 'deploy', projects: {} },
  readinessTicks: {},
  agentSetVersion: 1,
  agentCatalogHash: null,
  runNoProgressHours: 2,
  runReadyHours: 8,
  runStartMinutes: 30,
  subMaxChangedLines: 2000,
  version: 1,
};

export const dev: Actor = { email: 'dev@example.com', role: 'dev' };
export const other: Actor = { email: 'other@example.com', role: 'dev' };
export const po: Actor = { email: 'po@example.com', role: 'po' };

export const ctx = (actor: Actor | null = dev): Context => {
  let n = 0;
  return {
    actor,
    now: NOW,
    newRunId: () => `run-${++n}`,
    routineOwnerFor: (email) => email,
  };
};

export const glob = (patch: Partial<Glob> = {}): Glob => ({
  id: 's1t1',
  boardId: 1,
  title: 'Fix login timeout',
  summary: '',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  status: 'planning',
  version: 1,
  generation: 1,
  creator: dev.email,
  planner: dev.email,
  implementer: null,
  labels: {},
  checklists: {},
  pr: { number: 7, state: 'draft', headSha: 'aaa' },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: NOW,
  updatedAt: NOW,
  signedOffAt: null,
  doingSince: null,
  ...patch,
});

export const run = (patch: Partial<Run> = {}): Run => ({
  id: 'run-0',
  state: 'active',
  outcome: null,
  generation: 1,
  triggeredBy: dev.email,
  routineOwner: dev.email,
  queuedAt: NOW,
  startedAt: NOW,
  lastProgressAt: NOW,
  endedAt: null,
  failureReason: null,
  sessionId: null,
  sessionUrl: null,
  ...patch,
});

import { describe, expect, it } from 'vitest';
import { appSettingsUrl, behindWarning, missingAppEvents, queuedRunNotice, readiness, runsClaudeAction, allowsBot, recentRoutineFailures, routineFailureFix, stuckHint, unreactedCheckFailures } from '../src/domain/readiness.js';
import type { ReadinessFacts } from '../src/domain/readiness.js';
import { NOW, board, glob, run } from './fixtures.js';

const ready: ReadinessFacts = {
  board: {
    ...board,
    environments: [
      { name: 'dev', allowBranchDeploy: true, subDefault: true },
      { name: 'prod', allowBranchDeploy: false },
    ],
    agentSetVersion: 3,
  },
  repoConnected: true,
  installUrl: null,
  subGateWorkflow: true,
  claudeWorkflow: true,
  slopBot: 'slop[bot]',
  claudeAllowsSlop: true,
  appEvents: { missing: [], settingsUrl: 'https://github.com/settings/apps/slop/permissions' },
  committedAgentSetVersion: 3,
  hasBuildDoc: true,
  ticks: { routines: true, routine_repo: true, claude_app: true },
  recentFailures: [],
  unreactedCheckFailures: [],
};

const stateOf = (facts: ReadinessFacts) => Object.fromEntries(readiness(facts).map((i) => [i.key, i.state]));

describe('Claude workflow readiness', () => {
  const item = (claudeWorkflow: boolean | null) => readiness({ ...ready, claudeWorkflow }).find((i) => i.key === 'claude_workflow');

  it('passes when a workflow runs the Claude action', () => {
    expect(item(true)).toMatchObject({ state: 'ok', manual: false });
  });

  it('fails with the fix when no workflow does', () => {
    expect(item(false)).toMatchObject({ state: 'missing', title: 'Claude workflow on main' });
    expect(item(false)?.detail).toBe(
      'Add a Claude workflow: run /install-github-app in Claude Code for acme/app, or copy catalog/scripts/claude.yml to .github/workflows/ and add the CLAUDE_CODE_OAUTH_TOKEN secret',
    );
  });

  it('is unknown when slop cannot read the repo', () => {
    expect(item(null)).toMatchObject({ state: 'unknown' });
  });

  it('recognises only files that reference the action', () => {
    expect(runsClaudeAction('steps:\n  - uses: anthropics/claude-code-action@v1\n')).toBe(true);
    expect(runsClaudeAction('steps:\n  - uses: actions/checkout@v4\n')).toBe(false);
  });

  it("warns with the exact line when the workflow does not allow slop's App", () => {
    const warned = readiness({ ...ready, claudeAllowsSlop: false }).find((i) => i.key === 'claude_workflow');
    expect(warned).toMatchObject({ state: 'missing' });
    expect(warned?.detail).toContain('allowed_bots: "slop[bot]"');
    expect(readiness({ ...ready, claudeAllowsSlop: null }).find((i) => i.key === 'claude_workflow')).toMatchObject({ state: 'ok' });
    expect(readiness({ ...ready, slopBot: null, claudeAllowsSlop: false }).find((i) => i.key === 'claude_workflow')).toMatchObject({ state: 'ok' });
  });

  it('reads allowed_bots from a workflow', () => {
    const wf = (line: string) => `steps:\n  - uses: anthropics/claude-code-action@v1\n    with:\n      ${line}\n`;
    expect(allowsBot(wf('allowed_bots: "slop[bot]"'), 'slop[bot]')).toBe(true);
    expect(allowsBot(wf("allowed_bots: 'dependabot[bot], Slop[bot]' # slop"), 'slop[bot]')).toBe(true);
    expect(allowsBot(wf('allowed_bots: slop'), 'slop[bot]')).toBe(true);
    expect(allowsBot(wf('allowed_bots: "*"'), 'slop[bot]')).toBe(true);
    expect(allowsBot(wf('allowed_bots: "other[bot]"'), 'slop[bot]')).toBe(false);
    expect(allowsBot(wf('allowed_bots: ""'), 'slop[bot]')).toBe(false);
    expect(allowsBot(wf('# allowed_bots: slop[bot]'), 'slop[bot]')).toBe(false);
    expect(allowsBot('steps: []', 'slop[bot]')).toBe(false);
  });

  it('names the missing workflow when checks failed and the run has not reacted', () => {
    const claudeApp = readiness({ ...ready, claudeWorkflow: false, unreactedCheckFailures: ['s1t1'] }).find((i) => i.key === 'claude_app');
    expect(claudeApp?.detail).toMatch(/no Claude workflow/);
  });
});

describe('board readiness', () => {
  it('is all ok for a board with everything set up', () => {
    expect(Object.values(stateOf(ready)).every((s) => s === 'ok')).toBe(true);
  });

  it('says what is missing, with a fix', () => {
    const items = readiness({
      ...ready,
      repoConnected: false,
      installUrl: 'https://github.com/apps/slop/installations/new?state=1',
      subGateWorkflow: false,
      committedAgentSetVersion: 2,
      hasBuildDoc: false,
      board: { ...ready.board, environments: [{ name: 'dev', allowBranchDeploy: true }] },
      ticks: {},
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.repo_app).toMatchObject({ state: 'missing', fix: { kind: 'link', href: 'https://github.com/apps/slop/installations/new?state=1' } });
    expect(byKey.sub_gate?.fix).toMatchObject({ kind: 'link', href: 'https://github.com/acme/app/new/main?filename=.github/workflows/sub-gate.yml' });
    expect(byKey.agent_set?.detail).toMatch(/version 2; the board's is 3/);
    expect(byKey.build_doc).toMatchObject({ state: 'missing', fix: { kind: 'knowledge' } });
    expect(byKey.environments?.detail).toMatch(/default for subs/);
    expect(items.filter((i) => i.manual).map((i) => i.state)).toEqual(['missing', 'missing', 'missing']);
  });

  it('marks unknown what slop cannot check yet', () => {
    const states = stateOf({ ...ready, repoConnected: null, subGateWorkflow: null, committedAgentSetVersion: 'unknown' });
    expect(states.repo_app).toBe('unknown');
    expect(states.sub_gate).toBe('unknown');
    expect(states.agent_set).toBe('unknown');
  });

  it('says an invalid agent-set file needs re-running slop init', () => {
    const item = readiness({ ...ready, committedAgentSetVersion: 'unreadable' }).find((i) => i.key === 'agent_set');
    expect(item).toMatchObject({ state: 'missing' });
    expect(item?.detail).toMatch(/isn't valid: run slop init 1/);
  });

  it('turns a ticked item red when a recent routine failure points to it', () => {
    const items = readiness({
      ...ready,
      recentFailures: [{ globId: 's1t9', reason: 'remote: Repository not found.' }],
    });
    const repo = items.find((i) => i.key === 'routine_repo');
    expect(repo).toMatchObject({ state: 'failing' });
    expect(repo?.detail).toMatch(/s1t9 failed.*Add the repo to the routine's repositories/);
  });

  it("maps routine failures to their fix", () => {
    expect(routineFailureFix('HttpError: Resource not accessible by integration')?.key).toBe('claude_app');
    expect(routineFailureFix('fatal: could not read from remote repository')?.key).toBe('routine_repo');
    expect(routineFailureFix('Routine fire failed: 401')?.key).toBe('routines');
    expect(routineFailureFix('Tests failed')).toBeNull();
  });

  it('keeps recent failures only, newest first', () => {
    const failed = (id: string, at: string) => glob({ id, failure: { reason: id, at } });
    const list = recentRoutineFailures(
      [failed('old', '2026-09-01T00:00:00.000Z'), failed('a', '2026-10-04T00:00:00.000Z'), failed('b', '2026-10-05T00:00:00.000Z'), glob()],
      '2026-09-28T00:00:00.000Z',
    );
    expect(list.map((f) => f.globId)).toEqual(['b', 'a']);
  });
});

describe('stuck hints on cards', () => {
  const later = new Date(Date.parse(NOW) + 20 * 60_000).toISOString();
  const head = 'abc1234';
  const sub = (patch: Parameters<typeof glob>[0]) =>
    glob({ type: 'sub', status: 'pr_open', updatedAt: NOW, pr: { number: 3, state: 'ready', headSha: head }, ...patch });

  it('flags a ready sub with no gate result after a while', () => {
    expect(stuckHint(sub({ headChecks: null }), later)).toMatch(/No sub-gate result/);
    expect(stuckHint(sub({ headChecks: null }), NOW)).toBeNull();
  });

  it('flags a passed gate that has not merged', () => {
    expect(stuckHint(sub({ headChecks: { sha: head, state: 'passed' } }), later)).toMatch(/passed but slop hasn't merged/);
  });

  it('says which glob caused a conflict, and suggests resolving locally when needed', () => {
    const conflict = { base: 'main', files: ['a.ts', 'b.ts'], since: 's1t2', at: NOW };
    const open = sub({ status: 'in_progress', conflict });
    expect(stuckHint(open, NOW)).toBe('Conflicts with main since s1t2 merged: a.ts, b.ts');
    expect(stuckHint(sub({ conflict: { ...conflict, since: null, files: [] } }), NOW)).toBe('Conflicts with main');
    // Asked the Claude GitHub App, and the PR still conflicts later.
    const asked = sub({ conflict: { ...conflict, requestedAt: NOW } });
    expect(stuckHint(asked, NOW)).not.toMatch(/Resolve locally/);
    expect(stuckHint(asked, later)).toMatch(/Resolve locally: sstor --glob s1t1 --resolve/);
    // A human implementer resolves locally from the start; a cleared conflict shows nothing.
    expect(stuckHint(sub({ conflict, implementer: 'dev@example.com' }), NOW)).toMatch(/Resolve locally/);
    expect(stuckHint(sub({ conflict: null }), NOW)).toBeNull();
  });

  it('shows the fix for a known routine failure, and nothing for ordinary globs', () => {
    expect(stuckHint(glob({ failure: { reason: 'Repository not found', at: NOW } }), later)).toMatch(/routine's repositories/);
    expect(stuckHint(glob({ status: 'in_progress' }), later)).toBeNull();
  });
});

describe('watching run that ignores failed checks', () => {
  const failedAt = '2026-09-30T10:00:00.000Z';
  const at = (min: number) => new Date(Date.parse(failedAt) + min * 60_000).toISOString();
  const head = 'abc1234';
  const run = (patch: Partial<ReturnType<typeof glob>['runs'][number]> = {}) => ({
    id: 'r1', state: 'watching' as const, outcome: null, generation: 1, triggeredBy: 'a', routineOwner: 'a',
    queuedAt: failedAt, startedAt: failedAt, lastProgressAt: failedAt, endedAt: null, failureReason: null,
    sessionId: 's', sessionUrl: 'https://claude.ai/code/s', ...patch,
  });
  const watched = (patch: Parameters<typeof glob>[0] = {}) =>
    glob({
      id: 's1t1', type: 'sub', status: 'pr_open', pr: { number: 3, state: 'ready', headSha: head },
      headChecks: { sha: head, state: 'failed', at: failedAt }, runs: [run()], ...patch,
    });

  it('hints with the take-over and session fixes after 15 minutes', () => {
    expect(stuckHint(watched(), at(14))).toBeNull();
    const hint = stuckHint(watched(), at(16));
    expect(hint).toMatch(/Checks failed on the head 16 minutes ago/);
    expect(hint).toContain('sstor --glob s1t1 --take-over');
    expect(hint).toContain('https://claude.ai/code/s');
  });

  it('applies to a same too', () => {
    expect(stuckHint(watched({ type: 'same' }), at(20))).toMatch(/Checks failed/);
  });

  it('clears on a push, run progress, run end or checks that pass', () => {
    expect(stuckHint(watched({ type: 'same', headChecks: null }), at(20))).toBeNull();
    expect(stuckHint(watched({ type: 'same', runs: [run({ lastProgressAt: at(10) })] }), at(20))).toBeNull();
    expect(stuckHint(watched({ type: 'same', runs: [run({ state: 'ended', outcome: 'failed' })] }), at(20))).toBeNull();
    expect(stuckHint(watched({ type: 'same', headChecks: { sha: head, state: 'passed' } }), at(20))).toBeNull();
    expect(stuckHint(watched({ type: 'same', headChecks: { sha: 'old', state: 'failed', at: failedAt } }), at(20))).toBeNull();
  });

  it('counts toward the Claude GitHub App readiness item', () => {
    expect(unreactedCheckFailures([watched(), watched({ id: 's1t2', headChecks: null })], at(20))).toEqual(['s1t1']);
    const items = readiness({ ...ready, unreactedCheckFailures: ['s1t1'] });
    expect(items.find((i) => i.key === 'claude_app')).toMatchObject({ state: 'failing' });
  });
});

describe('runs that never start', () => {
  const g = (patch = {}) => glob({ status: 'implementing', runs: [run({ state: 'queued', queuedAt: NOW, startedAt: null, sessionUrl: 'https://claude.ai/code/s1' })], ...patch });
  const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

  it('says how long a run has been queued once it passes 10 minutes, with the session', () => {
    expect(queuedRunNotice(g(), at(9))).toBeNull();
    expect(queuedRunNotice(g(), at(25))).toBe('Routine run queued for 25 min: open the session https://claude.ai/code/s1');
    expect(queuedRunNotice(g({ runs: [run({ state: 'active' })] }), at(25))).toBeNull();
  });

  it('counts runs that never started toward the routines item only when it repeats', () => {
    const facts = (n: number): ReadinessFacts => ({
      ...ready,
      recentFailures: Array.from({ length: n }, (_, i) => ({ globId: `s1t${String(i + 1)}`, reason: 'Routine run never started (queued at 2026-10-07 02:01 UTC)' })),
    });
    expect(stateOf(facts(1)).routines).toBe('ok');
    expect(stateOf(facts(2)).routines).toBe('failing');
    expect(readiness(facts(2)).find((i) => i.key === 'routines')?.detail).toMatch(/2 routine runs never started \(latest s1t1\)/);
  });
});

describe('the behind-main warning', () => {
  const pr = { number: 3, state: 'draft' as const, headSha: 'abc1234' };
  const behind = { base: 'main', behindBy: 4, files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], at: NOW };
  const doing = (patch: Parameters<typeof glob>[0] = {}) => glob({ status: 'in_progress', pr, behind, ...patch });

  it('says how many merges main is ahead by and how many files both sides changed', () => {
    expect(behindWarning(doing())).toBe('main is 4 merges ahead; 6 files changed on both sides');
    expect(behindWarning(doing({ behind: { ...behind, behindBy: 1, files: ['a.ts'] } }))).toBe('main is 1 merge ahead; 1 file changed on both sides');
    expect(behindWarning(doing({ behind: { ...behind, files: [] } }))).toBe('main is 4 merges ahead; no files changed on both sides');
  });

  it('shows nothing when up to date, outside Doing, or once a conflict says more', () => {
    expect(behindWarning(doing({ behind: null }))).toBeNull();
    expect(behindWarning(doing({ behind: { ...behind, behindBy: 0 } }))).toBeNull();
    expect(behindWarning(doing({ status: 'pr_open' }))).toBeNull();
    expect(behindWarning(doing({ conflict: { base: 'main', files: [], since: null, at: NOW } }))).toBeNull();
  });
});

describe('GitHub App events readiness', () => {
  const item = (appEvents: ReadinessFacts['appEvents']) => readiness({ ...ready, appEvents }).find((i) => i.key === 'app_events');

  it('is ok when the App has every required event', () => {
    expect(item({ missing: [], settingsUrl: 'u' })).toMatchObject({ state: 'ok', manual: false });
  });

  it('names the missing events and links the settings page', () => {
    const missing = item({ missing: ['pull_request_review', 'pull_request_review_comment'], settingsUrl: 'https://github.com/settings/apps/slop/permissions' });
    expect(missing).toMatchObject({ state: 'missing', fix: { kind: 'link', href: 'https://github.com/settings/apps/slop/permissions' } });
    expect(missing?.detail).toContain('pull_request_review, pull_request_review_comment');
  });

  it('is unknown when the App settings could not be read', () => {
    expect(item(null)).toMatchObject({ state: 'unknown' });
  });

  it('compares the lists and picks the settings page by owner type', () => {
    expect(missingAppEvents(['push', 'issue_comment', 'check_run'], ['push', 'check_run', 'star'])).toEqual(['issue_comment']);
    expect(missingAppEvents(['push'], ['push'])).toEqual([]);
    expect(appSettingsUrl('slop', { login: 'me', type: 'User' })).toBe('https://github.com/settings/apps/slop/permissions');
    expect(appSettingsUrl('slop', { login: 'acme', type: 'Organization' })).toBe('https://github.com/organizations/acme/settings/apps/slop/permissions');
  });
});

import { describe, expect, it } from 'vitest';
import { appSettingsUrl, behindWarning, missingAppEvents, queuedRunNotice, readiness, readinessNotifications, runsClaudeAction, allowsBot, recentRoutineFailures, routineFailureFix, stuckHint, unreactedCheckFailures } from '../src/domain/readiness.js';
import type { ReadinessFacts } from '../src/domain/readiness.js';
import { buildLogAccessOf } from '../src/domain/deploys.js';
import { NOW, board, glob, run } from './fixtures.js';

const ready: ReadinessFacts = {
  board: {
    ...board,
    environments: [
      { name: 'dev', allowBranchDeploy: true },
      { name: 'prod', allowBranchDeploy: false },
    ],
    agentSetVersion: 3,
  },
  repoConnected: true,
  installUrl: null,
  gateCheck: 'checks',
  checksWorkflow: true,
  branchRules: { requiredChecks: ['checks'], integrationBypasses: true },
  claudeWorkflow: true,
  slopBot: 'slop[bot]',
  claudeAllowsSlop: true,
  appEvents: { missing: [], settingsUrl: 'https://github.com/settings/apps/slop/permissions' },
  committedAgentSetVersion: 3,
  unregisteredHooks: [],
  missingCoreAreas: [],
  ticks: { routines: true, routine_repo: true, claude_app: true },
  recentFailures: [],
  unreactedCheckFailures: [],
  buildLogs: { outcome: 'read', group: '/aws/codebuild/deploy', reason: null, at: NOW },
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

  it("doesn't ask the workflow to allow slop's App: conflict fixes run as routines", () => {
    expect(readiness({ ...ready, claudeAllowsSlop: false }).find((i) => i.key === 'claude_workflow')).toMatchObject({ state: 'ok' });
    expect(readiness({ ...ready, claudeAllowsSlop: null }).find((i) => i.key === 'claude_workflow')).toMatchObject({ state: 'ok' });
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
    const claudeApp = readiness({ ...ready, claudeWorkflow: false, unreactedCheckFailures: [{ id: 's1t1', sha: 'abcdef123', url: null }] }).find((i) => i.key === 'claude_app');
    expect(claudeApp?.detail).toMatch(/no Claude workflow/);
  });
});

describe('branch rules readiness', () => {
  const detail = (branchRules: ReadinessFacts['branchRules']) => readiness({ ...ready, branchRules }).find((i) => i.key === 'sub_gate');

  it('says the gate is required and the App bypasses', () => {
    const item = detail({ requiredChecks: ['checks'], integrationBypasses: true });
    expect(item?.state).toBe('ok');
    expect(item?.detail).toMatch(/required status check on main, and slop's App can bypass/);
  });

  it('points to the setup command when the gate is not required', () => {
    expect(detail({ requiredChecks: ['lint'], integrationBypasses: null })?.detail).toMatch(/not a required status check on main: run catalog\/scripts\/setup-repo\.sh acme\/app .*--protect checks/);
  });

  it("warns when the App can't bypass", () => {
    expect(detail({ requiredChecks: ['checks'], integrationBypasses: false })?.detail).toMatch(/App can't bypass/);
  });

  it('stays quiet about bypass when the list is not visible, and asks for setup when rules are unreadable', () => {
    expect(detail({ requiredChecks: ['checks'], integrationBypasses: null })?.detail).not.toMatch(/bypass/);
    expect(detail(null)?.detail).toMatch(/can't read the branch's rules yet/);
  });
});

describe('board readiness', () => {
  it('is all ok for a board with everything set up', () => {
    expect(Object.values(stateOf(ready)).every((s) => s === 'ok')).toBe(true);
  });

  it("names a board's own gate check and the workflow that reports it", () => {
    const item = readiness({ ...ready, gateCheck: 'sub-gate', checksWorkflow: false }).find((i) => i.key === 'sub_gate');
    expect(item?.detail).toMatch(/\.github\/workflows\/sub-gate\.yml \(reporting `sub-gate`\)/);
    expect(item?.fix).toMatchObject({ href: 'https://github.com/acme/app/new/main?filename=.github/workflows/sub-gate.yml' });
    const odd = readiness({ ...ready, gateCheck: 'CI / checks', checksWorkflow: false }).find((i) => i.key === 'sub_gate');
    expect(odd?.fix).toMatchObject({ href: 'https://github.com/acme/app/new/main?filename=.github/workflows/checks.yml' });
  });

  it('says what is missing, with a fix', () => {
    const items = readiness({
      ...ready,
      repoConnected: false,
      installUrl: 'https://github.com/apps/slop/installations/new?state=1',
      checksWorkflow: false,
      committedAgentSetVersion: 2,
      missingCoreAreas: ['build', 'architecture'],
      board: { ...ready.board, environments: [{ name: 'dev', allowBranchDeploy: true }] },
      ticks: {},
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.repo_app).toMatchObject({ state: 'missing', fix: { kind: 'link', href: 'https://github.com/apps/slop/installations/new?state=1' } });
    expect(byKey.sub_gate?.fix).toMatchObject({ kind: 'link', href: 'https://github.com/acme/app/new/main?filename=.github/workflows/checks.yml' });
    expect(byKey.sub_gate).toMatchObject({ title: 'Checks workflow', state: 'missing' });
    expect(byKey.sub_gate?.detail).toMatch(/`checks`/);
    expect(byKey.agent_set?.detail).toMatch(/version 2; the board's is 3/);
    expect(byKey.build_doc).toMatchObject({ state: 'missing', fix: { kind: 'knowledge' } });
    expect(byKey.architecture_doc).toMatchObject({ state: 'missing', fix: { kind: 'knowledge' } });
    expect(byKey.architecture_doc?.detail).toMatch(/No architecture document\. Run `\/kb-bootstrap \d+`/);
    expect(byKey.conventions_doc?.state).toBe('ok');
    expect(byKey.environments).toMatchObject({ state: 'ok', detail: 'dev' });
    expect(items.filter((i) => i.manual).map((i) => i.state)).toEqual(['missing', 'missing', 'missing']);
  });

  it("reports whether slop can read failed builds' logs, with the missing grant and its fix", () => {
    const logs = (facts: Partial<ReadinessFacts>) => readiness({ ...ready, ...facts }).find((i) => i.key === 'build_logs');
    expect(logs({})).toMatchObject({ title: 'Build logs readable', state: 'ok', manual: false });
    expect(logs({ buildLogs: null })).toMatchObject({ state: 'unknown' });
    const denied = logs({ buildLogs: { outcome: 'denied', group: '/aws/codebuild/deploy', reason: "slop's role may not read /aws/codebuild/deploy (needs logs:GetLogEvents)", at: NOW } });
    expect(denied).toMatchObject({ state: 'failing' });
    expect(denied?.detail).toContain("slop's role can't read /aws/codebuild/deploy");
    expect(denied?.detail).toContain('logs:GetLogEvents on /aws/codebuild/deploy:*');
    expect(denied?.detail).toContain('run infra/deploy/host-deploy.sh');
    // A fix link to the grant's how-to, and the item says it clears by itself on the next read.
    expect(denied?.fix?.kind === 'link' ? denied.fix.href : null).toContain('infra/deploy/README.md');
    expect(denied?.detail).toContain('This clears on the next failed build whose log slop reads');
    // The latest outcome wins: a read after the refusal turns the item ok.
    const reread = buildLogAccessOf([
      { type: 'BuildLogRead', globId: 's1t1', actor: 'slop', at: NOW, data: { outcome: 'denied', group: '/aws/codebuild/deploy', reason: 'no' } },
      { type: 'BuildLogRead', globId: 's1t1', actor: 'slop', at: NOW, data: { outcome: 'read', group: '/aws/codebuild/deploy', reason: null } },
    ]);
    expect(logs({ buildLogs: reread })).toMatchObject({ state: 'ok', fix: null });
    // Only boards that deploy with CodeBuild have build logs to read.
    expect(logs({ board: { ...ready.board, deploy: null } })).toBeUndefined();
    expect(logs({ board: { ...ready.board, deploy: { provider: 'github_actions', workflow: 'slop-deploy.yml' } } })).toBeUndefined();
  });

  it("names every deploy project's log group in the missing grant (s15t273)", () => {
    const items = readiness({
      ...ready,
      board: { ...ready.board, deploy: { provider: 'codebuild', region: 'us-east-1', projects: { dev: 'deploy-dev', dev2: 'deploy-dev2' } } },
      buildLogs: { outcome: 'denied', group: null, reason: null, at: NOW },
    });
    const detail = items.find((i) => i.key === 'build_logs')?.detail;
    expect(detail).toContain("slop's role can't read the build's log group, so failed builds keep only the link");
    expect(detail).toContain('logs:GetLogEvents on /aws/codebuild/deploy-dev:*, /aws/codebuild/deploy-dev2:*');
  });

  it('raises a failing build-logs item as a warning notification', () => {
    const items = readiness({ ...ready, buildLogs: { outcome: 'denied', group: '/aws/codebuild/deploy', reason: null, at: NOW } });
    expect(readinessNotifications(1, 'acme', items)).toContainEqual(
      expect.objectContaining({ source: 'readiness:build_logs', severity: 'warning', title: 'acme: Build logs readable is failing' }),
    );
  });

  it('marks unknown what slop cannot check yet', () => {
    const states = stateOf({ ...ready, repoConnected: null, checksWorkflow: null, committedAgentSetVersion: 'unknown' });
    expect(states.repo_app).toBe('unknown');
    expect(states.sub_gate).toBe('unknown');
    expect(states.agent_set).toBe('unknown');
  });

  it('flags a hook script the committed settings do not register', () => {
    const unregistered = readiness({ ...ready, unregisteredHooks: ['.claude/hooks/pre_push_checks.sh'] }).find((i) => i.key === 'agent_set');
    expect(unregistered?.state).toBe('missing');
    expect(unregistered?.detail).toContain('Hook .claude/hooks/pre_push_checks.sh is installed but not registered');
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
    expect(stuckHint(sub({ headChecks: null }), later)).toMatch(/No `checks` result after 15 minutes: is \.github\/workflows\/checks\.yml/);
    expect(stuckHint(sub({ headChecks: null }), later, 'sub-gate')).toMatch(/No `sub-gate` result .*sub-gate\.yml/);
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
    // A conflict-fixing run gave up and the PR still conflicts: a person takes over.
    const gaveUp = {
      id: 'r1', state: 'ended' as const, outcome: 'failed' as const, generation: 1, triggeredBy: 'a', routineOwner: 'a',
      queuedAt: NOW, startedAt: NOW, lastProgressAt: NOW, endedAt: NOW, failureReason: 'x', sessionId: null, sessionUrl: null,
      purpose: 'resolve_conflict' as const,
    };
    expect(stuckHint(sub({ conflict, runs: [{ ...gaveUp, state: 'watching', outcome: null }] }), later)).not.toMatch(/Resolve locally/);
    expect(stuckHint(sub({ conflict, runs: [gaveUp] }), NOW)).toMatch(/Resolve locally: sstor --glob s1t1/);
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
      headChecks: { sha: head, state: 'failed', at: failedAt, failure: { name: 'checks', step: null, lines: ['error'], url: 'https://ci/run/1' } }, runs: [run()], ...patch,
    });

  it('hints with the take-over and session fixes after 15 minutes', () => {
    expect(stuckHint(watched(), at(14))).toBeNull();
    const hint = stuckHint(watched(), at(16));
    expect(hint).toMatch(/Checks failed on the head 16 minutes ago/);
    expect(hint).toContain('sstor --glob s1t1');
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
    expect(unreactedCheckFailures([watched(), watched({ id: 's1t2', headChecks: null })], at(20))).toEqual([{ id: 's1t1', sha: head, url: 'https://ci/run/1' }]);
    const items = readiness({ ...ready, unreactedCheckFailures: [{ id: 's1t1', sha: head, url: 'https://ci/run/1' }] });
    expect(items.find((i) => i.key === 'claude_app')).toMatchObject({ state: 'failing', });
    expect(items.find((i) => i.key === 'claude_app')?.detail).toContain('https://ci/run/1');
  });

  it('ignores a conflict recorded as empty failed checks, and failures with no detail', () => {
    const conflict = { base: 'main', files: ['a.ts'], since: null, at: failedAt };
    const empty = { sha: head, state: 'failed' as const, at: failedAt };
    expect(unreactedCheckFailures([watched({ conflict, headChecks: empty })], at(20))).toEqual([]);
    expect(stuckHint(watched({ conflict, headChecks: empty }), at(20))).not.toMatch(/Checks failed/);
    expect(unreactedCheckFailures([watched({ headChecks: empty })], at(20))).toEqual([]);
    expect(unreactedCheckFailures([watched()], at(10))).toEqual([]);
  });
});

describe('runs that never start', () => {
  const g = (patch = {}) => glob({ status: 'implementing', runs: [run({ state: 'queued', queuedAt: NOW, startedAt: null, sessionUrl: 'https://claude.ai/code/s1' })], ...patch });
  const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

  it('says how long a run has been queued once it passes 10 minutes, with the session', () => {
    expect(queuedRunNotice(g(), at(9))).toBeNull();
    expect(queuedRunNotice(g(), at(25))).toBe('Machine run queued for 25 min: open the session https://claude.ai/code/s1');
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

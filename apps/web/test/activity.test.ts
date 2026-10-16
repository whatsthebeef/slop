import { describe, expect, it } from 'vitest';
import { ACTIVITY_SHOWN, activityOf } from '@slop/core';
import type { GlobView } from '../src/lib/api';
import { glob as coreGlob } from '../../../packages/core/test/fixtures';

const T = (m: number): string => new Date(Date.UTC(2026, 9, 13, 12, m)).toISOString();
const run = (id: string, over: Partial<GlobView['runs'][number]> = {}): GlobView['runs'][number] => ({
  id,
  state: 'ended',
  outcome: 'completed',
  generation: 1,
  triggeredBy: 'a',
  routineOwner: 'a',
  queuedAt: T(0),
  startedAt: T(1),
  lastProgressAt: T(2),
  endedAt: T(3),
  failureReason: null,
  sessionId: null,
  sessionUrl: 'https://claude.ai/code/x',
  ...over,
});
const view = (over: Partial<GlobView> = {}): GlobView =>
  ({ ...coreGlob(), list: 'doing', branch: 's1t1', currentRun: null, updatedAt: T(30), createdAt: T(0), ...over });

describe('activityOf', () => {
  it('shows who planned the glob with the creation date', () => {
    const created = activityOf(view({ planner: 'p@b.c', creator: 'c@b.c' }), 'o/r').find((e) => e.id === 'created');
    expect(created?.text).toBe(`Planned by p@b.c · ${new Date(T(0)).toLocaleString()}`);
  });
  it('lists who picked it up, took it over and handed it to the machine, with when', () => {
    const entries = activityOf(
      view({
        handoffs: [
          { kind: 'picked_up', by: 'john.bower@x.com', at: T(5) },
          { kind: 'took_over', by: 'ana.silva@x.com', at: T(10) },
          { kind: 'handed_back', by: 'ana.silva@x.com', at: T(15) },
        ],
      }),
      'o/r',
    );
    const handoffs = entries.filter((e) => e.id.startsWith('handoff:'));
    expect(handoffs.map((e) => [e.text, e.at, e.actor])).toEqual([
      ['Ana handed it to the machine', T(15), 'human'],
      ['Ana took it over from the routine run', T(10), 'human'],
      ['John picked it up', T(5), 'human'],
    ]);
    expect(handoffs[2]?.title).toBe('John picked it up (john.bower@x.com)');
  });
  it('lists runs, the PR, checks and a conflict newest first, each with its link', () => {
    const entries = activityOf(
      view({
        runs: [run('r1', { outcome: 'failed', failureReason: 'boom\nsecond line' })],
        pr: { number: 7, state: 'ready', headSha: 'abcdef1234' },
        headChecks: { sha: 'abcdef1234', state: 'failed', at: T(20), failure: { name: 'Lint', step: 'eslint', lines: ['err'], url: 'https://ci/1' } },
        conflict: { base: 'main', files: ['a.ts'], since: 's1t9', at: T(25) },
      }),
      'o/r',
    );
    const texts = entries.map((e) => e.text);
    // The PR line says what is true of the PR: a conflict and failed checks mean it is not ready for review.
    expect(texts).toContain('PR #7 conflicts with main · s1t1');
    expect(texts.some((text) => text.includes('ready for review'))).toBe(false);
    expect(texts).toContain('Conflict with main after s1t9');
    expect(texts).toContain('Checks failed on abcdef1');
    expect(texts).toContain('Run failed: boom');
    expect(entries.find((e) => e.id.startsWith('pr:7:'))?.link).toBe('https://github.com/o/r/pull/7');
    const checks = entries.find((e) => e.text === 'Checks failed on abcdef1');
    expect(checks).toMatchObject({ link: 'https://ci/1', linkLabel: 'CI run' });
    expect(checks?.title).toContain('Lint · eslint');
    const failed = entries.find((e) => e.text === 'Run failed: boom');
    expect(failed?.title).toBe('Run failed: boom\nsecond line');
    expect(failed).toMatchObject({ link: 'https://claude.ai/code/x', linkLabel: 'session' });
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort().reverse());
  });

  it('shows a failure reason as plain text, with no Markdown markers in the line or the tooltip', () => {
    const entries = activityOf(view({ runs: [run('r1', { outcome: 'failed', failureReason: 'Checks failed on `main`: **lint**\nsee `a.ts`' })] }), 'o/r');
    const failed = entries.find((e) => e.text.startsWith('Run failed'));
    expect(failed?.text).toBe('Run failed: Checks failed on main: lint');
    expect(failed?.title).toBe('Run failed: Checks failed on main: lint\nsee a.ts');
  });

  it('collapses consecutive identical events', () => {
    const entries = activityOf(view({ runs: [run('r1'), run('r2', { queuedAt: T(5), startedAt: T(6), endedAt: T(8) })] }), null);
    const started = entries.filter((e) => e.text === 'Run started');
    expect(started.reduce((n, e) => n + e.count, 0)).toBe(2);
    const same = activityOf(view({ pr: null, runs: [run('a', { state: 'watching', outcome: null, endedAt: null, startedAt: T(1) }), run('b', { state: 'watching', outcome: null, endedAt: null, startedAt: T(2) })] }), null);
    expect(same.filter((e) => e.text === 'Run on standby')).toHaveLength(2);
    const collapsedStart = activityOf(view({ pr: null, runs: [run('a', { state: 'queued', outcome: null, endedAt: null, startedAt: T(1) }), run('b', { state: 'queued', outcome: null, endedAt: null, startedAt: T(2) })] }), null);
    expect(collapsedStart.find((e) => e.text === 'Run started')?.count).toBe(2);
  });

  it('is longer than the shown limit when many runs piled up, and cuts a long reason to one line', () => {
    const many = Array.from({ length: 6 }, (_, i) => run(`r${String(i)}`, { outcome: 'failed', failureReason: 'x\n'.repeat(9), startedAt: T(i * 2), endedAt: T(i * 2 + 1) }));
    const entries = activityOf(view({ runs: many }), null);
    expect(entries.length).toBeGreaterThan(ACTIVITY_SHOWN);
    expect(entries.every((e) => !e.text.includes('\n') && e.text.length <= 100)).toBe(true);
    const long = activityOf(view({ runs: [run('l', { outcome: 'failed', failureReason: 'y'.repeat(300) })] }), null);
    expect(long.find((e) => e.id === 'run:l:end')?.title).toContain('y'.repeat(300));
  });

  it('lists machine steps as ordinary one-line entries with their link, and drops finished ones', () => {
    const at = T(10);
    const entries = activityOf(
      view(),
      null,
      [
        { id: 'a', kind: 'resolve_conflict', state: 'running', startedAt: at, lastProgressAt: at, detail: 'https://claude.ai/code/s', holdsBall: true },
        { id: 'b', kind: 'fix_checks', state: 'failed', startedAt: T(11), lastProgressAt: null, detail: 'merge conflict', holdsBall: true },
        { id: 'c', kind: 'merge', state: 'done', startedAt: T(12), lastProgressAt: null, detail: null, holdsBall: false },
      ],
    );
    expect(entries.find((e) => e.id === 'step:a')).toMatchObject({ text: 'fixing the conflict · running', actor: 'machine', link: 'https://claude.ai/code/s', linkLabel: 'session' });
    expect(entries.find((e) => e.id === 'step:b')).toMatchObject({ text: 'fixing CI · failed: merge conflict', link: null });
    expect(entries.some((e) => e.id === 'step:c')).toBe(false);
  });

  it('leaves out the failure and the escalation, which are pinned or have their own chip', () => {
    const entries = activityOf(
      view({ failure: { reason: 'Nope', at: T(10) }, escalation: { reason: 'Auth', by: 'a', at: T(11) } }),
      null,
    );
    expect(entries.map((e) => e.text).join('|')).not.toMatch(/Nope|Auth/);
  });
});

describe('Continue locally on the current run', () => {
  const live = run('r1', { state: 'active', outcome: null, endedAt: null, routineOwner: 'Me@x.com' });
  const start = (email?: string) =>
    activityOf(view({ id: 's1t1', runs: [live], currentRun: live }), 'o/r', [], email).find((e) => e.id === 'run:r1:start');
  it('shows Open in Claude with the session link, and the command only for the routine owner', () => {
    expect(start('me@x.com')).toMatchObject({ linkLabel: 'Open in Claude', link: 'https://claude.ai/code/x', command: 'sstor --glob s1t1' });
    expect(start('other@x.com')).toMatchObject({ linkLabel: 'Open in Claude', command: null });
    expect(start()?.command).toBeNull();
  });
  it('offers no command without a session URL or once the run ended', () => {
    const noSession = { ...live, sessionUrl: null };
    expect(activityOf(view({ runs: [noSession], currentRun: noSession }), 'o/r', [], 'me@x.com').find((e) => e.id === 'run:r1:start')?.command).toBeNull();
    const ended = run('r1', { routineOwner: 'me@x.com' });
    expect(activityOf(view({ runs: [ended], currentRun: ended }), 'o/r', [], 'me@x.com').find((e) => e.id === 'run:r1:start')?.command).toBeNull();
  });
  it('keeps a failed merge as a warn entry, once per failure', () => {
    const failure = { reason: 'conflicts\nmore', at: T(12), kind: 'merge' as const };
    const entries = activityOf(view({ failure }), 'o/r');
    const merge = entries.filter((e) => e.id.startsWith('failure:'));
    expect(merge).toHaveLength(1);
    expect(merge[0]).toMatchObject({ text: 'Merge failed: conflicts', actor: 'warn', at: T(12) });
  });
});

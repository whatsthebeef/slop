import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { collapsed, dismissible, handoverKey, isDismissed, shortLabel, statusKey, stepKey, turnKey } from '../src/lib/dismissals';
import { statusLine } from '../src/lib/status-line';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const failed = (at = NOW, patch: Partial<GlobView> = {}) =>
  view({ status: 'failed', failure: { reason: 'Could not reproduce the bug: the whole paragraph', at }, ...patch });
const lineOf = (g: GlobView) => {
  const line = statusLine(g, NOW);
  if (line === null) throw new Error('no status line');
  return line;
};
const brief = { why: ['Conflicts with main.'], next: 'Merge main.', detail: ['CI: x'] };

describe('message keys', () => {
  it('failure: keyed by failure.at, stable across reads and wording', () => {
    const key = statusKey(failed(), lineOf(failed()));
    expect(key).toBe(`failure:${NOW}`);
    expect(statusKey(failed(), lineOf(failed()))).toBe(key);
    expect(statusKey(failed(NOW, { failure: { reason: 'Different words', at: NOW } }), lineOf(failed()))).toBe(key);
  });

  it('a new failure has a new key', () => {
    const later = '2026-10-09T09:00:00.000Z';
    expect(statusKey(failed(later), lineOf(failed(later)))).not.toBe(statusKey(failed(), lineOf(failed())));
  });

  it('conflict: keyed by conflict.at; stall: by the hint and the PR head', () => {
    const conflict = { base: 'main', files: ['a.ts'], since: null, at: NOW };
    const g = view({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'd16d563aaaa' }, conflict });
    expect(statusKey(g, lineOf(g))).toBe(`conflict:${NOW}`);
    const stalled = view({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'd16d563aaaa' }, move: { holder: 'stalled', reason: 'run failed', since: NOW, cause: 'failed' } });
    expect(statusKey(stalled, { ...lineOf(failed()), kind: 'stuck', conflict: undefined })).toMatch(/^stall:\w+:d16d563aaaa:$/);
  });

  it('stall: the card (list view with move) and the single glob view (no move) share one key', () => {
    const base = { status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'd16d563aaaa' } } as const;
    const onCard = view({ ...base, move: { holder: 'stalled', reason: 'run failed', since: NOW, cause: 'failed' } });
    const inView = view({ ...base });
    const line = { ...lineOf(failed()), kind: 'stuck' as const, conflict: undefined };
    expect(statusKey(inView, line)).toBe(statusKey(onCard, line));
    // The same wording after a new run is a new episode.
    const again = view({ ...base, runs: [run({ id: 'run-2' })] });
    expect(statusKey(again, line)).not.toBe(statusKey(inView, line));
  });

  it('handover: by its causes and first step; step: by id and state; turn: by move', () => {
    expect(handoverKey(brief)).toBe(handoverKey({ ...brief, detail: [] }));
    expect(handoverKey(brief)).not.toBe(handoverKey({ ...brief, next: 'Else.' }));
    expect(stepKey({ id: 'h1', state: 'due' })).not.toBe(stepKey({ id: 'h1', state: 'done' }));
    expect(turnKey({ reason: 'Merge', since: NOW })).toBe(turnKey({ reason: 'Merge', since: NOW }));
    expect(turnKey({ reason: 'Merge', since: NOW })).not.toBe(turnKey({ reason: 'Deploy', since: NOW }));
  });
});

describe('collapse', () => {
  it('collapses to the short label for the viewer who dismissed it, and the long text is unchanged underneath', () => {
    const g = failed();
    const line = lineOf(g);
    const key = statusKey(g, line);
    expect(collapsed(g, line)).toMatchObject({ dismissed: false, label: line.text });
    const seen = collapsed({ ...g, dismissedKeys: [key] }, line);
    expect(seen).toEqual({ key, dismissed: true, label: 'run failed' });
    expect(line.full).toContain('whole paragraph');
  });

  it('shows a new failure again', () => {
    const old = failed();
    const dismissed = [statusKey(old, lineOf(old))];
    const next = failed('2026-10-09T09:00:00.000Z', { dismissedKeys: dismissed });
    expect(collapsed(next, lineOf(next)).dismissed).toBe(false);
  });

  it('leaves Your turn (the main action) and a rollout alone', () => {
    expect(dismissible({ ...lineOf(failed()), kind: 'ready' })).toBe(false);
    expect(dismissible({ ...lineOf(failed()), kind: 'rollout' })).toBe(false);
    expect(isDismissed({}, 'x')).toBe(false);
  });

  it('names a conflict plainly', () => {
    expect(shortLabel({ ...lineOf(failed()), conflict: true })).toBe('merge conflict');
  });
});

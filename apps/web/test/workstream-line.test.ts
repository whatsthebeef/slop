import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { workstreamLine } from '@slop/core';
import { view } from './helpers/glob-views';

describe('workstreamLine', () => {
  type State = NonNullable<GlobView['workstreams']>['items'][number]['state'];
  const built = (items: readonly (readonly [string, State, string[]?])[], patch: Partial<GlobView> = {}) =>
    view({ status: 'in_progress', workstreams: { fannedOut: true, items: items.map(([name, state, conflicts]) => ({ name, state, conflicts: conflicts ?? [] })) }, ...patch });

  it('counts done workstreams of all (skipped ones left out) while the work runs', () => {
    expect(workstreamLine(built([['W0', 'done'], ['W1', 'running'], ['W2', 'not_started'], ['W3', 'skipped']]))).toMatchObject({ text: 'working · 1/3 workstreams', icon: 'machine-spinning' });
  });

  it('puts a failed workstream, then a decision, then an integration conflict before progress', () => {
    expect(workstreamLine(built([['W1', 'running', ['a.ts']], ['W2', 'waiting_decision'], ['W3', 'failed']]))).toMatchObject({ text: 'failed · W3', icon: 'human' });
    expect(workstreamLine(built([['W1', 'running', ['a.ts']], ['W2', 'waiting_decision']]))?.text).toBe('waiting · decision for W2');
    expect(workstreamLine(built([['W1', 'running', ['a.ts']], ['W2', 'running', ['b.ts']], ['W3', 'done']]))?.text).toBe('integration conflict · W1+W2');
    expect(workstreamLine(built([['W1', 'failed'], ['W2', 'failed'], ['W3', 'failed']]))?.text).toBe('failed · W1 +2');
  });

  it('lists every workstream in the tip, and has nothing for a small glob, a merged one or when all are done', () => {
    expect(workstreamLine(built([['W1', 'done'], ['W2', 'running', ['a.ts']]]))?.tip.split('\n')).toEqual(['W1: done', 'W2: running (conflicts: a.ts)']);
    expect(workstreamLine(view({ status: 'in_progress' }))).toBeNull();
    expect(workstreamLine(built([['W1', 'running'], ['W2', 'running']], { status: 'reviewing' }))).toBeNull();
    expect(workstreamLine(built([['W1', 'done'], ['W2', 'done']]))).toBeNull();
  });
});

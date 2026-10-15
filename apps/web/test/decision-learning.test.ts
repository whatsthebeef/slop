import type { DecisionAttributes, DecisionLearning, EffectCheck } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { EFFECT_VERDICTS, inPipeline, sinceText, watching } from '../src/components/decision-learning';
import { watchMode } from '../src/lib/decide-flow';
import type { KbSignal } from '@slop/core';

const learning = (patch: Partial<DecisionLearning> = {}): DecisionLearning => ({
  status: 'open',
  processing: 'drafted',
  processingError: null,
  processingAttempts: 0,
  processAfter: null,
  effectCheck: null,
  ...patch,
});

const attributes = (patch: Partial<DecisionAttributes> = {}): DecisionAttributes => ({
  scope: { kind: 'project', ref: null },
  origin: { kind: 'submitted' },
  channel: 'agent',
  outcome: null,
  ...patch,
});

describe('the pipeline state of a learning', () => {
  it('is in the pipeline only while it is open and routing or drafting', () => {
    expect(inPipeline(learning({ processing: 'pending' }))).toBe(true);
    expect(inPipeline(learning({ processing: 'routed' }))).toBe(true);
    expect(inPipeline(learning({ processing: 'drafted' }))).toBe(false);
    expect(inPipeline(learning({ processing: 'failed' }))).toBe(false);
    expect(inPipeline(learning({ status: 'approved', processing: 'pending' }))).toBe(false);
  });
});

describe('the signal an approval watches', () => {
  it('is a choice for an open statement with no signal or document of its own', () => {
    expect(watchMode(learning(), attributes())).toBe('choose');
    expect(watchMode(null, attributes())).toBeNull();
    expect(watchMode(learning({ status: 'rejected' }), attributes())).toBeNull();
    expect(watchMode(learning(), attributes({ document: { name: 'd', area: 'a', audience: [], description: 'x' } }))).toBeNull();
  });

  it('is the signal of one mined from a signal', () => {
    const signal: KbSignal = {
      key: 'failure',
      kind: 'failure',
      agent: null,
      label: 'Run failures',
      window: { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' },
      figures: { affected: 2, eligible: 10, rate: 0.2, count: 2 },
      globIds: [],
      examples: [],
      measuredAt: '2026-10-08T00:00:00Z',
    };
    expect(watchMode(learning(), attributes({ signal }))).toBe('own');
  });

  it('is sent only when one was chosen', () => {
    expect(watching('')).toEqual({});
    expect(watching('findings:major')).toEqual({ watchSignal: 'findings:major' });
  });
});

const check = (basis: EffectCheck['basis']): EffectCheck => ({
  state: 'watching',
  key: 'findings:major',
  label: 'Major findings',
  basis,
  n: 10,
  before: null,
  after: null,
  worse: [],
  raisedItemId: null,
  checkedAt: null,
});

describe('an effect check in words', () => {
  it('words each verdict and what the check counts from', () => {
    expect(EFFECT_VERDICTS.worse_elsewhere).toContain('another signal got markedly worse');
    expect(sinceText(check({ kind: 'agent_set', fromVersion: 12 }))).toBe('since v12');
    expect(sinceText(check({ kind: 'time', since: '2026-10-07T10:00:00.000Z' }))).toBe('since 2026-10-07');
  });
});

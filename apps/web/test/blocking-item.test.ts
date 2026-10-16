import { blockingItem, blocksReadOnly } from '@slop/core';
import type { Action, OpenQuestion } from '@slop/core';
import { describe, expect, it } from 'vitest';
import type { GlobView, ListedHumanStep } from '../src/lib/api';
import { glob as coreGlob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({
  ...coreGlob(),
  status: 'in_progress',
  list: 'doing',
  branch: 's1t1',
  currentRun: null,
  ...patch,
});

const decision = (patch: Partial<GlobView> = {}): GlobView =>
  view({
    category: 'decision',
    allowedActions: ['decide'] satisfies Action[],
    attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'human', outcome: null },
    ...patch,
  });

const question = (patch: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: 'q1',
  text: 'Is prod in scope?',
  raisedBy: { kind: 'intake', actor: null },
  source: 'create',
  blocking: 'merge',
  raisedAt: '2026-10-14T00:00:00Z',
  ...patch,
});

const step = (patch: Partial<ListedHumanStep> = {}): ListedHumanStep => ({
  id: 'hs_1',
  kind: 'rollout',
  title: 'Add SLOP_X to the server env',
  state: 'due',
  who: 'admin',
  due: 'after_merge',
  blocks: ['sign_off'],
  ...patch,
});

const admin = { email: 'admin@example.com', role: 'admin' } as const;

describe('blockingItem', () => {
  it('is null for a plain glob', () => {
    expect(blockingItem(view(), 'dev', admin)).toBeNull();
  });

  it('is null in Planning whatever the blocks are, and the blocks read only', () => {
    const planning = decision({ status: 'planning', list: 'planning', questions: [question({ blocking: 'start' })], humanSteps: [step()] });
    expect(blocksReadOnly(planning)).toBe(true);
    expect(blockingItem(planning, 'admin', admin)).toBeNull();
    expect(blocksReadOnly(view())).toBe(false);
  });

  it('is the decision for a picked-up decision the viewer may decide', () => {
    expect(blockingItem(decision(), 'dev', admin)).toEqual({ kind: 'decision' });
  });

  it('is the decision for an admin or PO without the decide action, but not for a dev', () => {
    const noDecide = decision({ allowedActions: ['delete'] satisfies Action[] });
    expect(blockingItem(noDecide, 'admin', admin)).toEqual({ kind: 'decision' });
    expect(blockingItem(noDecide, 'po', admin)).toEqual({ kind: 'decision' });
    expect(blockingItem(noDecide, 'dev', admin)).toBeNull();
  });

  it('is not the decision once signed off, or for a learning whose outcome is in', () => {
    expect(blockingItem(decision({ status: 'signed_off' }), 'admin', admin)).toBeNull();
    expect(blockingItem(decision(), 'admin', admin, false)).toBeNull();
  });

  it('is an open question that holds the merge', () => {
    expect(blockingItem(view({ questions: [question()] }), 'dev', admin)).toEqual({ kind: 'question', id: 'q1' });
  });

  it('is not a question that only notifies, or one already answered or dismissed', () => {
    const closed = [
      question({ blocking: 'none' }),
      question({ id: 'q2', answer: { text: 'Yes', by: 'a@b.c', at: '2026-10-14T01:00:00Z' } }),
      question({ id: 'q3', dismissed: { by: 'a@b.c', at: '2026-10-14T01:00:00Z', note: '' } }),
    ];
    expect(blockingItem(view({ questions: closed }), 'dev', admin)).toBeNull();
  });

  it('is not a start question once the glob is picked up', () => {
    expect(blockingItem(view({ questions: [question({ blocking: 'start' })] }), 'dev', admin)).toBeNull();
  });

  it('is a due blocking step for the person it is for, not for someone else or a step not due yet', () => {
    const withStep = (patch: Partial<ListedHumanStep>) => view({ humanSteps: [step(patch)] });
    expect(blockingItem(withStep({}), 'admin', admin)).toEqual({ kind: 'step', id: 'hs_1' });
    expect(blockingItem(withStep({ state: 'pending' }), 'admin', admin)).toBeNull();
    expect(blockingItem(withStep({ blocks: [] }), 'admin', admin)).toBeNull();
    expect(blockingItem(withStep({}), 'admin', undefined)).toBeNull();
  });

  it('is a label still to approve while Reviewing, and not once all are approved or before Reviewing', () => {
    const at = (status: GlobView['status'], labels: GlobView['labels']) => view({ status, labels });
    expect(blockingItem(at('reviewing', { FR: 'approved', CR: 'required' }), 'dev', admin)).toEqual({ kind: 'label' });
    expect(blockingItem(at('reviewing', { FR: 'added' }), 'dev', admin)).toEqual({ kind: 'label' });
    expect(blockingItem(at('reviewing', { FR: 'approved', CR: 'approved' }), 'dev', admin)).toBeNull();
    expect(blockingItem(at('in_progress', { FR: 'required' }), 'dev', admin)).toBeNull();
  });

  it('puts the decision before a question and a question before a step', () => {
    const both = decision({ questions: [question()], humanSteps: [step()] });
    expect(blockingItem(both, 'admin', admin)).toEqual({ kind: 'decision' });
    expect(blockingItem(view({ questions: [question()], humanSteps: [step()] }), 'admin', admin)).toEqual({ kind: 'question', id: 'q1' });
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumanSteps } from '../src/components/human-steps';
import { LabelReviews } from '../src/components/labels';
import { api } from '../src/lib/api';
import type { GlobView, ListedHumanStep } from '../src/lib/api';
import {
  approveHold,
  blockingTurn,
  defaultStepsOpen,
  dismissReason,
  mainStep,
  stepMain,
  rolloutLine,
  scriptArtifactPath,
  scriptCopyText,
  stateText,
  stepInput,
  EMPTY_DRAFT,
} from '../src/lib/human-steps';
import { copyOrSelect } from '../src/lib/plan-text';
import { statusLine } from '../src/lib/status-line';
import { NOW, glob } from '../../../packages/core/test/fixtures';

const admin = { email: 'admin@example.com', role: 'admin' } as const;
const dev = { email: 'dev@example.com', role: 'dev' } as const;

const step = (patch: Partial<ListedHumanStep> = {}): ListedHumanStep => ({
  id: 'hs_1',
  kind: 'rollout',
  title: 'Roll out the host stack',
  state: 'due',
  who: 'admin',
  due: 'after_merge',
  blocks: ['sign_off', 'dependants'],
  detail: null,
  script: null,
  check: null,
  source: 'work',
  doneBy: null,
  doneAt: null,
  ...patch,
});
const merged = (steps: ListedHumanStep[], patch: Partial<GlobView> = {}): GlobView =>
  ({ ...glob(), status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'abc' }, humanSteps: steps, ...patch }) as GlobView;

afterEach(() => vi.unstubAllGlobals());

describe('main step', () => {
  it('is the due blocking step for the viewer, named Rollout for a rollout', () => {
    const g = merged([step()]);
    expect(mainStep(g, admin)).toMatchObject({ label: 'Rollout', step: { id: 'hs_1' } });
  });
  it('uses the title for other kinds', () => {
    const g = merged([step({ kind: 'unstick', title: 'Free the queue' })]);
    expect(mainStep(g, admin)?.label).toBe('Free the queue');
  });
  it('is not the step for another viewer, a pending, non-blocking or machine step', () => {
    expect(mainStep(merged([step()]), dev)).toBeNull();
    expect(mainStep(merged([step()]), undefined)).toBeNull();
    expect(mainStep(merged([step({ state: 'pending' })]), admin)).toBeNull();
    expect(mainStep(merged([step({ blocks: [] })]), admin)).toBeNull();
    expect(blockingTurn([step({ id: 'machine:merge', blocks: ['reviewing'], who: 'anyone' })], glob(), admin)).toBeNull();
  });
});

describe('main step action', () => {
  it('copies the command for a script step, then offers Mark done', () => {
    expect(stepMain(step({ script: { path: 'infra/deploy/host-deploy.sh' } }))).toEqual({ kind: 'copy', label: 'Copy rollout command', then: 'Mark done' });
  });
  it('is Mark done with the text visible for a setting or manual step', () => {
    expect(stepMain(step({ detail: 'Add SLOP_X to /slop/prod/server-env' }))).toEqual({ kind: 'done', label: 'Mark done', text: 'Add SLOP_X to /slop/prod/server-env' });
    expect(stepMain(step())).toEqual({ kind: 'done', label: 'Mark done', text: null });
  });
  it('is disabled with the reason when slop ticks the step itself (a capability check), even for a script', () => {
    expect(stepMain(step({ check: 'fileAttachments', script: { path: 'x.sh' } }))).toEqual({
      kind: 'wait',
      label: 'Mark done',
      reason: 'waits for fileAttachments to turn on; slop ticks this itself',
    });
  });
});

describe('rollout status line', () => {
  const steps = [step({ id: 'a', state: 'done' }), step({ id: 'b' }), step({ id: 'c', state: 'pending' }), step({ id: 'd', state: 'dismissed' })];
  it('counts done against all steps that are not dismissed, with Your turn for the viewer', () => {
    expect(statusLine(merged(steps), NOW, admin)).toMatchObject({ kind: 'ready', text: 'Merged; rollout 1/3 (Your turn)', turn: 'rollout', work: true });
  });
  it('is a quiet line when the due step is for somebody else', () => {
    expect(statusLine(merged(steps), NOW, dev)).toMatchObject({ kind: 'rollout', text: 'Merged; rollout 1/3' });
    expect(statusLine(merged(steps), NOW)).toMatchObject({ kind: 'rollout', text: 'Merged; rollout 1/3' });
  });
  it('says nothing before the merge or once the steps are done', () => {
    expect(rolloutLine(glob(), steps, admin)).toBeNull();
    expect(rolloutLine(merged([]), [step({ state: 'done' })], admin)).toBeNull();
  });
});

describe('approving while the rollout is pending', () => {
  it('holds Approve with the first open step\'s title, and lets go once steps are done or dismissed', () => {
    expect(approveHold(merged([step({ id: 'a', state: 'done' }), step({ id: 'b', title: 'Set the env' })]))).toBe('Waits for the rollout: Set the env');
    expect(approveHold(merged([step({ state: 'done' })]))).toBeNull();
    expect(approveHold(merged([step({ state: 'dismissed' })]))).toBeNull();
    expect(approveHold(merged([step({ blocks: [] })]))).toBeNull();
  });
  it('does not hold before the merge', () => {
    expect(approveHold(merged([step()], { status: 'in_progress', pr: null }))).toBeNull();
  });
  it('disables Approve in the sign-off section and says why', () => {
    const g = merged([step({ title: 'Deploy the stack' })]);
    const html = renderToStaticMarkup(createElement(LabelReviews, { glob: { ...g, labels: { QA: 'required' } }, onReview: () => Promise.resolve(true) }));
    expect(html).toContain('Waits for the rollout: Deploy the stack');
    expect(/<button[^>]*disabled=""[^>]*>Approve<\/button>/.test(html)).toBe(true);
    const free = renderToStaticMarkup(createElement(LabelReviews, { glob: { ...merged([]), labels: { QA: 'required' } }, onReview: () => Promise.resolve(true) }));
    expect(free).not.toContain('Waits for the rollout');
  });
});

describe('copy', () => {
  it('copies a repo path as it is, and an artifact script by its text', async () => {
    expect(await scriptCopyText(15, 's15f1', { path: 'infra/deploy.sh' }, () => Promise.resolve(null), 'https://slop')).toBe('infra/deploy.sh');
    expect(await scriptCopyText(15, 's15f1', { artifact: 'host' }, () => Promise.resolve('echo hi'), 'https://slop')).toBe('echo hi');
  });
  it('falls back to the artifact link when the text cannot be read', async () => {
    const text = await scriptCopyText(15, 's15f1', { artifact: 'host' }, () => Promise.reject(new Error('404')), 'https://slop');
    expect(text).toBe('https://slop/boards/15/globs/s15f1?section=artifacts&artifact=rollout_script&label=host');
  });
  it('writes to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    expect(await copyOrSelect('echo hi', { writeText }, () => undefined)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('echo hi');
  });
});

describe('forms', () => {
  it('needs a title to add a step, and trims what it sends', () => {
    expect(stepInput(EMPTY_DRAFT)).toBeNull();
    expect(stepInput({ title: ' Flip the flag ', detail: ' ', who: ' qa ', due: 'now' })).toEqual({ title: 'Flip the flag', who: 'qa', due: 'now' });
  });
  it('needs a reason to dismiss', () => {
    expect(dismissReason('  ')).toBeNull();
    expect(dismissReason(' not needed ')).toBe('not needed');
  });
  it('describes the state', () => {
    expect(stateText(step())).toBe('due now');
    expect(stateText(step({ state: 'pending' }))).toBe('due after the merge');
    expect(stateText(step({ state: 'done', doneBy: 'a@b.c', doneAt: '2026-10-06T08:00:00.000Z' }))).toBe('done by a@b.c on 2026-10-06');
    expect(defaultStepsOpen([step({ state: 'done' })])).toBe(false);
    expect(defaultStepsOpen([step()])).toBe(true);
  });
});

describe('api calls', () => {
  const answer = (calls: { url: string; body: unknown }[]) =>
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null });
      return Promise.resolve(Response.json({ id: 's1', humanSteps: [] }));
    });
  it('adds, ticks and dismisses through the human-steps routes', async () => {
    const calls: { url: string; body: unknown }[] = [];
    answer(calls);
    await api.addHumanStep('s1', { title: 'T', who: 'qa' });
    await api.completeHumanStep('s1', 'hs_1');
    await api.dismissHumanStep('s1', 'hs_1', 'wrong');
    expect(calls).toEqual([
      { url: '/api/globs/s1/human-steps', body: { title: 'T', who: 'qa' } },
      { url: '/api/globs/s1/human-steps/hs_1/complete', body: {} },
      { url: '/api/globs/s1/human-steps/hs_1/dismiss', body: { reason: 'wrong' } },
    ]);
  });
});

describe('section markup', () => {
  const html = (g: GlobView, viewer = admin, canAdd = true) =>
    renderToStaticMarkup(
      createElement(
        StaticRouter,
        { location: '/' },
        createElement(HumanSteps, {
          glob: g,
          viewer,
          canAdd,
          startOpen: true,
          onAdd: () => Promise.resolve(true),
          onComplete: () => Promise.resolve(true),
          onDismiss: () => Promise.resolve(true),
        }),
      ),
    );
  const steps = [
    step({ script: { artifact: 'host' }, check: 'fileAttachments' }),
    step({ id: 'hs_2', title: 'Tell the team', state: 'done', doneBy: 'dev@example.com', doneAt: '2026-10-06T08:00:00.000Z', script: { path: 'infra/x.sh' } }),
    step({ id: 'machine:merge', kind: 'merge', title: 'Merge', who: 'anyone', source: 'machine', blocks: ['reviewing'] }),
  ];

  it('renders each step with its icon, who, state, script links, check and tick', () => {
    const out = html(merged(steps));
    expect(out).toContain('Human steps (3)');
    expect(out).toContain('aria-label="Done: Roll out the host stack"');
    expect(out).toMatch(/for the admin/);
    expect(out).toContain('due now');
    expect(out).toContain('Your turn');
    expect(out).toContain('checked by slop: fileAttachments');
    expect(out).toContain(`href="${scriptArtifactPath(glob().boardId, glob().id, { artifact: 'host' }).replace(/&/g, '&amp;')}"`);
    expect(out).toContain('infra/x.sh');
    expect(out).toContain('done by dev@example.com on 2026-10-06');
    expect(out).toContain('lucide-user-round');
    expect(out).toContain('Add a step');
    expect(out.match(/data-testid="step-tick"/g)).toHaveLength(2);
    expect(out.match(/data-testid="step-copy"/g)).toHaveLength(2);
  });

  it('is hidden with no steps unless the viewer can add', () => {
    expect(html(merged([]), admin, false)).toBe('');
    expect(html(merged([]))).toContain('Add a step');
  });
});

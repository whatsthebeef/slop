// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action, Holding, RelationsView } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobDetail } from '../src/components/glob-dialog';
import type { BoardView, GlobView } from '../src/lib/api';
import { board as coreBoard, glob as coreGlob } from '../../../packages/core/test/fixtures';

const board: BoardView = { ...coreBoard, role: 'dev' };

const view = (patch: Partial<GlobView> = {}): GlobView => ({
  ...coreGlob(),
  list: 'planning',
  branch: 's1t1',
  currentRun: null,
  ...patch,
});

const callbacks = () => ({
  onClose: vi.fn(),
  onUpdate: vi.fn(() => Promise.resolve(null)),
  onReload: vi.fn(() => Promise.resolve()),
  onAction: vi.fn<(action: Action, anyway?: boolean) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
  onReviewLabel: vi.fn(),
  onDismissEdge: vi.fn(() => Promise.resolve(true)),
  onAddRelation: vi.fn(() => Promise.resolve(true)),
  onAnswerQuestion: vi.fn(() => Promise.resolve(true)),
  onDismissQuestion: vi.fn(() => Promise.resolve(true)),
  onDecide: vi.fn(() => Promise.resolve(true)),
  onAddStep: vi.fn(() => Promise.resolve(true)),
  onCompleteStep: vi.fn(() => Promise.resolve(true)),
  onDismissStep: vi.fn(() => Promise.resolve(true)),
  onFailStep: vi.fn(() => Promise.resolve(true)),
  onDelete: vi.fn(() => Promise.resolve()),
});

/** Renders the glob view with stubbed callbacks; the server is never reached (every fetch fails and the queries stay empty). */
const renderGlob = (glob: GlobView, groups?: readonly string[]) => {
  const cb = callbacks();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobDetail board={board} glob={glob} initialArtifact={null} {...(groups === undefined ? {} : { groups })} {...cb} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return cb;
};

beforeAll(() => {
  // jsdom lacks these; Radix and the glob view call them.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no server in component tests'))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('glob view: escalation, dependencies and edit fields', () => {
  /** The page's text without the screen-reader-only spans (the tooltip's description is read, never shown). */
  const visibleText = () => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.sr-only').forEach((el) => el.remove());
    return copy.textContent;
  };

  const escalated = () =>
    view({
      escalation: {
        at: '2026-10-13T00:00:00Z',
        by: 'dev@example.com',
        reason: 'Touches auth',
        evidence: 'From the split of s1t0: files a.ts',
        criterion: 'risk_area',
      },
    });

  it('shows the escalation once, as a header chip, with the reason in the disclosure only', () => {
    renderGlob(escalated());
    expect(screen.getAllByTestId('escalation-chip')).toHaveLength(1);
    expect(screen.getByTestId('escalation-note').textContent).toContain('touches auth');
    expect(screen.getByTestId('escalation-note').textContent).toContain('From the split of s1t0');
    expect(visibleText().split('touches auth')).toHaveLength(2);
  });

  it('says in one plain line that the sub became a same and why, with the evidence collapsed under Details', () => {
    renderGlob(escalated());
    const note = screen.getByTestId('escalation-note');
    expect(note.textContent).toContain('Changed from sub to same because touches auth.');
    expect(note.textContent).toContain('By dev@example.com, 2026-10-13');
    const details = note.querySelector('details');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.textContent).toContain('From the split of s1t0');
    expect(details?.querySelector('summary')?.textContent).toBe('Details');
  });

  it('keeps the chip text out of the visible and accessible text but names it for screen readers', () => {
    renderGlob(escalated());
    expect(screen.getByRole('img', { name: 'Needs a person' })).toBeTruthy();
    expect(visibleText()).not.toMatch(/needs a ?:/i);
    expect(screen.getByTestId('escalation-chip').getAttribute('aria-describedby')).not.toBeNull();
  });

  it('shows the chip only in Planning, as on the card: a pr_open escalated glob keeps the disclosure but no chip', () => {
    renderGlob({ ...escalated(), status: 'pr_open', list: 'doing' });
    expect(screen.queryByTestId('escalation-chip')).toBeNull();
    expect(screen.getByTestId('escalation-note').textContent).toContain('touches auth');
  });

  it('leaves the chip and the disclosure out without an escalation', () => {
    renderGlob(view());
    expect(screen.queryByTestId('escalation-chip')).toBeNull();
    expect(screen.queryByTestId('escalation-note')).toBeNull();
  });

  const escalation = {
    at: '2026-10-13T00:00:00Z',
    by: 'dev@example.com',
    reason: 'Touches auth',
    evidence: 'From the split of s1t0: files a.ts',
    criterion: 'risk_area',
  } as const;

  const NOW = '2026-10-13T20:00:00Z';
  const failedChecks = {
    sha: 'abcdef1234567',
    state: 'failed',
    at: NOW,
    failure: { name: 'apps/server test', step: 'Test', lines: ['Error: boom'], url: 'https://ci/run/1' },
  } as const;
  const fixing = view({
    type: 'same',
    status: 'pr_open',
    pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
    escalation,
    headChecks: failedChecks,
    currentRun: {
      id: 'r1',
      state: 'watching',
      outcome: null,
      generation: 1,
      triggeredBy: 'dev@example.com',
      routineOwner: 'dev@example.com',
      queuedAt: NOW,
      startedAt: NOW,
      lastProgressAt: NOW,
      endedAt: null,
      failureReason: null,
      sessionId: 's',
      sessionUrl: 'https://claude.ai/code/s',
    },
    machineSteps: [
      { id: 'm1', kind: 'fix_checks', state: 'running', startedAt: NOW, lastProgressAt: NOW, detail: null, holdsBall: true },
    ],
    move: { holder: 'machine', reason: 'fix checks', since: NOW },
    handover: { why: ['Checks failed on abcdef1'], next: 'Reproduce and fix', detail: ['Error: boom'] },
  });

  it('escalated glob with failed checks and an active fix run: the machine holds the ball, the failure shows once', () => {
    renderGlob(fixing);
    expect(screen.getByTestId('header-status').textContent).toMatch(/fix(ing)? (CI|checks)/i);
    expect(screen.getByTestId('activity').getAttribute('data-holder')).toBe('machine');
    expect(screen.queryByText(/Why you're needed/)).toBeNull();
    expect(screen.queryByTestId('handover-box')).toBeNull();
    expect(screen.queryByTestId('machine-steps')).toBeNull();
    // The header chip is Planning-only (s15b86); this glob is pr_open, so the reason lives in the disclosure.
    expect(screen.queryByTestId('escalation-chip')).toBeNull();
    // Someone is on it: no red block while the fix run works (the corner says "fixing CI").
    expect(screen.queryByTestId('problem-block')).toBeNull();
    expect(screen.queryByText(/Error: boom/)).toBeNull();
    // Escalation reason appears only in the escalation block, never in Now.
    expect(screen.getByTestId('activity').textContent).not.toContain('Touches auth');
  });

  it('puts the status in the header, not in a Now panel, and the details in the problem block above the actions', () => {
    renderGlob(fixing);
    expect(screen.queryByTestId('now-panel')).toBeNull();
    expect(screen.getByTestId('glob-header').contains(screen.getByTestId('header-status'))).toBe(true);
    expect(screen.getByTestId('header-status').textContent).not.toContain('Now:');
    expect(screen.getByTestId('glob-header').textContent).not.toMatch(/branch|v\d/);
    const log = screen.getByTestId('activity');
    expect(log.id).toBe('glob-activity');
    expect(screen.queryByTestId('problem-block')).toBeNull();
    expect(log.textContent).not.toContain('Error: boom');
  });

  it("the viewer's turn: no handover box; what is wrong is the one notice beside the actions", () => {
    renderGlob(
      view({
        status: 'pr_open',
        pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
        headChecks: failedChecks,
        implementer: null,
        allowedActions: ['pick_up'],
        move: { holder: 'you', reason: 'Merge', since: null, who: 'dev@example.com' },
        handover: { why: ['Checks failed on abcdef1'], next: 'Reproduce and fix', detail: [] },
      }),
    );
    expect(screen.queryByText(/Why you're needed/)).toBeNull();
    expect(screen.queryByTestId('turn-reason')).toBeNull();
    expect(screen.getAllByTestId('notice')).toHaveLength(1);
    expect(screen.getByTestId('notice').getAttribute('data-kind')).toBe('checks');
  });

  it('never repeats the escalation reason in the headline', () => {
    renderGlob(
      view({
        escalation,
        move: { holder: 'human', reason: 'Needs a human: Touches auth', since: null, who: 'dev@example.com' },
      }),
    );
    expect(screen.getByTestId('header-status').textContent).not.toContain('Touches auth');
  });

  it('has no Related wrapper, and Holding this back and Holds back with their Add buttons for a glob with no relations', () => {
    renderGlob(view({ status: 'planning', provisioning: 'none' }));
    expect(screen.queryByTestId('related')).toBeNull();
    expect(screen.queryByTestId('related-toggle')).toBeNull();
    expect(screen.getByTestId('holding-toggle').textContent).toBe('Holding this back (0)');
    expect(screen.getByTestId('holding-toggle').closest('div')?.contains(screen.getByTestId('add-holding'))).toBe(true);
    expect(screen.getByTestId('holds-back-toggle').textContent).toBe('Holds back (0)');
    expect(screen.getByTestId('holds-back-toggle').closest('div')?.contains(screen.getByTestId('add-holds-back'))).toBe(true);
    expect(screen.getByTestId('holding').className).not.toContain('border');
    expect(screen.getByTestId('holding').className).not.toContain('text-sm');
    expect(screen.queryByTestId('no-longer-holding')).toBeNull();
    expect(screen.getByTestId('add-holding').textContent).toBe('Add holding');
    expect(screen.getByTestId('add-holds-back').textContent).toBe('Add holds back');
    expect(screen.queryByTestId('add-relation-form')).toBeNull();
    expect(screen.queryByPlaceholderText('s15t7, s15b18')).toBeNull();
    expect(screen.queryByTestId('dependencies')).toBeNull();
  });

  const hold = (to: string, patch: Partial<Holding> = {}): Holding => ({
    relationId: `rel_${to}`,
    to,
    toTitle: `Title of ${to}`,
    toIsDecision: false,
    gate: 'start',
    until: 'merged',
    state: 'open',
    reason: null,
    source: 'person',
    ...patch,
  });
  const related = (patch: Partial<RelationsView>): RelationsView => ({ holding: [], holdsBack: [], done: [], ...patch });

  it('sorts the relations into Holding this back, Holds back and a collapsed No longer holding, each row with its gate in words, reason and source', async () => {
    renderGlob(
      view({
        status: 'planning',
        provisioning: 'none',
        relations: related({
          holding: [
            hold('s1t2', { reason: 'uses the endpoint it adds', source: 'inferred' }),
            hold('s1k4', { toIsDecision: true, until: 'decided', state: 'planning' }),
            hold('s1t5', { gate: 'start', source: 'split' }),
          ],
          holdsBack: [{ relationId: 'rel_h', from: 's1t8', fromTitle: 'Later work', gate: 'merge', until: 'merged', reason: null, source: 'person' }],
          done: [{ relationId: 'rel_d', to: 's1t0', toTitle: 'Earlier', gate: 'start', until: 'merged', reason: null, source: 'learned', how: 'met' }],
        }),
      }),
    );
    const holding = screen.getByTestId('holding');
    expect(within(holding).getAllByText("· can't start until merged and rolled out")).toHaveLength(2);
    expect(holding.textContent).toContain('uses the endpoint it adds');
    expect(holding.textContent).toContain('inferred by slop');
    expect(within(screen.getByTestId('related-row-s1k4')).getByText('· decision')).toBeTruthy();
    expect(screen.getByTestId('related-row-s1k4').textContent).toContain("can't start until decided");
    expect(holding.textContent).toContain('s1t5');
    expect(holding.querySelector('details')).toBeNull();
    expect(holding.textContent).not.toContain('Decisions');
    expect(screen.getByTestId('holds-back-toggle').textContent).toBe('Holds back (1)');
    const done = screen.getByTestId('no-longer-holding');
    expect(done.tagName).not.toBe('DETAILS');
    expect(done.querySelector('details')).toBeNull();
    expect(done.className).toContain('text-muted-foreground');
    expect(done.textContent).toContain('No longer holding (1)');
    expect(screen.queryByTestId('related-row-s1t0')).toBeNull();
    await userEvent.click(screen.getByTestId('no-longer-holding-toggle'));
    expect(screen.getByTestId('related-row-s1t0')).toBeTruthy();
    await userEvent.click(screen.getByTestId('holds-back-toggle'));
    expect(screen.getByTestId('holds-back').textContent).toContain("can't merge until this is merged and rolled out");
  });

  it('puts a ✕ on a relation a person or slop made, dismissing it by its relation, and none on a split part, holds back or done row', async () => {
    const cb = renderGlob(
      view({
        status: 'planning',
        provisioning: 'none',
        relations: related({
          holding: [hold('s1t2', { source: 'inferred' }), hold('s1t3', { source: 'person' }), hold('s1t5', { gate: 'sign_off', source: 'split' })],
          holdsBack: [{ relationId: 'rel_h', from: 's1t8', fromTitle: null, gate: 'start', until: 'merged', reason: null, source: 'inferred' }],
          done: [{ relationId: 'rel_d', to: 's1t0', toTitle: null, gate: 'start', until: 'merged', reason: null, source: 'inferred', how: 'dismissed' }],
        }),
      }),
    );
    expect(screen.getAllByRole('button', { name: /^Not a dependency/ })).toHaveLength(2);
    expect(screen.queryByTestId('dismiss-edge-s1t5')).toBeNull();
    expect(screen.queryByTestId('dismiss-edge-s1t8')).toBeNull();
    expect(screen.queryByTestId('dismiss-edge-s1t0')).toBeNull();
    await userEvent.click(screen.getByTestId('dismiss-edge-s1t2'));
    expect(cb.onDismissEdge).toHaveBeenCalledWith('rel_s1t2');
  });

  it('adds a relation: the gate defaults to start, and the version of this glob goes with it', async () => {
    const cb = renderGlob(view({ status: 'planning', provisioning: 'none', version: 7 }));
    await userEvent.click(screen.getByTestId('add-holding'));
    await userEvent.type(screen.getByLabelText('Glob or decision'), 's1t9');
    expect(screen.getByLabelText<HTMLSelectElement>('Gate').value).toBe('start');
    await userEvent.type(screen.getByLabelText('Reason (optional)'), 'needs its schema');
    await userEvent.click(screen.getByTestId('add-relation-submit'));
    expect(cb.onAddRelation).toHaveBeenCalledWith({ gate: 'start', reason: 'needs its schema', to: 's1t9', version: 7 });
  });

  it('toggles Holding this back, which starts open only while something holds the glob back, and the Add button toggles the form', async () => {
    renderGlob(view({ status: 'planning', provisioning: 'none', relations: related({ weak: [{ relationId: 'rel_w', to: 's1t0', toTitle: null, gate: 'start', until: 'merged', reason: null, source: 'inferred', state: 'open' }] }) }));
    expect(screen.getByTestId('holding-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('related-row-s1t0')).toBeNull();
    await userEvent.click(screen.getByTestId('holding-toggle'));
    expect(screen.getByTestId('related-row-s1t0')).toBeTruthy();
    await userEvent.click(screen.getByTestId('add-holding'));
    expect(screen.getByTestId('add-relation-form')).toBeTruthy();
    await userEvent.click(screen.getByTestId('add-holding'));
    expect(screen.queryByTestId('add-relation-form')).toBeNull();
  });

  it('starts Holding this back open when something holds the glob back', () => {
    renderGlob(view({ status: 'planning', provisioning: 'none', relations: related({ holding: [hold('s1t2'), hold('s1t3')] }) }));
    expect(screen.getByTestId('holding-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('holding-toggle').textContent).toBe('Holding this back (2)');
    expect(screen.getByTestId('related-row-s1t2')).toBeTruthy();
  });

  it('keeps the form open and the text when the add failed', async () => {
    const cb = renderGlob(view({ status: 'planning', provisioning: 'none' }));
    cb.onAddRelation.mockResolvedValueOnce(false);
    await userEvent.click(screen.getByTestId('add-holding'));
    await userEvent.type(screen.getByLabelText('Glob or decision'), 's1t9');
    await userEvent.click(screen.getByTestId('add-relation-submit'));
    expect(screen.getByLabelText<HTMLInputElement>('Glob or decision').value).toBe('s1t9');
  });

  it('a decision glob shows Holds back open when it has rows, and adds a glob it holds back', async () => {
    const cb = renderGlob(
      view({
        category: 'decision',
        status: 'in_progress',
        allowedActions: ['decide'],
        attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'human', outcome: null },
        relations: related({ holdsBack: [{ relationId: 'rel_h', from: 's1t8', fromTitle: 'Later work', gate: 'start', until: 'decided', reason: 'waits on the choice', source: 'person' }] }),
      }),
    );
    expect(screen.getByTestId('add-holds-back').textContent).toBe('Add holds back');
    expect(screen.getByTestId('holds-back-toggle').textContent).toBe('Holds back (1)');
    expect(screen.getByTestId('holds-back').textContent).toContain("can't start until this is decided");
    expect(screen.getByTestId('holds-back').textContent).toContain('waits on the choice');
    await userEvent.click(screen.getByTestId('add-holds-back'));
    await userEvent.type(screen.getByLabelText('Glob it holds back'), 's1t3');
    await userEvent.selectOptions(screen.getByLabelText('Gate'), 'merge');
    await userEvent.click(screen.getByTestId('add-relation-submit'));
    expect(cb.onAddRelation).toHaveBeenCalledWith({ gate: 'merge', holdsBack: 's1t3' });
  });

  it('a work glob can add a glob it holds back, from its own Holds back section', async () => {
    const cb = renderGlob(view({ status: 'planning', provisioning: 'none' }));
    await userEvent.click(screen.getByTestId('add-holds-back'));
    expect(screen.getByTestId('holds-back-toggle').getAttribute('aria-expanded')).toBe('true');
    await userEvent.type(screen.getByLabelText('Glob it holds back'), 's1t3');
    await userEvent.click(screen.getByTestId('add-relation-submit'));
    expect(cb.onAddRelation).toHaveBeenCalledWith({ gate: 'start', holdsBack: 's1t3' });
  });

  it('offers Save and Discard once the group is edited, and Discard clears them', async () => {
    renderGlob(view());
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Group'), 'x');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('suggests the board’s groups in the Group field', () => {
    renderGlob(view(), ['alpha', 'beta']);
    const list = document.getElementById(screen.getByLabelText('Group').getAttribute('list') ?? '');
    expect([...(list?.querySelectorAll('option') ?? [])].map((o) => o.value)).toEqual(['alpha', 'beta']);
  });

  it('saves the edited group through onUpdate', async () => {
    const cb = renderGlob(view());
    await userEvent.type(screen.getByLabelText('Group'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(cb.onUpdate).toHaveBeenCalledWith({ group: 'x' });
  });
});

describe('glob view: the failure notice', () => {
  const AT = '2026-10-08T10:00:00.000Z';
  const failed = (patch: Partial<GlobView> = {}) =>
    view({
      status: 'failed',
      failure: { reason: 'Could not reproduce the bug: a whole paragraph of detail', at: AT },
      implementer: null,
      allowedActions: ['pick_up'],
      ...patch,
    });

  it('shows the failure with no dismiss control', () => {
    renderGlob(failed({ implementer: null }));
    expect(screen.getByTestId('notice-text').textContent).toContain('whole paragraph');
    expect(within(screen.getByTestId('notice')).queryByTestId('dismiss-message')).toBeNull();
    expect(screen.queryByTestId('show-again')).toBeNull();
  });

  it('ignores an old stored dismissal: the failure shows in full', () => {
    renderGlob(failed({ implementer: null, dismissedKeys: [`failure:${AT}`] }));
    expect(screen.getByTestId('notice-text').textContent).toContain('whole paragraph');
  });

  it('shows a new failure with its new reason', () => {
    renderGlob(failed({ implementer: null, failure: { reason: 'A newer failure', at: '2026-10-09T09:00:00.000Z' } }));
    expect(screen.getByTestId('notice-text').textContent).toContain('A newer failure');
  });

  it('keeps the notice for a glob a person has picked up: the failure is still the thing to say', () => {
    renderGlob(failed({ implementer: 'dev@example.com' }));
    expect(screen.getByTestId('notice-text').textContent).toContain('whole paragraph');
  });

  it('hides the notice while a fix run is queued or running, and brings it back when the run has failed', () => {
    const now = new Date().toISOString();
    const open = view({
      status: 'pr_open',
      list: 'doing',
      pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
      headChecks: { sha: 'abcdef1234567', state: 'failed', at: now, failure: { name: 'Lint', step: null, lines: ['x'], url: null } },
      allowedActions: ['retry_autofix'],
    });
    const fixing = (state: 'queued' | 'active' | 'watching'): GlobView => {
      const r = { id: 'r2', state, outcome: null, generation: 1, triggeredBy: 'a', routineOwner: 'a', queuedAt: now, startedAt: now, lastProgressAt: now, endedAt: null, failureReason: null, sessionId: null, sessionUrl: null } as const;
      return { ...open, runs: [r], currentRun: r };
    };
    renderGlob(open);
    expect(screen.getByTestId('notice').getAttribute('data-kind')).toBe('checks');
    cleanup();
    for (const state of ['queued', 'active', 'watching'] as const) {
      renderGlob(fixing(state));
      expect(screen.queryByTestId('notice')).toBeNull();
      cleanup();
    }
    renderGlob(
      failed({
        implementer: null,
        failure: { reason: 'The fix run failed too', at: '2026-10-09T09:00:00.000Z' },
        currentRun: { id: 'r2', state: 'ended', outcome: 'failed' } as unknown as GlobView['currentRun'],
      }),
    );
    expect(screen.getByTestId('notice-text').textContent).toContain('The fix run failed too');
  });

  it('cuts a long reason to a line with the whole of it in the tooltip', () => {
    const long = `Reason ${'x'.repeat(400)}`;
    renderGlob(failed({ implementer: null, failure: { reason: long, at: AT } }));
    expect(screen.getByTestId('notice-text').textContent.length).toBeLessThan(300);
    expect(screen.getByTestId('notice').getAttribute('title')).toBe(long);
  });
});

describe('glob view: a stalled failure', () => {
  const AT = '2026-10-13T21:00:00.000Z';
  const REASON = `Needs a decision before it can go on. MARKER ${'The plan names infrastructure that does not exist. '.repeat(6)}`;
  const DECISION = 'Should the export be a CSV download or a stored report?';
  const stalledView = (failure: GlobView['failure'], brief: GlobView['handover'], label: string) =>
    view({
      status: 'failed',
      failure,
      implementer: null,
      allowedActions: ['pick_up'],
      move: { holder: 'stalled', reason: REASON, label, since: AT, cause: 'failed' },
      handover: brief,
    });

  /** The notice and the Activity log together: where the failure may show. */
  const panelText = () => `${screen.getByTestId('notice').textContent}${screen.getByTestId('activity').textContent}`;

  it('headlines a needs_pairing failure with the short label and says the decision once', () => {
    renderGlob(
      stalledView(
        { reason: REASON, at: AT, kind: 'needs_pairing', decision: DECISION },
        {
          why: [`Failed: ${REASON}`],
          next: 'Answer the decision (ask the developer), then continue from phase 1.',
          detail: [`Decision needed: ${DECISION}`],
        },
        'stalled · needs your decision',
      ),
    );
    const headline = screen.getByTestId('header-status').textContent;
    expect(headline).toContain('needs your decision');
    expect(headline).not.toMatch(/stalled/i);
    expect(headline).not.toContain('Needs a decision before');
    const panel = panelText();
    expect(panel.split(DECISION).length - 1).toBe(1);
    expect(panel).not.toContain('Decision needed:');
  });

  it('shows a plain run failure once, not in the notice and the brief both', () => {
    renderGlob(
      stalledView(
        { reason: 'Could not reproduce the bug', at: AT },
        { why: ['Failed: Could not reproduce the bug'], next: 'Fix the cause, then continue from phase 1.', detail: [] },
        'stalled · run failed',
      ),
    );
    expect(screen.getByTestId('header-status').textContent).toContain('run failed');
    expect(screen.getByTestId('header-status').textContent).not.toMatch(/stalled/i);
    const panel = panelText();
    expect(panel.split('Could not reproduce the bug').length - 1).toBe(1);
  });
});

describe('glob view: Activity log', () => {
  const withRuns = (n: number) =>
    view({
      status: 'pr_open',
      pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
      runs: Array.from({ length: n }, (_, i) => ({
        id: `r${String(i)}`,
        state: 'ended' as const,
        outcome: 'failed' as const,
        generation: 1,
        triggeredBy: 'a',
        routineOwner: 'a',
        queuedAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
        startedAt: new Date(Date.UTC(2026, 9, 1, i, 1)).toISOString(),
        lastProgressAt: null,
        endedAt: new Date(Date.UTC(2026, 9, 1, i, 2)).toISOString(),
        failureReason: `reason ${String(i)}\nline two ${String(i)}`,
        sessionId: null,
        sessionUrl: 'https://claude.ai/code/s',
      })),
    });

  it('sits right under the actions, with the PR entry and a link for the run', () => {
    renderGlob(withRuns(1));
    const log = screen.getByTestId('activity');
    const actions = document.getElementById('section-actions');
    expect(actions?.compareDocumentPosition(log)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(log).getByText(/PR #7 ready for review/)).toBeTruthy();
    expect(within(log).getAllByRole('link', { name: 'session' }).length).toBeGreaterThan(0);
  });

  it('shows the last 8 with Show all, the only control: no expanders, a failure is one line with the full reason in its tooltip', async () => {
    const user = userEvent.setup();
    renderGlob(withRuns(6));
    expect(screen.getAllByTestId('activity-entry')).toHaveLength(8);
    await user.click(screen.getByTestId('activity-show-all'));
    expect(screen.getAllByTestId('activity-entry').length).toBeGreaterThan(8);
    expect(screen.queryByTestId('activity-more')).toBeNull();
    expect(screen.queryByTestId('activity-expand')).toBeNull();
    expect(screen.queryByTestId('machine-steps')).toBeNull();
    expect(screen.queryByText('Open session')).toBeNull();
    const failure = screen.getAllByTestId('activity-entry').find((e) => /Run failed/.test(e.textContent));
    expect(failure?.textContent).toContain('reason');
    expect(failure?.textContent).not.toContain('line two');
    expect(failure?.getAttribute('title')).toContain('line two');
    expect(failure?.className).toContain('text-red');
    expect(failure?.querySelector('svg')?.getAttribute('class')).toContain('text-red');
    expect(screen.getByTestId('activity-show-all').textContent).toBe('Show less');
    await user.click(screen.getByTestId('activity-show-all'));
    expect(screen.getAllByTestId('activity-entry')).toHaveLength(8);
  });
});

describe('glob view: title in the main content', () => {
  it('renders the title under the bar, not in it, and edits there', async () => {
    const user = userEvent.setup();
    const cb = renderGlob(view({ title: 'A long title '.repeat(12) }));
    const bar = screen.getByTestId('glob-header');
    const title = screen.getByTestId('glob-title');
    expect(bar.contains(title)).toBe(false);
    await user.click(screen.getByTestId('glob-title-edit'));
    const input = screen.getByTestId('glob-title-input');
    await user.clear(input);
    await user.type(input, 'New title{Enter}');
    expect(cb.onUpdate).toHaveBeenCalled();
  });
});

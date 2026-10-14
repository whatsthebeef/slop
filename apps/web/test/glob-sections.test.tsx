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
import { handoverKey } from '../src/lib/dismissals';

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
  onDismiss: vi.fn(() => Promise.resolve(true)),
  onAddStep: vi.fn(() => Promise.resolve(true)),
  onCompleteStep: vi.fn(() => Promise.resolve(true)),
  onDismissStep: vi.fn(() => Promise.resolve(true)),
  onDecide: vi.fn(() => Promise.resolve(true)),
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
    expect(screen.getByTestId('escalation-note').textContent).toContain('Touches auth');
    expect(screen.getByTestId('escalation-note').textContent).toContain('From the split of s1t0');
    expect(visibleText().split('Touches auth')).toHaveLength(2);
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
    expect(screen.getByTestId('escalation-note').textContent).toContain('Touches auth');
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
    expect(screen.getAllByText(/Error: boom/)).toHaveLength(1);
    expect(screen.getByTestId('activity-pinned').textContent).toContain('Error: boom');
    // Escalation reason appears only behind "Why a person?", never in Now.
    expect(screen.getByTestId('activity').textContent).not.toContain('Touches auth');
  });

  it('puts the status in the header, not in a Now panel, and the details in the Activity log below the actions', () => {
    renderGlob(fixing);
    expect(screen.queryByTestId('now-panel')).toBeNull();
    expect(screen.getByTestId('glob-header').contains(screen.getByTestId('header-status'))).toBe(true);
    expect(screen.getByTestId('header-status').textContent).not.toContain('Now:');
    expect(screen.getByTestId('glob-header').textContent).not.toMatch(/branch|v\d/);
    const log = screen.getByTestId('activity');
    expect(log.id).toBe('glob-activity');
    expect(log.textContent).toContain('Error: boom');
  });

  it("the viewer's turn: the headline and the handover brief inside the details", () => {
    renderGlob(
      view({
        status: 'pr_open',
        pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
        implementer: 'dev@example.com',
        allowedActions: ['pick_up'],
        move: { holder: 'you', reason: 'Merge', since: null, who: 'dev@example.com' },
        handover: { why: ['Checks failed on abcdef1'], next: 'Reproduce and fix', detail: [] },
      }),
    );
    expect(screen.getByTestId('header-status').textContent).toContain('Your turn · Merge');
    const details = screen.getByTestId('activity-pinned');
    expect(details.textContent).toContain("Why you're needed");
    expect(details.textContent).toContain('Reproduce and fix');
    expect(screen.getAllByText(/Why you're needed/)).toHaveLength(1);
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

  it('has no Related section content but the Add button for a glob with no relations, and never a Waits for input', () => {
    renderGlob(view({ status: 'planning', provisioning: 'none' }));
    expect(screen.getByTestId('related-toggle').textContent).toBe('Related (0)');
    expect(screen.getByTestId('related-toggle').closest('div')?.contains(screen.getByTestId('add-relation'))).toBe(true);
    expect(screen.getByTestId('related').className).not.toContain('border');
    expect(screen.queryByTestId('related-holding')).toBeNull();
    expect(screen.getByTestId('add-relation').textContent).toBe('Add relation');
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

  it('groups the relations: holding, decisions, parts, holds back and a collapsed Done, each row with its gate in words, reason and source', () => {
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
    expect(within(screen.getByTestId('related-holding')).getByText("· can't start until merged")).toBeTruthy();
    expect(screen.getByTestId('related-holding').textContent).toContain('uses the endpoint it adds');
    expect(screen.getByTestId('related-holding').textContent).toContain('inferred by slop');
    expect(screen.getByTestId('related-decisions').textContent).toContain("can't start until decided");
    expect(screen.getByTestId('related-parts').textContent).toContain("can't start until merged");
    expect(screen.getByTestId('related-holds-back').textContent).toContain("can't merge until this is merged");
    const done = screen.getByTestId('related-done');
    expect(done.tagName).toBe('DETAILS');
    expect(done.hasAttribute('open')).toBe(false);
    expect(done.textContent).toContain('s1t0');
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
    await userEvent.click(screen.getByTestId('add-relation'));
    await userEvent.type(screen.getByLabelText('Glob or decision'), 's1t9');
    expect(screen.getByLabelText<HTMLSelectElement>('Gate').value).toBe('start');
    await userEvent.type(screen.getByLabelText('Reason (optional)'), 'needs its schema');
    await userEvent.click(screen.getByTestId('add-relation-submit'));
    expect(cb.onAddRelation).toHaveBeenCalledWith({ gate: 'start', reason: 'needs its schema', to: 's1t9', version: 7 });
  });

  it('toggles the Related section, which starts open only while something holds the glob back, and the Add button toggles the form', async () => {
    renderGlob(view({ status: 'planning', provisioning: 'none', relations: related({ done: [{ relationId: 'rel_d', to: 's1t0', toTitle: null, gate: 'start', until: 'merged', reason: null, source: 'learned', how: 'met' }] }) }));
    expect(screen.getByTestId('related-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('related-done')).toBeNull();
    await userEvent.click(screen.getByTestId('related-toggle'));
    expect(screen.getByTestId('related-done')).toBeTruthy();
    await userEvent.click(screen.getByTestId('add-relation'));
    expect(screen.getByTestId('add-relation-form')).toBeTruthy();
    await userEvent.click(screen.getByTestId('add-relation'));
    expect(screen.queryByTestId('add-relation-form')).toBeNull();
  });

  it('starts the Related section open when something holds the glob back, and shows "N holding" once collapsed', async () => {
    renderGlob(view({ status: 'planning', provisioning: 'none', relations: related({ holding: [hold('s1t2'), hold('s1t3')] }) }));
    expect(screen.getByTestId('related-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('related-holding')).toBeTruthy();
    await userEvent.click(screen.getByTestId('related-toggle'));
    expect(screen.getByTestId('related-holding-count').textContent).toBe('2 holding');
  });

  it('keeps the form open and the text when the add failed', async () => {
    const cb = renderGlob(view({ status: 'planning', provisioning: 'none' }));
    cb.onAddRelation.mockResolvedValueOnce(false);
    await userEvent.click(screen.getByTestId('add-relation'));
    await userEvent.type(screen.getByLabelText('Glob or decision'), 's1t9');
    await userEvent.click(screen.getByTestId('add-relation-submit'));
    expect(screen.getByLabelText<HTMLInputElement>('Glob or decision').value).toBe('s1t9');
  });

  it('a decision glob has a Holds back list instead of Related, and adds a glob it holds back', async () => {
    const cb = renderGlob(
      view({
        category: 'decision',
        status: 'in_progress',
        allowedActions: ['decide'],
        attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'human', outcome: null },
        relations: related({ holdsBack: [{ relationId: 'rel_h', from: 's1t8', fromTitle: 'Later work', gate: 'start', until: 'decided', reason: 'waits on the choice', source: 'person' }] }),
      }),
    );
    expect(screen.queryByTestId('related')).toBeNull();
    expect(screen.getByTestId('add-relation').textContent).toBe('Holds back');
    expect(screen.getByTestId('holds-back-toggle').textContent).toBe('Holds back (1)');
    expect(screen.getByTestId('holds-back').textContent).toContain("can't start until this is decided");
    expect(screen.getByTestId('holds-back').textContent).toContain('waits on the choice');
    await userEvent.click(screen.getByTestId('add-relation'));
    await userEvent.type(screen.getByLabelText('Glob it holds back'), 's1t3');
    await userEvent.selectOptions(screen.getByLabelText('Gate'), 'merge');
    await userEvent.click(screen.getByTestId('add-relation-submit'));
    expect(cb.onAddRelation).toHaveBeenCalledWith({ gate: 'merge', holdsBack: 's1t3' });
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

describe('glob view: dismissable status messages', () => {
  const AT = '2026-10-08T10:00:00.000Z';
  const failed = (patch: Partial<GlobView> = {}) =>
    view({
      status: 'failed',
      failure: { reason: 'Could not reproduce the bug: a whole paragraph of detail', at: AT },
      implementer: 'dev@example.com',
      allowedActions: ['pick_up'],
      ...patch,
    });
  const buttons = () => screen.getAllByRole('button').map((b) => b.textContent);

  it('shows the long failure with a dismiss x that stores failure.at through onDismiss', async () => {
    const cb = renderGlob(failed());
    expect(screen.getByTestId('status-line').textContent).toContain('whole paragraph');
    await userEvent.click(screen.getByTestId('dismiss-message'));
    expect(cb.onDismiss).toHaveBeenCalledWith(`failure:${AT}`, true);
  });

  it('collapses a dismissed failure to the short label and keeps the main action; no expander', () => {
    renderGlob(failed());
    const before = buttons().filter((b) => b !== '' && !/Got it/.test(b));
    cleanup();
    renderGlob(failed({ dismissedKeys: [`failure:${AT}`] }));
    const line = screen.getByTestId('status-line');
    expect(line.getAttribute('data-dismissed')).toBe('true');
    expect(line.textContent).toContain('Run failed');
    expect(document.body.textContent).not.toContain('whole paragraph');
    expect(before.length).toBeGreaterThan(0);
    expect(buttons().filter((b) => b !== '' && b !== 'Show again')).toEqual(before);
    expect(screen.queryByTestId('show-details')).toBeNull();
  });

  it('shows a new failure again, undismissed', () => {
    renderGlob(failed({ dismissedKeys: [`failure:${AT}`], failure: { reason: 'A newer failure', at: '2026-10-09T09:00:00.000Z' } }));
    expect(screen.getByTestId('status-line').textContent).toContain('A newer failure');
    expect(screen.getByTestId('status-line').getAttribute('data-dismissed')).toBeNull();
  });

  it('undoes a dismissal with Show again', async () => {
    const cb = renderGlob(failed({ dismissedKeys: [`failure:${AT}`] }));
    await userEvent.click(screen.getByTestId('show-again'));
    expect(cb.onDismiss).toHaveBeenCalledWith(`failure:${AT}`, false);
  });

  it('handover Got it stores the brief key through the same onDismiss, and a dismissed brief is collapsed', async () => {
    const brief = { why: ['Checks failed on abcdef1'], next: 'Reproduce and fix', detail: [] };
    const turn = (patch: Partial<GlobView> = {}) =>
      view({
        status: 'pr_open',
        pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
        implementer: 'dev@example.com',
        allowedActions: ['pick_up'],
        move: { holder: 'you', reason: 'Merge', since: null, who: 'dev@example.com' },
        handover: brief,
        ...patch,
      });
    const cb = renderGlob(turn());
    await userEvent.click(within(screen.getByTestId('handover-box')).getByRole('button', { name: /Got it/ }));
    expect(cb.onDismiss).toHaveBeenCalledWith(handoverKey(brief), true);
    cleanup();
    renderGlob(turn({ dismissedKeys: [handoverKey(brief)] }));
    expect(within(screen.getByTestId('handover-box')).queryByRole('button', { name: /^Got it/ })).toBeNull();
  });
});

describe('glob view: Now panel for a stalled failure', () => {
  const AT = '2026-10-13T21:00:00.000Z';
  const REASON = `Needs a decision before it can go on. MARKER ${'The plan names infrastructure that does not exist. '.repeat(6)}`;
  const DECISION = 'Should the export be a CSV download or a stored report?';
  const stalledView = (failure: GlobView['failure'], brief: GlobView['handover'], label: string) =>
    view({
      status: 'failed',
      failure,
      implementer: 'dev@example.com',
      allowedActions: ['pick_up'],
      move: { holder: 'stalled', reason: REASON, label, since: AT, cause: 'failed' },
      handover: brief,
    });

  it('headlines a needs_pairing failure with the short label and shows the decision and the reason once', () => {
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
    const panel = screen.getByTestId('activity').textContent;
    expect(panel.split(DECISION).length - 1).toBe(1);
    expect(panel).not.toContain('Decision needed:');
    expect(panel.split('MARKER').length - 1).toBe(1);
    expect(screen.getByTestId('clamp-toggle').textContent).toBe('show more');
  });

  it('shows a plain run failure once, not in the status line and the brief both', () => {
    renderGlob(
      stalledView(
        { reason: 'Could not reproduce the bug', at: AT },
        { why: ['Failed: Could not reproduce the bug'], next: 'Fix the cause, then continue from phase 1.', detail: [] },
        'stalled · run failed',
      ),
    );
    expect(screen.getByTestId('header-status').textContent).toContain('run failed');
    expect(screen.getByTestId('header-status').textContent).not.toMatch(/stalled/i);
    const panel = screen.getByTestId('activity').textContent;
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

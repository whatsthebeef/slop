// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action } from '@slop/core';
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
  onDismiss: vi.fn(() => Promise.resolve(true)),
  onAddStep: vi.fn(() => Promise.resolve(true)),
  onCompleteStep: vi.fn(() => Promise.resolve(true)),
  onDismissStep: vi.fn(() => Promise.resolve(true)),
  onDecide: vi.fn(() => Promise.resolve(true)),
  onDelete: vi.fn(() => Promise.resolve()),
});

/** Renders the glob view with stubbed callbacks; the server is never reached (every fetch fails and the queries stay empty). */
const renderGlob = (glob: GlobView) => {
  const cb = callbacks();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobDetail board={board} glob={glob} initialArtifact={null} {...cb} />
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

  it('has no Waits for input: a glob in Planning shows only the edges slop inferred, with a ✕ to dismiss one', () => {
    renderGlob(view({ status: 'planning', provisioning: 'none' }));
    expect(screen.queryByTestId('dependencies')).toBeNull();
    expect(screen.queryByPlaceholderText('s15t7, s15b18')).toBeNull();
    expect(screen.queryByText('Waits for (glob IDs)')).toBeNull();
  });

  it('lists an inferred edge with its reason and a ✕, and never an input', () => {
    renderGlob(
      view({
        status: 'planning',
        provisioning: 'none',
        edges: [{ id: 's1t2', kind: 'overlaps', source: 'inferred', paths: [], evidence: 'both edit glob-dialog.tsx' }],
      }),
    );
    expect(screen.getByTestId('overlaps').textContent).toContain('both edit glob-dialog.tsx');
    expect(screen.getByTestId('dismiss-edge-s1t2')).toBeTruthy();
    expect(screen.queryByPlaceholderText('s15t7, s15b18')).toBeNull();
  });

  it('offers Save and Discard once the group is edited, and Discard clears them', async () => {
    renderGlob(view());
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Group'), 'x');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
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

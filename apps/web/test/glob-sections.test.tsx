// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action } from '@slop/core';
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
    expect(screen.getByTestId('now-headline').textContent).toMatch(/fix(ing)? (CI|checks)/i);
    expect(screen.getByTestId('now-panel').getAttribute('data-holder')).toBe('machine');
    expect(screen.queryByText(/Why you're needed/)).toBeNull();
    expect(screen.queryByTestId('handover-box')).toBeNull();
    expect(screen.queryByTestId('machine-steps')).toBeNull();
    expect(screen.getAllByTestId('escalation-chip')).toHaveLength(1);
    expect(screen.getAllByText(/Error: boom/)).toHaveLength(1);
    expect(screen.getByTestId('now-details').textContent).toContain('Error: boom');
    // Escalation reason appears only behind "Why a person?", never in Now.
    expect(screen.getByTestId('now-panel').textContent).not.toContain('Touches auth');
  });

  it('keeps the details collapsed under one toggle for a machine headline', () => {
    renderGlob(fixing);
    const details = screen.getByTestId<HTMLDetailsElement>('now-details');
    expect(details.open).toBe(false);
    expect(screen.getByText('Show details')).toBeTruthy();
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
    expect(screen.getByTestId('now-headline').textContent).toContain('Your turn · Merge');
    const details = screen.getByTestId('now-details');
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
    expect(screen.getByTestId('now-headline').textContent).not.toContain('Touches auth');
  });

  it('lets a glob in Planning edit what it waits for', async () => {
    renderGlob(view({ status: 'planning', provisioning: 'none' }));
    expect(screen.getByTestId('dependencies')).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText('s15t7, s15b18'), 's1t2');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
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

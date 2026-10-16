// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Action } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobDetail } from '../src/components/glob-dialog';
import type { BoardView, GlobView, ListedHumanStep } from '../src/lib/api';
import { board as coreBoard, glob as coreGlob } from '../../../packages/core/test/fixtures';

const board: BoardView = { ...coreBoard, role: 'dev' };
const NOW = '2026-10-14T00:00:00Z';
const files = ['apps/web/src/a.ts', 'apps/web/src/b.ts'];

const view = (patch: Partial<GlobView> = {}): GlobView => ({
  ...coreGlob(),
  list: 'planning',
  branch: 's1t1',
  currentRun: null,
  ...patch,
});

const renderGlob = (glob: GlobView) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobDetail
          board={board}
          glob={glob}
          initialArtifact={null}
          onClose={vi.fn()}
          onUpdate={vi.fn(() => Promise.resolve(null))}
          onReload={vi.fn(() => Promise.resolve())}
          onAction={vi.fn<(action: Action, anyway?: boolean) => Promise<boolean>>(() =>
            Promise.resolve(true),
          )}
          onReviewLabel={vi.fn()}
          onDismissEdge={vi.fn(() => Promise.resolve(true))}
          onAddRelation={vi.fn(() => Promise.resolve(true))}
          onAnswerQuestion={vi.fn(() => Promise.resolve(true))}
          onDismissQuestion={vi.fn(() => Promise.resolve(true))}
          onDismiss={vi.fn(() => Promise.resolve(true))}
          onDecide={vi.fn(() => Promise.resolve(true))}
          onAddStep={vi.fn(() => Promise.resolve(true))}
          onCompleteStep={vi.fn(() => Promise.resolve(true))}
          onDismissStep={vi.fn(() => Promise.resolve(true))}
          onDelete={vi.fn(() => Promise.resolve())}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no server in component tests'))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const dueStep: ListedHumanStep = {
  id: 'a',
  kind: 'rollout',
  title: 'Step a',
  who: 'admin',
  due: 'now',
  blocks: ['sign_off'],
  state: 'due',
};

/** A glob with a conflict with a non-main base, failed checks and a handover for the viewer, a label, a due step and an escalation. */
const everything = (patch: Partial<GlobView> = {}) =>
  view({
    status: 'pr_open',
    list: 'doing',
    pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
    implementer: 'dev@example.com',
    allowedActions: ['pick_up'],
    conflict: { base: 'develop', files, since: 's15f169', at: NOW },
    headChecks: {
      sha: 'abcdef1234567',
      state: 'failed',
      at: NOW,
      failure: {
        name: 'apps/web test',
        step: 'Test',
        lines: ['Error: boom'],
        url: 'https://ci/run/1',
      },
    },
    handover: {
      why: [
        'Conflicts with develop since s15f169 merged: apps/web/src/a.ts, apps/web/src/b.ts.',
        'Checks failed on abcdef1',
      ],
      next: 'Merge origin/develop, then fix the checks',
      detail: [],
    },
    move: { holder: 'you', reason: 'Merge', since: null, who: 'dev@example.com' },
    labels: { CR: 'required' },
    humanSteps: [dueStep],
    escalation: { at: NOW, by: 'dev@example.com', reason: 'Touches auth', criterion: 'risk_area' },
    ...patch,
  });

/** The blocks above the action button, in page order, by their test ids. */
const blocksAbove = (): string[] => {
  const actions = document.querySelector('[data-section="actions"]');
  expect(actions).not.toBeNull();
  return Array.from(document.querySelectorAll('[data-block]'))
    .filter(
      (node) =>
        actions !== null &&
        node.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    )
    .map((node) => node.getAttribute('data-testid') ?? '');
};

describe('the blocks above the action button', () => {
  it('come in one order: problems, then what needs a person, then information', () => {
    renderGlob(everything());
    // A glob in Doing shows no review block, whatever labels it carries.
    expect(blocksAbove()).toEqual([
      'conflict-block',
      'problem-block',
      'due-steps',
      'escalation-note',
    ]);
    const tones = Array.from(document.querySelectorAll('[data-block]')).map((n) =>
      n.getAttribute('data-block'),
    );
    expect(tones).toEqual(['problem', 'problem', 'person', 'info']);
  });

  it('shows the review blocks only once the glob is in Reviewing, not merged and still in Doing with its steps due', () => {
    const merged = {
      status: 'reviewing' as const,
      list: 'doing' as const,
      pr: { number: 7, state: 'merged' as const, headSha: 'abcdef1234567' },
      conflict: null,
      headChecks: null,
      handover: null,
      escalation: null,
      allowedActions: [],
      labels: { CR: 'required' as const, FR: 'required' as const, QA: 'required' as const },
      humanSteps: [dueStep],
    };
    renderGlob(everything(merged));
    expect(blocksAbove()).not.toContain('label-reviews');
    expect(screen.getByTestId('review-opens-later').textContent).toContain('review opens when they');
    cleanup();
    renderGlob(everything({ ...merged, list: 'reviewing', humanSteps: [] }));
    expect(blocksAbove()).toContain('label-reviews');
  });

  it('puts the size advice after the escalation, still above the action button', () => {
    renderGlob(
      view({
        status: 'planning',
        provisioning: 'none',
        runs: [],
        pr: null,
        allowedActions: ['start', 'delete'],
        oversized: true,
        labels: { CR: 'required' },
        humanSteps: [dueStep],
        escalation: {
          at: NOW,
          by: 'dev@example.com',
          reason: 'Touches auth',
          criterion: 'risk_area',
        },
      }),
    );
    const order = blocksAbove();
    expect(order.slice(-2)).toEqual(['escalation-note', 'oversized-proposal']);
    expect(order.indexOf('label-reviews')).toBeLessThan(order.indexOf('due-steps'));
    expect(order.indexOf('due-steps')).toBeLessThan(order.indexOf('escalation-note'));
  });

  it('show one block per source, each with a head, and every block is in the family (a bordered card with an actor icon)', () => {
    renderGlob(everything());
    const blocks = Array.from(document.querySelectorAll('[data-block]'));
    const ids = blocks.map((n) => n.getAttribute('data-testid'));
    expect(new Set(ids).size).toBe(ids.length);
    for (const block of blocks) {
      expect(block.className).toContain('rounded');
      expect(block.className).toContain('border');
      expect(
        within(block as HTMLElement).getAllByTestId('block-head').length,
      ).toBeGreaterThanOrEqual(1);
      expect(block.querySelector('[data-testid="block-head"] svg')).not.toBeNull();
    }
  });

  it('keeps the conflict once: the handover leaves out its own "Conflicts with" cause', () => {
    renderGlob(everything());
    expect(document.body.textContent.split('Conflicts with develop').length).toBe(2);
    const problem = screen.getByTestId('problem-block');
    expect(problem.textContent).not.toContain('Conflicts with develop');
    expect(problem.textContent).toContain('Checks failed on abcdef1');
    expect(problem.textContent).toContain('How to fix: Merge origin/develop, then fix the checks');
  });

  it('shows the conflict example for a non-main base, in plain text', () => {
    renderGlob(everything());
    const block = screen.getByTestId('conflict-block');
    expect(block.textContent.replace(/\s+/g, ' ')).toMatchInlineSnapshot(
      `"Conflicts with developSince s15f169 merged, both sides changed 2 files.Files changed on both sides (2)apps/web/src/a.tsapps/web/src/b.tsLet your Claude session merge develop: it resolves additive conflicts and asks you about the rest.sstor --glob s1t1CopyResolve by hand instead (advanced)git fetch origin develop && git checkout s1t1 && git merge origin/develop # resolve the conflicts, commit git push origin s1t1 # mergetool only, no Claude: sstor --glob s1t1 --resolve"`,
    );
    expect(block.textContent).not.toContain('origin/main');
    expect(block.querySelector('strong, em, a, h1, h2')).toBeNull();
  });

  it('shows the conflict fix line with the take-over command and no extra button besides Copy', () => {
    renderGlob(everything());
    const block = screen.getByTestId('conflict-block');
    expect(within(block).getByTestId('conflict-command').textContent).toBe('sstor --glob s1t1');
    expect(
      within(block)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Copy']);
  });

  it('renders no problem block for a healthy glob, and the other blocks only when they have something to say', () => {
    renderGlob(
      view({
        status: 'planning',
        provisioning: 'none',
        runs: [],
        pr: null,
        allowedActions: ['start'],
      }),
    );
    expect(document.querySelectorAll('[data-block]')).toHaveLength(0);
  });
  describe('normal states are not problems', () => {
    const calm = {
      conflict: null,
      handover: null,
      escalation: null,
      failure: null,
      allowedActions: [],
      labels: {},
    };

    it('shows no problem block for a merging glob, and the corner status still says it', () => {
      renderGlob(
        view({
          ...calm,
          status: 'merging',
          list: 'doing',
          pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
          headChecks: { sha: 'abcdef1234567', state: 'pending' },
        }),
      );
      expect(screen.queryByTestId('problem-block')).toBeNull();
      expect(screen.queryByTestId('dismiss-message')).toBeNull();
      expect(screen.getByTestId('header-status').textContent).toContain('merging');
    });

    it('shows the due steps and no Rollout problem block for a merged glob with steps due', () => {
      renderGlob(
        view({
          ...calm,
          status: 'reviewing',
          list: 'doing',
          pr: { number: 7, state: 'merged', headSha: 'abcdef1234567' },
          headChecks: null,
          humanSteps: [dueStep],
        }),
      );
      expect(screen.queryByTestId('problem-block')).toBeNull();
      expect(screen.getByTestId('due-steps')).not.toBeNull();
    });

    it('shows no problem block when the base is red', () => {
      renderGlob(
        view({
          ...calm,
          status: 'reviewing',
          list: 'reviewing',
          pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
          headChecks: {
            sha: 'abcdef1234567',
            state: 'failed',
            inheritedFrom: { base: 'main', since: null },
          } as never,
        }),
      );
      expect(screen.queryByTestId('problem-block')).toBeNull();
    });

    it('shows a red block with a dismiss control for failed checks on the glob\'s own change', () => {
      renderGlob(
        view({
          ...calm,
          status: 'reviewing',
          list: 'reviewing',
          pr: { number: 7, state: 'ready', headSha: 'abcdef1234567' },
          headChecks: { sha: 'abcdef1234567', state: 'failed' },
        }),
      );
      const block = screen.getByTestId('problem-block');
      expect(block.getAttribute('data-block')).toBe('problem');
      expect(within(block).getByTestId('dismiss-message')).not.toBeNull();
    });

    it('shows a red block with a dismiss control for a failed run', () => {
      renderGlob(
        view({
          ...calm,
          status: 'failed',
          list: 'doing',
          failure: { reason: 'Routine run failed', at: NOW },
        }),
      );
      const block = screen.getByTestId('problem-block');
      expect(within(block).getByTestId('dismiss-message')).not.toBeNull();
    });
  });
});

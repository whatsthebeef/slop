import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router';
import { GlobCard } from '../src/components/glob-card';
import type { CardMove } from '../src/components/glob-card';
import { HumanIcon, MachineIcon } from '../src/components/actor-icons';
import { actionPresentation } from '../src/lib/action-presentation';
import { positionOf } from '../src/lib/position';
import type { GlobView } from '../src/lib/api';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const noop = () => undefined;
const card = (g: GlobView, moves: readonly CardMove[] = []) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(GlobCard, {
        glob: g,
        onOpen: noop,
        onOpenSection: noop,
        onReviewLabel: noop as never,
        moves,
        previewing: null,
        onPreview: noop,
        onMove: noop,
        onArrow: noop,
      }),
    ),
  );

describe('actor icons (s15f88)', () => {
  it('labels MachineIcon and HumanIcon directly, and hides either when decorative', () => {
    expect(renderToStaticMarkup(createElement(MachineIcon))).toContain('aria-label="machine"');
    expect(renderToStaticMarkup(createElement(HumanIcon))).toContain('aria-label="human"');
    const hidden = renderToStaticMarkup(createElement(MachineIcon, { decorative: true }));
    expect(hidden).toContain('aria-hidden="true"');
    expect(hidden).not.toContain('aria-label');
  });
});

describe('actionPresentation state variants (s15f88)', () => {
  it('start_anyway in Doing with no implementer says the machine takes over, without a name', () => {
    const p = actionPresentation(
      'start_anyway',
      view({ status: 'in_progress', implementer: null }),
    );
    expect(p).toMatchObject({ label: 'Start', icon: 'machine', placement: 'more' });
    expect(p.tip).toBe('The machine takes over');
  });

  it('start_anyway in Planning says it starts ahead of what it waits for', () => {
    expect(actionPresentation('start_anyway', view({ status: 'planning' })).tip).toBe(
      'Starts before what it waits for has merged; its branch lacks their changes',
    );
  });

  it('pick_up outside Planning with no implementer takes it from the machine', () => {
    const p = actionPresentation('pick_up', view({ status: 'failed', implementer: null }));
    expect(p).toMatchObject({ label: 'Pick up', icon: 'human', placement: 'more' });
    expect(p.tip).toBe('You take it over from the machine');
  });

  it('pick_up in Planning for a sub is a More entry implemented in your session', () => {
    expect(actionPresentation('pick_up', view({ status: 'planning', type: 'sub' }))).toMatchObject({
      placement: 'more',
      tip: 'You implement it in your own session',
    });
  });

  it('Discard tips for same and super with a PR name the PR', () => {
    const pr = { number: 9, state: 'draft' as const, headSha: 'abc' };
    expect(actionPresentation('start_again', view({ type: 'same', pr })).tip).toBe(
      'Closes PR #9 and deletes the branch',
    );
    expect(actionPresentation('start_again', view({ type: 'super', pr })).tip).toBe(
      'Closes PR #9 and deletes the branch; it stays with you',
    );
    expect(actionPresentation('start_again', view({ type: 'sub', pr: null })).tip).toBe(
      'Deletes the branch, then a new machine run starts from the base branch',
    );
  });

  it('merge without a PR falls back to "the PR"', () => {
    expect(actionPresentation('merge', view({ pr: null })).tip).toContain('the checks on the head go green');
  });

  it('puts the type actions nowhere, since the type popover replaces them', () => {
    expect(actionPresentation('deescalate', view()).placement).toBe('none');
    expect(actionPresentation('make_super', view()).placement).toBe('none');
  });
});

describe('status-line activity icons (s15f88)', () => {
  const head = 'd16d563aaaa';
  const live = (state: 'queued' | 'active' | 'watching') => {
    const r = run({ state });
    return { runs: [r], currentRun: r };
  };

  it('marks the run states as machine work and drops the word Routine', () => {
    for (const state of ['active', 'queued'] as const) {
      const a = positionOf(view({ status: 'in_progress', ...live(state) }), NOW);
      expect(a?.holder, state).toBe('machine');
      expect(a?.text, state).not.toMatch(/routine/i);
    }
  });

  it('says what a run on an open PR is fixing', () => {
    const open = (state: 'passed' | 'failed') =>
      view({
        status: 'pr_open',
        pr: { number: 7, state: 'ready', headSha: head },
        headChecks: { sha: head, state },
        ...live('active'),
      });
    expect(positionOf(open('failed'), NOW)).toMatchObject({ holder: 'machine', text: 'fixing CI' });
    expect(positionOf(open('passed'), NOW)).toMatchObject({
      holder: 'machine',
      text: 'implementing',
    });
  });

  it('marks a picked-up glob with no run as human', () => {
    const later = new Date(Date.parse(NOW) + 5 * 60_000).toISOString();
    const picked = view({
      status: 'in_progress',
      implementer: 'dev@example.com',
      updatedAt: NOW,
      currentRun: null,
      runs: [],
    });
    expect(positionOf(picked, later)).toMatchObject({
      holder: 'human',
      text: 'picked up, no machine run',
    });
  });

  it('renders standby as a decorative icon followed by the word', () => {
    const step = { id: 'machine:standby', kind: 'standby', state: 'standby', startedAt: null, lastProgressAt: null, detail: null, holdsBall: false } as const;
    const html = card(view({ status: 'planning', machineSteps: [step], move: { holder: 'none', reason: '', since: null } as unknown as GlobView['move'] }));
    expect(html).toContain('data-kind="standby"');
    expect(html).toContain('data-icon="machine"');
    expect(html).toContain('>standby<');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('aria-label="machine"');
  });

  it('shows exactly one position indicator on a card, and no standby beside it', () => {
    const html = card(view({ status: 'in_progress', ...live('active') }));
    expect(html.split('data-testid="position"')).toHaveLength(2);
    expect(html.split('data-testid="card-status"')).toHaveLength(2);
    expect(html).not.toContain('>standby<');
  });
});

describe('escalation chip (s15f88)', () => {
  it('reads "Needs a person: <reason>" to screen readers and hides the person icon and visual words', () => {
    const html = card(
      view({
        status: 'planning',
        escalation: { reason: 'touches billing', at: NOW } as GlobView['escalation'],
      }),
    );
    expect(html).toContain('data-testid="escalation-chip"');
    expect(html).toMatch(
      /<span id="[^"]+" class="sr-only">Needs a person: touches billing\. Opens the reason\.<\/span>/,
    );
    // The chip opens the escalation section (s15f97), so it is a button named by its label.
    expect(html).toMatch(
      /<button[^>]*aria-label="Needs a person"[^>]*data-testid="escalation-chip"/,
    );
    expect(html.split('Needs a person: touches billing')).toHaveLength(2);
    expect(html).toMatch(
      /<span class="truncate" data-testid="status-text">needs a<\/span><svg[^>]*aria-hidden="true"/,
    );
  });

  it('is the one card status, in the header and not among the chips', () => {
    const html = card(
      view({
        status: 'planning',
        escalation: { reason: 'touches billing', at: NOW } as GlobView['escalation'],
      }),
    );
    expect(html.split('data-testid="card-status"')).toHaveLength(2);
    expect(html).toContain('data-kind="needs-human"');
    expect(html.indexOf('data-testid="escalation-chip"')).toBeLessThan(html.indexOf('data-testid="card-chips"'));
  });

  it('shows no escalation chip outside Planning', () => {
    const html = card(
      view({
        status: 'in_progress',
        escalation: { reason: 'x', at: NOW } as GlobView['escalation'],
      }),
    );
    expect(html).not.toContain('escalation-chip');
  });
});

describe('card moves (s15f88)', () => {
  it('shows the actor icon, hidden from screen readers, beside the move label', () => {
    const g = view({ status: 'planning' });
    const move = (action: 'start' | 'pick_up'): CardMove => {
      const { label, tip, icon } = actionPresentation(action, g);
      return {
        action,
        direction: 'right',
        label: `${label} ▸`,
        description: `${label} ${g.id}: ${tip}`,
        icon,
      };
    };
    const html = card(g, [move('start'), move('pick_up')]);
    expect(html).toMatch(
      /data-testid="move-start"[^>]*><svg[^>]*lucide-bot[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Start ▸/,
    );
    expect(html).toMatch(
      /data-testid="move-pick_up"[^>]*><svg[^>]*lucide-user-round[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Pick up ▸/,
    );
  });
});

describe('a conflict-fix run that went to standby (s15b86)', () => {
  const fixed = (state: 'active' | 'watching') =>
    view({
      status: 'pr_open',
      type: 'sub',
      implementer: null,
      conflict: null,
      pr: { number: 1, state: 'ready', headSha: 'abc1234' },
      headChecks: null,
      runs: [run({ state, purpose: 'resolve_conflict' })],
    });

  it('watching: standby, never "fixing", no spinner; active: fixing with a spinner', () => {
    const watching = positionOf(fixed('watching'), NOW);
    expect(watching?.text ?? '').not.toMatch(/fixing/);
    expect(watching?.spinning ?? false).toBe(false);
    // On the card: the status is never fixing, and nothing spins.
    const standby = card(fixed('watching'));
    expect(standby).toContain('data-testid="card-status"');
    expect(standby).not.toMatch(/fixing|animate-spin/);
    expect(positionOf(fixed('active'), NOW)).toMatchObject({
      holder: 'machine',
      text: 'fixing the conflict',
      spinning: true,
    });
    // While the fix runs the status says so, with a spinner in the corner.
    // The card reads the clock, so the run must be fresh for it.
    const justNow = new Date().toISOString();
    const fresh = view({ ...fixed('active'), runs: [run({ state: 'active', purpose: 'resolve_conflict', startedAt: justNow, lastProgressAt: justNow })] });
    const fixing = card(fresh);
    expect(fixing).toMatch(/data-testid="position"[^>]*>.*?<span class="truncate" data-testid="status-text">fixing the conflict<\/span>/);
    expect(fixing).toContain('animate-spin');
  });

  it('checks pending after the fix: "checks running", not fixing', () => {
    const g = view({ ...fixed('watching'), headChecks: { sha: 'abc1234', state: 'pending' } });
    expect(positionOf(g, NOW)).toMatchObject({ holder: 'waiting' });
    expect(positionOf(g, NOW)?.text).toContain('checks running on abc1234');
  });
});

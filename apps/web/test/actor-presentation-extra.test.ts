import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router';
import { ActivityLabel, GlobCard } from '../src/components/glob-card';
import type { CardMove } from '../src/components/glob-card';
import { HumanIcon, MachineIcon } from '../src/components/actor-icons';
import { actionPresentation } from '../src/lib/action-presentation';
import { activityLabel } from '../src/lib/status-line';
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
        onOpenArtifact: noop,
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
    expect(actionPresentation('merge', view({ pr: null })).tip).toBe('Squash-merges the PR');
  });

  it('puts the type actions nowhere, since the type popover replaces them', () => {
    expect(actionPresentation('deescalate', view()).placement).toBe('none');
    expect(actionPresentation('make_super', view()).placement).toBe('none');
  });
});

describe('status-line activity icons (s15f88)', () => {
  const head = 'd16d563aaaa';
  const live = (state: 'queued' | 'active' | 'watching') => ({ currentRun: run({ state }) });

  it('marks the run states as machine work and drops the word Routine', () => {
    for (const state of ['active', 'watching', 'queued'] as const) {
      const a = activityLabel(view(live(state)), NOW);
      expect(a?.icon, state).toBe('machine');
      expect(a?.text, state).not.toMatch(/routine/i);
    }
  });

  it('says what a run on an open PR is fixing, with the machine icon', () => {
    const open = (state: 'passed' | 'failed') =>
      view({
        status: 'pr_open',
        pr: { number: 7, state: 'ready', headSha: head },
        headChecks: { sha: head, state },
        ...live('active'),
      });
    expect(activityLabel(open('failed'), NOW)).toMatchObject({
      kind: 'working',
      text: 'fixing CI',
      icon: 'machine',
    });
    expect(activityLabel(open('passed'), NOW)).toMatchObject({
      kind: 'working',
      text: 'answering review',
      icon: 'machine',
    });
  });

  it('marks a picked-up glob with no run as human', () => {
    const later = new Date(Date.parse(NOW) + 30 * 60_000).toISOString();
    const picked = view({
      status: 'in_progress',
      implementer: 'dev@example.com',
      updatedAt: NOW,
      currentRun: null,
    });
    expect(activityLabel(picked, later)).toMatchObject({
      kind: 'picked_up',
      text: 'picked up, no machine run',
      icon: 'human',
    });
  });

  it('renders the activity icon as decorative beside the text', () => {
    const html = renderToStaticMarkup(
      createElement(ActivityLabel, { glob: view(live('watching')) }),
    );
    expect(html).toContain('standby');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('aria-label="machine"');
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
      /<span id="[^"]+" class="sr-only">Needs a person: touches billing<\/span>/,
    );
    expect(html.split('Needs a person: touches billing')).toHaveLength(2);
    expect(html).toMatch(
      /<span aria-hidden="true" class="inline-flex items-center gap-1">needs a <svg[^>]*aria-hidden="true"/,
    );
  });

  it('sits in the right-aligned group, after the status chips', () => {
    const html = card(
      view({
        status: 'planning',
        escalation: { reason: 'touches billing', at: NOW } as GlobView['escalation'],
      }),
    );
    const group = html.indexOf('class="ml-auto inline-flex items-center gap-1"');
    expect(group).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="escalation-chip"')).toBeGreaterThan(group);
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

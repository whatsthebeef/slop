// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearnedArea } from '../src/components/learned/area';
import { LEARNED_PANELS } from '../src/lib/learned';
import type { LearnedPanelId } from '../src/lib/learned';

const api = vi.hoisted(() => ({
  sizeThreshold: vi.fn(),
  sizeCalibration: vi.fn(),
  subLimit: vi.fn(),
  riskAreas: vi.fn(),
  escalations: vi.fn(),
  dependencyRules: vi.fn(),
  typeLearning: vi.fn(),
  intakeAccuracy: vi.fn(),
  contextReport: vi.fn(),
  boardJobs: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({ ...(await original<typeof import('../src/lib/api')>()), api: { ...api } }));

const OLD = '2026-09-01T00:00:00.000Z';
const NEW = '2026-10-01T00:00:00.000Z';
const scrolled = vi.fn();

// The server's order is oldest first here: the panels must show the newest first themselves.
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrolled });
  const threshold = (maxTasks: number) => ({ maxTasks, maxParts: 4, minParallel: 2 });
  const sizeChange = (id: number, at: string, globId: string) => ({
    id,
    boardId: 1,
    at,
    from: threshold(5),
    to: threshold(6),
    outcome: 'kept_whole_clean',
    globId,
    evidence: 'merged cleanly',
  });
  api.sizeThreshold.mockResolvedValue({
    current: threshold(6),
    defaults: { maxTasks: 5, maxParts: 3, minParallel: 2 },
    bounds: { tasks: { min: 3, max: 12 }, parts: { min: 2, max: 8 }, parallel: { min: 2, max: 6 }, step: 1 },
    history: [sizeChange(1, OLD, 's1t1'), sizeChange(2, NEW, 's1t2')],
  });
  const calibrationChange = (id: number, at: string, globId: string, cause: string) => ({
    id,
    boardId: 1,
    at,
    globId,
    kind: 'weights',
    area: null,
    from: { weights: { code: 0.6, reference: 0.3, text: 0.1 } },
    to: { weights: { code: 0.5, reference: 0.3, text: 0.2 } },
    cause,
  });
  api.sizeCalibration.mockResolvedValue({
    current: { weights: { code: 0.5, reference: 0.3, text: 0.2 }, areaFactors: {}, samples: 4 },
    defaults: { weights: { code: 0.6, reference: 0.3, text: 0.1 }, areaFactors: {}, samples: 0 },
    history: [calibrationChange(1, OLD, 's1t3', 'older cause'), calibrationChange(2, NEW, 's1t4', 'newer cause')],
  });
  const subChange = (id: number, at: string, globId: string) => ({
    id,
    boardId: 1,
    at,
    fromLines: 5000,
    toLines: 6000,
    outcome: 'merged_unchanged',
    globId,
    changedLines: 7000,
    evidence: 'converted and merged',
    step: 500,
  });
  api.subLimit.mockResolvedValue({
    current: 6000,
    bounds: { min: 200, max: 10_000, step: 500, startStep: 500 },
    history: [subChange(1, OLD, 's1t5'), subChange(2, NEW, 's1t6')],
  });
  const area = (name: string, source: string, evidence: string[]) => ({
    boardId: 1,
    name,
    pathPatterns: ['db/**'],
    why: `${name} matters`,
    source,
    strength: 3,
    cleanCount: 0,
    updatedAt: OLD,
    subSafe: false,
    evidence,
  });
  const riskChange = (id: number, at: string, globId: string) => ({ id, boardId: 1, at, areaName: 'Billing', kind: 'added', globId, cause: 'reverted' });
  api.riskAreas.mockResolvedValue({
    areas: [area('Migrations', 'default', []), area('Billing', 'learned', ['s1t20'])],
    history: [riskChange(1, OLD, 's1t7'), riskChange(2, NEW, 's1t8')],
  });
  const record = (id: number, at: string, globId: string) => ({ id, boardId: 1, at, globId, criterion: 'size', outcome: 'justified', weight: 1, cause: 'justified' });
  api.escalations.mockResolvedValue({
    criteria: [
      { criterion: 'size', text: 'Bigger than a sub should be', score: 0, stance: 'default', unnecessary: 0, justified: 1, missed: 0 },
      { criterion: 'risk', text: 'Touches a risk area', score: -3, stance: 'loosened', unnecessary: 3, justified: 0, missed: 0 },
    ],
    history: [record(1, OLD, 's1t9'), record(2, NEW, 's1t10')],
  });
  const rule = (pattern: string, state: string) => ({ pattern, weight: state === 'learned' ? 0.5 : 1, defaultWeight: 1, state, predicted: true, cleanCount: 1, conflictCount: 0, updatedAt: null });
  const ruleChange = (id: number, at: string, globId: string) => ({ id, boardId: 1, at, pattern: 'src/**', from: 1, to: 0.8, cause: 'clean_overlap', globId, evidence: 'merged clean' });
  api.dependencyRules.mockResolvedValue({
    rules: [rule('migrations/**', 'default'), rule('src/**', 'learned')],
    history: [ruleChange(1, OLD, 's1t11'), ruleChange(2, NEW, 's1t12')],
    predictMin: 0.3,
  });
  const correction = (id: number, at: string, globId: string) => ({
    id,
    boardId: 1,
    globId,
    fromType: 'sub',
    toType: 'same',
    actor: 'a@b.c',
    at,
    signals: { openQuestions: 1, decisionWording: false, riskAreaFiles: [], sizeTasks: 2 },
    resetAt: null,
  });
  api.typeLearning.mockResolvedValue({
    learned: true,
    defaults: [{ when: 'a small, well-understood change', type: 'sub' }],
    corrections: [correction(1, OLD, 's1t13'), correction(2, NEW, 's1t14')],
  });
  api.intakeAccuracy.mockResolvedValue({
    snapshots: 10,
    merged: 8,
    corrected: 2,
    byMonth: [
      { key: '2026-09', merged: 4, corrected: 1, rate: 0.25 },
      { key: '2026-10', merged: 4, corrected: 1, rate: 0.25 },
    ],
    byPromptVersion: [{ key: 'v1', merged: 8, corrected: 2, rate: 0.25 }],
    byKind: [{ key: 'sub/feature', merged: 8, medianChangedLines: 120, medianCalendarHours: 3, medianReviewRounds: 1 }],
  });
  const contextChange = (id: number, at: string, evidence: string) => ({ id, boardId: 1, at, key: 'discussion_weight', before: 0.6, after: 0.55, outcome: 'signal', evidence });
  api.contextReport.mockResolvedValue({
    generatedAt: NEW,
    windowDays: 30,
    retrievals: { total: 0, bySource: [], byTier: [] },
    topRetrieved: [],
    choices: {
      total: 0,
      bySource: [],
      newThisWeek: 0,
      replaced: { autoApplied: 0, confirmed: 0, undone: 0 },
      cards: { confirmed: 0, dismissed: 0 },
      promoted: { raised: 0, accepted: 0, rejected: 0 },
    },
    conflicts: [],
    conflictsNote: '',
    inbox: { attachedViaSuggestion: 0, attachedElsewhere: 0, kept: 0, discarded: 0 },
    settings: [
      { key: 'discussion_weight', label: 'Discussion weight', unit: 'weight', effect: 'How much discussion counts', default: 0.6, min: 0.3, max: 0.95, step: 0.05, learned: true, value: 0.55 },
    ],
    history: [contextChange(1, OLD, 'older evidence'), contextChange(2, NEW, 'newer evidence')],
  });
  api.boardJobs.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderArea = (admin: boolean, linked: LearnedPanelId | null = null) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <LearnedArea boardId={1} admin={admin} linked={linked} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const open = async (id: LearnedPanelId) => {
  await userEvent.setup().click(screen.getByTestId(`learned-${id}-toggle`));
  return screen.getByTestId(`learned-${id}`);
};

interface Case {
  id: LearnedPanelId;
  /** Waits for the panel's data. */
  ready: RegExp;
  value: string;
  defaultText: string;
  /** Each history, with what its newest and its oldest row say. */
  histories: { testId: string; newest: string; oldest: string }[];
  /** The buttons an admin gets here and a member doesn't. */
  actions: RegExp[];
}

const CASES: Case[] = [
  {
    id: 'size',
    ready: /flagged as big above/,
    value: 'A glob is flagged as big above 6 tasks or 4 independent parts, when at least 2 could be built at once (learned from outcomes).',
    defaultText: 'Default: 5 tasks, 3 independent parts, fan-out from 2 parallel.',
    histories: [
      { testId: 'size-threshold-history', newest: 's1t2', oldest: 's1t1' },
      { testId: 'size-calibration-history', newest: 's1t4', oldest: 's1t3' },
    ],
    actions: [/^Reset to defaults$/, /^Run now$/],
  },
  {
    id: 'subs',
    ready: /more than 6,000 lines/,
    value: 'A sub that changes more than 6,000 lines becomes a same (learned from outcomes).',
    defaultText: 'Default: 5,000 lines.',
    histories: [{ testId: 'sub-limit-history', newest: 's1t6', oldest: 's1t5' }],
    actions: [/^Run now$/],
  },
  {
    id: 'risk-areas',
    ready: /touches one of 2 areas/,
    value: "Intake sends work to a person's review when it touches one of 2 areas (1 learned from outcomes).",
    defaultText: 'Default areas: Migrations.',
    histories: [{ testId: 'risk-areas-history', newest: 's1t8', oldest: 's1t7' }],
    actions: [/^Reset to defaults$/, /^Remove$/],
  },
  {
    id: 'escalations',
    ready: /for 2 reasons/,
    value: 'Agents hand a sub to a person for 2 reasons; 1 has moved from the default.',
    defaultText: 'Default: every criterion starts at its default stance',
    histories: [{ testId: 'escalations-history', newest: 's1t10', oldest: 's1t9' }],
    actions: [/^Reset to defaults$/],
  },
  {
    id: 'dependency-rules',
    ready: /from 2 path patterns/,
    value: 'Slop predicts shared files from 2 path patterns; 1 has been learned away from it.',
    defaultText: 'Default: each pattern starts at the weight the catalog gives it',
    histories: [{ testId: 'dependency-rules-history', newest: 's1t12', oldest: 's1t11' }],
    actions: [/^Reset$/],
  },
  {
    id: 'intake',
    ready: /2 of 8 merged globs/,
    value: 'Intake follows the latest 2 changes people made to a type',
    defaultText: 'Default: sub for a small, well-understood change',
    histories: [
      { testId: 'type-learning-history', newest: 's1t14', oldest: 's1t13' },
      { testId: 'intake-accuracy-history', newest: '2026-10', oldest: '2026-09' },
    ],
    actions: [/^Reset to defaults$/, /^Run now$/],
  },
  {
    id: 'context',
    ready: /tunes 1 of 1 context settings/,
    value: 'Slop tunes 1 of 1 context settings; 1 is away from its default.',
    defaultText: 'Default: each setting starts at the value shown under Default below',
    histories: [{ testId: 'context-history-block', newest: 'newer evidence', oldest: 'older evidence' }],
    actions: [/^Reset to default$/, /^Run now$/],
  },
  {
    id: 'jobs',
    ready: /Three jobs keep/,
    value: "Three jobs keep the board's learnings up to date",
    defaultText: 'Default: they run on their own schedule',
    histories: [],
    actions: [/^Run now$/],
  },
];

describe('What slop has learned', () => {
  it('has one panel per topic, all collapsed, and loads nothing until one is opened', () => {
    renderArea(true);
    expect(LEARNED_PANELS.map((p) => p.title)).toEqual([
      'Size',
      'Subs',
      'Risk areas',
      'Escalation criteria',
      'Dependency rules',
      'Intake',
      'Context tuning',
      'Learning jobs',
    ]);
    for (const { id, title, blurb } of LEARNED_PANELS) {
      const toggle = screen.getByTestId(`learned-${id}-toggle`);
      expect(toggle.textContent).toBe(title);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(screen.getByTestId(`learned-${id}`).textContent).toContain(blurb);
    }
    for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
  });

  it.each(CASES)('$id: shows the value in words, the default, the history newest first and collapsed', async (c) => {
    renderArea(false);
    const panel = await open(c.id);
    await within(panel).findByText(c.ready, { exact: false });
    expect(panel.textContent).toContain(c.value);
    expect(panel.textContent).toContain(c.defaultText);
    for (const h of c.histories) {
      const history = within(panel).getByTestId(h.testId);
      expect(within(history).getByRole('button', { name: /^History: \d+ (changes?|periods?), newest first$/ }).getAttribute('aria-expanded')).toBe('false');
      expect(history.textContent).not.toContain(h.oldest);
      await userEvent.setup().click(within(history).getByTestId(`${h.testId}-toggle`));
      const text = history.textContent;
      expect(text).toContain(h.newest);
      expect(text.indexOf(h.newest)).toBeLessThan(text.indexOf(h.oldest));
    }
  });

  it.each(CASES)('$id: offers its admin actions to admins only', async (c) => {
    const { unmount } = renderArea(true);
    let panel = await open(c.id);
    await within(panel).findByText(c.ready, { exact: false });
    for (const name of c.actions) expect(within(panel).getAllByRole('button', { name }).length).toBeGreaterThan(0);
    unmount();

    renderArea(false);
    panel = await open(c.id);
    await within(panel).findByText(c.ready, { exact: false });
    expect(within(panel).queryAllByRole('button', { name: /^(Reset|Remove|Run now)/ })).toEqual([]);
  });

  it('opens the panel a link names and scrolls to it, leaving the others closed', () => {
    renderArea(false, 'risk-areas');
    expect(screen.getByTestId('learned-risk-areas-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('learned-size-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(scrolled).toHaveBeenCalledTimes(1);
  });
});

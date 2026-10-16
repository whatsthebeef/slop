// @vitest-environment jsdom
import type { RelationLearningView, RelationSourceView } from '@slop/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countsLine, RelationsGroup } from '../src/components/settings/relations-group';

const api = vi.hoisted(() => ({
  relationLearning: vi.fn(),
  pinRelationLearning: vi.fn(),
  resetRelationLearning: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({ ...(await original<typeof import('../src/lib/api')>()), api: { ...api } }));

const thresholds = { windowDays: 90, precision: 0.5, recall: 0.5, minSamples: 5 };

const source = (name: RelationSourceView['source'], patch: Partial<RelationSourceView> = {}): RelationSourceView => ({
  source: name,
  counts: {},
  tp: 0,
  fp: 0,
  fn: 0,
  precision: null,
  recall: null,
  precisionSamples: 0,
  recallSamples: 0,
  posture: { source: name, posture: 'gate', bold: false, pinned: false, measured: false, why: 'not enough data (0 of 5 samples)' },
  ...patch,
} as RelationSourceView);

const view = (patch: Partial<RelationLearningView> = {}): RelationLearningView => ({
  thresholds,
  defaults: thresholds,
  pins: {},
  sources: [
    source('mention', {
      tp: 2,
      fp: 6,
      precision: 0.25,
      precisionSamples: 8,
      posture: { source: 'mention', posture: 'weak', bold: false, pinned: false, measured: true, why: 'precision 25% is below 50% over 8 samples' },
    }),
    source('inferred', {
      tp: 6,
      fp: 1,
      fn: 5,
      precision: 6 / 7,
      recall: 6 / 11,
      precisionSamples: 7,
      recallSamples: 11,
      posture: { source: 'inferred', posture: 'gate', bold: false, pinned: true, measured: true, why: 'pinned to gate by an admin' },
    }),
    source('agent'),
    source('person'),
  ],
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  api.relationLearning.mockResolvedValue(view());
  api.pinRelationLearning.mockResolvedValue(view());
  api.resetRelationLearning.mockResolvedValue(view());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderGroup = (admin: boolean) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RelationsGroup boardId={1} admin={admin} />
    </QueryClientProvider>,
  );

describe('Settings: Relations', () => {
  it('shows each source with its precision, recall, counts, window, posture and why', async () => {
    renderGroup(false);
    const mention = await screen.findByTestId('relation-source-mention');
    expect(mention.textContent).toContain('Precision 25% (8 samples)');
    expect(mention.textContent).toContain('recall not measured');
    expect(mention.textContent).toContain('2 needed · 6 not needed · 0 missed');
    expect(mention.textContent).toContain('last 90 days');
    expect(screen.getByTestId('relation-posture-mention').textContent).toBe('weak links only');
    expect(screen.getByTestId('relation-why-mention').textContent).toBe('precision 25% is below 50% over 8 samples');
    const inferred = screen.getByTestId('relation-source-inferred');
    expect(inferred.textContent).toContain('recall 55% (11 samples)');
    expect(screen.getByTestId('relation-posture-agent').textContent).toBe('gates (not enough data)');
    expect(screen.getByTestId('relation-why-agent').textContent).toContain('not enough data');
    expect(countsLine({ tp: 1, fp: 2, fn: 3 })).toBe('1 needed · 2 not needed · 3 missed');
  });

  it('marks a pinned posture and a pinned threshold', async () => {
    api.relationLearning.mockResolvedValue(view({ pins: { minSamples: 8, postures: { inferred: 'gate' } }, thresholds: { ...thresholds, minSamples: 8 } }));
    renderGroup(false);
    await screen.findByTestId('relation-source-mention');
    expect(screen.getByTestId('relation-pinned-inferred')).toBeTruthy();
    expect(screen.queryByTestId('relation-pinned-mention')).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('relation-pin-minSamples').value).toBe('8');
    expect(screen.getByText(/Minimum samples · pinned/)).toBeTruthy();
  });

  it('is read-only for a non-admin', async () => {
    renderGroup(false);
    await screen.findByTestId('relation-source-mention');
    expect(screen.queryByLabelText(/Posture of/)).toBeNull();
    expect(screen.queryByTestId('relation-reset')).toBeNull();
    expect(screen.queryByTestId('relation-pin-save')).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('relation-pin-windowDays').disabled).toBe(true);
  });

  it('lets an admin pin a posture, pin a threshold in percent, and reset', async () => {
    const user = userEvent.setup();
    renderGroup(true);
    const mention = await screen.findByTestId('relation-source-mention');
    // Only the sources that can be weakened have a posture control.
    expect(within(screen.getByTestId('relation-source-agent')).queryByRole('combobox')).toBeNull();
    await user.selectOptions(within(mention).getByRole('combobox'), 'gate');
    await waitFor(() => expect(api.pinRelationLearning).toHaveBeenCalledWith(1, { postures: { mention: 'gate' } }));

    const inferred = screen.getByTestId('relation-source-inferred');
    await user.selectOptions(within(inferred).getByRole('combobox'), 'learned');
    await waitFor(() => expect(api.resetRelationLearning).toHaveBeenCalledWith(1, 'inferred'));

    expect(screen.getByTestId<HTMLButtonElement>('relation-pin-save').disabled).toBe(true);
    const precision = screen.getByTestId('relation-pin-precisionThreshold');
    await user.clear(precision);
    await user.type(precision, '60');
    await user.click(screen.getByTestId('relation-pin-save'));
    await waitFor(() => expect(api.pinRelationLearning).toHaveBeenCalledWith(1, { precisionThreshold: 0.6 }));

    // Nothing pinned in the view: Reset is off until there is something to drop.
    expect(screen.getByTestId<HTMLButtonElement>('relation-reset').disabled).toBe(true);
  });

  it('resets every pin', async () => {
    api.relationLearning.mockResolvedValue(view({ pins: { windowDays: 30 }, thresholds: { ...thresholds, windowDays: 30 } }));
    const user = userEvent.setup();
    renderGroup(true);
    await user.click(await screen.findByTestId('relation-reset'));
    await waitFor(() => expect(api.resetRelationLearning).toHaveBeenCalledWith(1));
  });
});

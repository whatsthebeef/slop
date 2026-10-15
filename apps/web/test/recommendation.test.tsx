// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { Recommendation } from '../src/components/decision-outcomes';
import type { GlobView } from '../src/lib/api';
import { glob } from '../../../packages/core/test/fixtures';

afterEach(cleanup);

const stored = { action: 'approve', reason: 'Matches the code.', mergeInto: null } as never;
const show = (suggest: { state: string; stored?: unknown }) =>
  render(
    <MemoryRouter>
      <Recommendation glob={glob() as GlobView} suggest={{ error: null, failed: false, busy: false, prefill: null, ask: () => undefined, ...suggest } as never} />
    </MemoryRouter>,
  );

describe('Recommendation', () => {
  it('keeps the old recommendation, marked as being refreshed, while a new one is made', () => {
    show({ state: 'working', stored });
    expect(screen.getByTestId('suggest-refreshing')).toBeTruthy();
    expect(screen.getByTestId('suggestion').textContent).toContain('Matches the code.');
  });

  it('shows a ready recommendation without the refreshing note', () => {
    show({ state: 'ready', stored });
    expect(screen.queryByTestId('suggest-refreshing')).toBeNull();
    expect(screen.getByTestId('suggestion')).toBeTruthy();
  });

  it('shows neither while the first one is being made', () => {
    show({ state: 'working' });
    expect(screen.queryByTestId('suggest-refreshing')).toBeNull();
    expect(screen.queryByTestId('suggestion')).toBeNull();
  });
});

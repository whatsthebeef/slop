// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepDetail } from '../src/components/step-detail';

afterEach(cleanup);

const DETAIL = [
  '- **Why:** the board needs it.',
  '- **Do this:** run:',
  '```bash',
  'echo ok',
  '```',
  '- **Check it worked:** it shows Approved.',
].join('\n');

describe('StepDetail', () => {
  it('renders the Markdown detail and gives a code block a copy button', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<StepDetail detail={DETAIL} />);
    expect(screen.getByText('Why:').tagName).toBe('STRONG');
    expect(screen.getByText('Check it worked:')).toBeTruthy();
    await userEvent.click(screen.getByTestId('step-code-copy'));
    expect(writeText).toHaveBeenCalledWith('echo ok');
  });
});

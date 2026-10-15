// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineMarkdown, MarkdownView } from '../src/components/markdown-view';

afterEach(cleanup);

describe('shared Markdown rendering', () => {
  it('renders bold, inline code and a code block whose Copy writes only the code', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    render(<MarkdownView content={'**bold** `code`\n\n```\nls -la\n```'} />);
    expect(screen.getByTestId('markdown-view').querySelector('strong')?.textContent).toBe('bold');
    await userEvent.click(screen.getByTestId('step-code-copy'));
    expect(write).toHaveBeenCalledWith('ls -la');
  });

  it('shows raw HTML as text instead of injecting it', () => {
    render(<MarkdownView content={'<img src=x onerror="alert(1)"> <script>alert(1)</script>'} />);
    const view = screen.getByTestId('markdown-view');
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('script')).toBeNull();
  });

  it('renders inline Markdown inside a sentence without a paragraph break', () => {
    render(<p data-testid="host">Because <InlineMarkdown text="the **host** is `down`" /></p>);
    const host = screen.getByTestId('host');
    expect(host.textContent).toBe('Because the host is down');
    expect(host.querySelector('p')).toBeNull();
    expect(host.querySelector('strong')?.textContent).toBe('host');
  });

  it('flattens blocks inside an inline slot so nothing block-level nests in a paragraph', () => {
    render(<p data-testid="host"><InlineMarkdown text={'see:\n\n```\nmake ship\n```\n\n- one\n- two'} /></p>);
    const host = screen.getByTestId('host');
    expect(host.querySelector('div, pre, ul, li')).toBeNull();
    expect(host.textContent).toContain('make ship');
  });
});

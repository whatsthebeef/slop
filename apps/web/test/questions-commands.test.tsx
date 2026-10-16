// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { OpenQuestion } from '@slop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownView } from '@/components/markdown-view';
import { CommandBox } from '@/components/human-steps';

const q: OpenQuestion = {
  id: 'q1',
  text: 'Run `bash .reviews/x.sh <profile>` first. Is it fine?',
  commands: ['git status'],
  raisedBy: { kind: 'agent', actor: null },
  source: 'other',
  blocking: 'merge',
  raisedAt: '2026-10-16T00:00:00Z',
};

afterEach(cleanup);

describe('question text', () => {
  it('shows an inline command as a separate copyable box', () => {
    render(<MarkdownView content={q.text} bare commands />);
    expect(screen.getByTestId('step-code').textContent).toContain('bash .reviews/x.sh <profile>');
    expect(screen.getByTestId('step-code-copy')).toBeTruthy();
  });

  it('shows a separate command in a box', () => {
    render(<CommandBox command='git status' />);
    expect(screen.getByTestId('step-command').textContent).toBe('git status');
  });
});

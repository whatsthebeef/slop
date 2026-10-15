// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_TONES, Block, blockActor } from '../src/components/glob-view/block';
import type { BlockTone } from '../src/components/glob-view/block';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the shared block', () => {
  it('renders the head line with the actor icon, the why line, the body, the fix line and the actions', () => {
    render(
      <Block
        tone="problem"
        actor="machine"
        title="Conflicts with develop"
        why="Since s1t9 merged, both sides changed 2 files."
        fix={{ text: 'Let your Claude session merge develop.', command: 'sstor --glob s1t1' }}
        actions={<button type="button">Got it</button>}
      >
        <span>apps/web/src/a.ts</span>
      </Block>,
    );
    const block = screen.getByTestId('block');
    expect(block.getAttribute('data-block')).toBe('problem');
    expect(within(block).getByTestId('block-head').textContent).toBe('Conflicts with develop');
    expect(within(block).getByTestId('block-why').textContent).toBe(
      'Since s1t9 merged, both sides changed 2 files.',
    );
    expect(within(block).getByTestId('block-body').textContent).toBe('apps/web/src/a.ts');
    expect(within(block).getByTestId('block-fix').textContent).toContain(
      'Let your Claude session merge develop.',
    );
    expect(within(block).getByTestId('block-fix-command').textContent).toBe('sstor --glob s1t1');
    expect(within(block).getByTestId('block-actions').textContent).toBe('Got it');
  });

  it('is labelled by its head line and shows the head, why, body, fix, more and actions in that order', () => {
    render(
      <Block
        tone="person"
        actor="human"
        title="Sign-off"
        why="Why"
        fix={{ text: 'Fix' }}
        more="More"
        actions={<span>Act</span>}
      >
        Body
      </Block>,
    );
    const block = screen.getByRole('region', { name: 'Sign-off' });
    const order = [
      'block-head',
      'block-why',
      'block-body',
      'block-fix',
      'block-more',
      'block-actions',
    ].map((id) => within(block).getByTestId(id));
    order.slice(1).forEach((node, i) => {
      const before = order[i];
      expect(
        before === undefined
          ? 0
          : before.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  it('draws the actor with the shared icons: the machine for a machine, a person for a person', () => {
    const { rerender } = render(<Block tone="info" actor="machine" title="T" />);
    expect(screen.getByTestId('block-head').querySelector('svg.lucide-bot')).not.toBeNull();
    rerender(<Block tone="info" actor="human" title="T" />);
    expect(screen.getByTestId('block-head').querySelector('svg.lucide-user-round')).not.toBeNull();
    expect(screen.getByTestId('block-head').querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('takes its look from one token set, a different one per tone', () => {
    const tones: BlockTone[] = ['problem', 'person', 'info'];
    expect(new Set(tones.map((t) => BLOCK_TONES[t])).size).toBe(3);
    for (const tone of tones) {
      const { unmount } = render(<Block tone={tone} actor="human" title="T" />);
      const classes = screen.getByTestId('block').className;
      expect(classes).toContain('rounded');
      expect(classes).toContain('p-3');
      for (const token of BLOCK_TONES[tone].split(' ')) expect(classes).toContain(token);
      unmount();
    }
  });

  it('leaves out the parts it has no content for: no why, body, fix or actions', () => {
    render(<Block tone="info" actor="human" title="Only a title" />);
    for (const id of ['block-why', 'block-body', 'block-fix', 'block-actions'])
      expect(screen.queryByTestId(id)).toBeNull();
  });

  it('folds a long body under its label, open only when asked', () => {
    const { rerender } = render(
      <Block tone="info" actor="human" title="T" fold={{ label: 'Details' }}>
        evidence
      </Block>,
    );
    const body = () => screen.getByTestId('block-body');
    expect(body().tagName).toBe('DETAILS');
    expect(body().hasAttribute('open')).toBe(false);
    expect(within(body()).getByText('Details').tagName).toBe('SUMMARY');
    rerender(
      <Block tone="info" actor="human" title="T" fold={{ label: 'Details', open: true }}>
        evidence
      </Block>,
    );
    expect(body().hasAttribute('open')).toBe(true);
  });

  it('copies the fix command and says so; a fix without a command has no button', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(
      <Block
        tone="problem"
        actor="human"
        title="T"
        fix={{ text: 'Run it', command: 'sstor --glob s1t1' }}
      />,
    );
    await userEvent.click(screen.getByTestId('block-fix-copy'));
    expect(writeText).toHaveBeenCalledWith('sstor --glob s1t1');
    expect(screen.getByTestId('block-fix-copy').textContent).toBe('Copied');
    cleanup();
    render(<Block tone="problem" actor="human" title="T" fix={{ text: 'Run it' }} />);
    expect(screen.queryByTestId('block-fix-copy')).toBeNull();
  });

  it('shows text as plain text: no Markdown is rendered', () => {
    render(
      <Block
        tone="info"
        actor="human"
        title="**Bold** title"
        why="Some `code` and _emphasis_"
        fold={{ label: 'More', open: true }}
      >
        # Heading and [a link](https://example.com)
      </Block>,
    );
    const block = screen.getByTestId('block');
    expect(block.querySelector('strong, em, a, code, h1, h2')).toBeNull();
    expect(block.textContent).toContain('**Bold** title');
    expect(block.textContent).toContain('Some `code` and _emphasis_');
    expect(block.textContent).toContain('# Heading and [a link](https://example.com)');
  });

  it('picks the machine for a glob a run is working on or the machine holds, else a person', () => {
    expect(blockActor({ currentRun: null })).toBe('human');
    expect(
      blockActor({ currentRun: null, move: { holder: 'machine', reason: 'x', since: null } }),
    ).toBe('machine');
    expect(
      blockActor({ currentRun: null, move: { holder: 'you', reason: 'x', since: null } }),
    ).toBe('human');
  });
});

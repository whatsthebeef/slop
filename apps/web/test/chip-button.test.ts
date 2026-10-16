import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ArmSystemLabel, ChipButton, KIND_ICON, KindMarker } from '../src/components/glob-card';
import { Tip } from '../src/components/ui/tip';

/** The id of the Tip's hidden description and the `aria-describedby` on the chip it wraps. */
const link = (html: string) => {
  const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  const descriptionId = /<span id="([^"]+)" class="sr-only">/.exec(html)?.[1];
  return { describedBy, descriptionId };
};

const render = (onOpen?: () => void) =>
  renderToStaticMarkup(
    createElement(Tip, {
      text: 'Opens the deploys',
      children: createElement(ChipButton, {
        onOpen,
        className: 'x',
        testId: 'deploy-chip',
        children: 'deployed',
      }),
    }),
  );

describe('ChipButton inside a Tip', () => {
  it('links the tooltip text as the button description when it opens the glob', () => {
    const html = render(() => undefined);
    expect(html).toContain('<button');
    const { describedBy, descriptionId } = link(html);
    expect(descriptionId).toBeDefined();
    expect(describedBy).toBe(descriptionId);
  });

  it('links the tooltip text as the description of the plain chip', () => {
    const html = render();
    expect(html).not.toContain('<button');
    const { describedBy, descriptionId } = link(html);
    expect(descriptionId).toBeDefined();
    expect(describedBy).toBe(descriptionId);
  });
});

describe('ArmSystemLabel inside a Tip', () => {
  const armed = (props: { onFilter?: () => void; to?: string }) =>
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ArmSystemLabel, { label: { text: 'Arm system', tip: 'Run the migration' }, ...props })));

  it.each([
    ['a filter button', { onFilter: () => undefined }],
    ['plain text', {}],
    ['a link in the glob view', { to: '/boards/1?arm=1' }],
  ])('links the tooltip text as the description of %s', (_name, props) => {
    const html = armed(props);
    expect(html).toContain('Run the migration');
    const { describedBy, descriptionId } = link(html);
    expect(descriptionId).toBeDefined();
    expect(describedBy).toBe(descriptionId);
  });
});

describe('KindMarker', () => {
  it('links the tooltip to the action icon and labels it action, not human', () => {
    const html = renderToStaticMarkup(createElement(KindMarker, { glob: { category: 'action', type: null } }));
    const { describedBy, descriptionId } = link(html);
    expect(describedBy).toBeDefined();
    expect(describedBy).toBe(descriptionId);
    expect(html).toContain('aria-label="action"');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('human');
  });

  it('shows the bug for a fix, named in its tooltip', () => {
    const marker = (glob: Parameters<typeof KindMarker>[0]['glob']) => renderToStaticMarkup(createElement(KindMarker, { glob }));
    expect(marker({ category: 'task', type: 'same', fix: true })).toContain('aria-label="bug"');
    expect(marker({ category: 'bug', type: 'sub' })).toContain('aria-label="bug"');
    expect(marker({ category: 'bug', type: 'sub' })).toContain('lucide-bug');
  });

  it.each([
    ['task', { category: 'task', type: 'same', workKind: 'maintenance' }],
    ['a bug with the fix flag off', { category: 'bug', type: 'sub', fix: false }],
  ] as const)('shows the task icon for %s, not nothing', (_name, glob) => {
    const html = renderToStaticMarkup(createElement(KindMarker, { glob }));
    expect(html).toContain('aria-label="task"');
    expect(html).toContain('lucide-list-checks');
    expect(html).toContain('text-muted-foreground');
  });

  it('shows the feature icon for a task counted as R&D, and the bug for a fix even then', () => {
    const marker = (glob: Parameters<typeof KindMarker>[0]['glob']) => renderToStaticMarkup(createElement(KindMarker, { glob }));
    const rnd = marker({ category: 'task', type: 'same', workKind: 'rnd' });
    expect(rnd).toContain('aria-label="feature"');
    expect(rnd).toContain('lucide-sparkles');
    expect(marker({ category: 'feature', type: 'same' })).toContain('lucide-sparkles');
    expect(marker({ category: 'task', type: 'same', fix: true, workKind: 'rnd' })).toContain('lucide-bug');
  });

  it('shows the scale for a decision and the running person, not the person icon, for an action', () => {
    const decision = renderToStaticMarkup(createElement(KindMarker, { glob: { category: 'decision', type: null } }));
    expect(decision).toContain('lucide-scale');
    expect(decision).toContain('aria-label="decision"');
    const action = renderToStaticMarkup(createElement(KindMarker, { glob: { category: 'action', type: null } }));
    expect(action).toContain('data-icon="person-running"');
    expect(action).not.toContain('lucide-user-round');
  });

  it('names each kind in its tooltip', () => {
    expect(Object.entries(KIND_ICON).map(([k, v]) => [k, v.label])).toEqual([
      ['task', 'Task'],
      ['bug', 'Bug'],
      ['action', 'Action'],
      ['decision', 'Decision'],
    ]);
  });
});

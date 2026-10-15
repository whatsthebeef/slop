import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ArmSystemLabel, ChipButton } from '../src/components/glob-card';
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
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ArmSystemLabel, { step: { title: 'Run the migration' }, ...props })));

  it.each([
    ['a filter button', { onFilter: () => undefined }],
    ['plain text', {}],
    ['a link in the glob view', { to: '/boards/1?arm=1' }],
  ])('links the tooltip text as the description of %s', (_name, props) => {
    const html = armed(props);
    expect(html).toContain('A person has a step at release: Run the migration');
    const { describedBy, descriptionId } = link(html);
    expect(descriptionId).toBeDefined();
    expect(describedBy).toBe(descriptionId);
  });
});

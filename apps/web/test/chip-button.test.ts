import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChipButton } from '../src/components/glob-card';
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

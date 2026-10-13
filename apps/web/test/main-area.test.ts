import { describe, expect, it } from 'vitest';
import { MAIN_AREA_CLASS } from '../src/lib/main-area';

describe('main-area scroll container', () => {
  const classes = MAIN_AREA_CLASS.split(' ');

  it('scrolls the page itself', () => {
    expect(classes).toContain('overflow-auto');
    expect(classes).toContain('min-h-0');
  });

  // Absolutely positioned descendants (a Tip's sr-only text) otherwise resolve against <body> and make the window scroll too.
  it('is the containing block of absolutely positioned descendants', () => {
    expect(classes).toContain('relative');
  });

  it('is not sized to the viewport or the board', () => {
    expect(classes.filter((c) => /^(min-)?h-(full|screen|dvh)$/.test(c))).toEqual([]);
  });
});

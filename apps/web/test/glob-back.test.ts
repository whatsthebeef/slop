import { describe, expect, it } from 'vitest';
import { escapeGoesBack } from '../src/lib/glob-back';

const body = { tag: 'BODY', editable: false };

describe('escapeGoesBack', () => {
  it('goes back on Esc from the page', () => {
    expect(escapeGoesBack('Escape', false, body, false, false)).toBe(true);
  });
  it('ignores other keys', () => {
    expect(escapeGoesBack('Enter', false, body, false, false)).toBe(false);
  });
  it('does not go back while typing in an input, textarea, select or editable element', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(escapeGoesBack('Escape', false, { tag, editable: false }, false, false)).toBe(false);
    expect(escapeGoesBack('Escape', false, { tag: 'DIV', editable: true }, false, false)).toBe(false);
  });
  it('lets an open popover close first', () => {
    expect(escapeGoesBack('Escape', false, body, true, false)).toBe(false);
  });
  it('lets an open confirmation close first', () => {
    expect(escapeGoesBack('Escape', false, body, false, true)).toBe(false);
  });
  it('does not go back when another handler took the key', () => {
    expect(escapeGoesBack('Escape', true, body, false, false)).toBe(false);
  });
});

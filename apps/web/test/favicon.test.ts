import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../index.html');
const svg = read('../public/favicon.svg');

describe('favicon', () => {
  it('links the SVG icon, then the PNG fallbacks', () => {
    const svgAt = html.indexOf('href="/favicon.svg"');
    const pngAt = html.indexOf('href="/favicon-32.png"');
    expect(svgAt).toBeGreaterThan(-1);
    expect(pngAt).toBeGreaterThan(svgAt);
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
  });
  it('has a square viewBox', () => {
    const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '';
    const [, , w, h] = viewBox.split(/\s+/).map(Number);
    expect(viewBox).not.toBe('');
    expect(w).toBe(h);
  });
  it('switches to a light fill on dark tab bars', () => {
    expect(svg).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });
});

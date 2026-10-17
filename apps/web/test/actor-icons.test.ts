import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HumanIcon, MachineIcon, PersonRunning } from '../src/components/actor-icons';

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

describe('actor icons', () => {
  it('renders HumanIcon as lucide UserRound, labelled human', () => {
    const html = renderToStaticMarkup(createElement(HumanIcon, { className: 'h-3 w-3' }));
    expect(html).toContain('lucide-user-round');
    expect(html).toContain('aria-label="human"');
  });
  it('renders PersonRunning as a stroked 24px svg that is not the human person icon', () => {
    const html = renderToStaticMarkup(createElement(PersonRunning, { className: 'h-3.5 w-3.5', 'aria-label': 'action', role: 'img' }));
    expect(html).toContain('data-icon="person-running"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('fill="none"');
    expect(html).toContain('class="h-3.5 w-3.5"');
    expect(html).toContain('aria-label="action"');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('lucide-user-round');
  });
  it('renders PersonRunning hidden from assistive tech when asked', () => {
    expect(renderToStaticMarkup(createElement(PersonRunning, { 'aria-hidden': true }))).toContain('aria-hidden="true"');
  });
  it('renders MachineIcon as lucide Bot, labelled machine', () => {
    const html = renderToStaticMarkup(createElement(MachineIcon));
    expect(html).toContain('lucide-bot');
    expect(html).toContain('aria-label="machine"');
  });
  it('turns the robot head only while working, and not for reduced motion', () => {
    const still = renderToStaticMarkup(createElement(MachineIcon));
    const turning = renderToStaticMarkup(createElement(MachineIcon, { working: true }));
    expect(still).not.toContain('animate-spin');
    expect(turning).toContain('animate-spin');
    expect(turning).toContain('motion-reduce:animate-none');
  });
  it('turns the person only while working, and not for reduced motion', () => {
    const still = renderToStaticMarkup(createElement(HumanIcon));
    const turning = renderToStaticMarkup(createElement(HumanIcon, { working: true }));
    expect(still).not.toContain('animate-spin');
    expect(turning).toContain('lucide-user-round');
    expect(turning).toContain('animate-spin');
    expect(turning).toContain('motion-reduce:animate-none');
    expect(renderToStaticMarkup(createElement(HumanIcon, { working: true }))).toContain('aria-label="human"');
  });
  it('hides a decorative icon from screen readers', () => {
    const html = renderToStaticMarkup(createElement(HumanIcon, { decorative: true }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('aria-label');
  });
  it('never imports Brain from lucide-react anywhere in apps/web/src', () => {
    const offenders = sourceFiles(new URL('../src', import.meta.url).pathname).filter((f) =>
      /import\s*\{[^}]*\bBrain\b[^}]*\}\s*from\s*'lucide-react'/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

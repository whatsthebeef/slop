import { describe, expect, it, vi } from 'vitest';
import {
  conflictByHand,
  conflictCommand,
  copySstorCommand,
  sstorCommand,
} from '../src/lib/sstor-command';

describe('sstorCommand', () => {
  it('is the plain command for Pick up', () => {
    expect(sstorCommand('pick_up', 's15t72')).toBe('sstor --glob s15t72');
  });

  it('is the same plain command for Take over (the click already picked the glob up)', () => {
    expect(sstorCommand('take_over', 's15t72')).toBe('sstor --glob s15t72');
  });

  it('is null for any other action', () => {
    expect(sstorCommand('start', 's15t72')).toBeNull();
    expect(sstorCommand('mark_ready', 's15t72')).toBeNull();
  });
});

describe('copySstorCommand', () => {
  it('writes to the clipboard synchronously, before the request could resolve', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const result = copySstorCommand('pick_up', 's1t1', { writeText });
    expect(writeText).toHaveBeenCalledWith('sstor --glob s1t1');
    await expect(result).resolves.toEqual({ command: 'sstor --glob s1t1', copied: true });
  });

  it('reports not copied when the clipboard refuses', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    await expect(copySstorCommand('take_over', 's1t1', { writeText })).resolves.toEqual({
      command: 'sstor --glob s1t1',
      copied: false,
    });
  });

  it('reports not copied when there is no clipboard', async () => {
    await expect(copySstorCommand('pick_up', 's1t1', undefined)).resolves.toMatchObject({
      copied: false,
    });
  });

  it('does nothing for an action without a command', () => {
    const writeText = vi.fn(() => Promise.resolve());
    expect(copySstorCommand('start', 's1t1', { writeText })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('Pick up on a super', () => {
  it('copies the plain session command on the click, before the request resolves', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const result = copySstorCommand('pick_up', 's15t219', { writeText });
    expect(writeText).toHaveBeenCalledWith('sstor --glob s15t219');
    await expect(result).resolves.toEqual({ command: 'sstor --glob s15t219', copied: true });
  });
});

describe('conflict advice', () => {
  it('shows the plain command for a viewer who can take over, the same one Take over copies', () => {
    expect(conflictCommand('s1t1', true)).toBe('sstor --glob s1t1');
    expect(conflictCommand('s1t1', true)).toBe(sstorCommand('take_over', 's1t1'));
  });

  it('shows the plain session command for the implementer', () => {
    expect(conflictCommand('s1t1', false)).toBe('sstor --glob s1t1');
  });

  it('never offers --resolve as the main command', () => {
    expect(conflictCommand('s1t1', true)).not.toContain('--resolve');
    expect(conflictCommand('s1t1', false)).not.toContain('--resolve');
  });

  it('keeps --resolve in the by-hand section, marked mergetool only', () => {
    const text = conflictByHand('s1t1', 's1t1', 'main');
    expect(text).toContain('git merge origin/main');
    expect(text).toMatch(/mergetool only, no Claude:\nsstor --glob s1t1 --resolve/);
  });
});

describe('--resolve advice', () => {
  it('appears in web and core sources only as the by-hand (advanced) option', async () => {
    const { execFileSync } = await import('node:child_process');
    const found = execFileSync(
      'grep',
      [
        '-rl',
        '--include=*.ts',
        '--include=*.tsx',
        '-e',
        '--resolve',
        '../../apps/web/src',
        '../../packages/core/src',
      ],
      {
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter(Boolean);
    expect(found).toEqual(['../../apps/web/src/lib/sstor-command.ts']);
  });
});

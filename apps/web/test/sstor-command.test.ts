import { describe, expect, it, vi } from 'vitest';
import { copySstorCommand, sstorCommand } from '../src/lib/sstor-command';

describe('sstorCommand', () => {
  it('is the plain command for Pick up', () => {
    expect(sstorCommand('pick_up', 's15t72')).toBe('sstor --glob s15t72');
  });

  it('adds --take-over for Take over', () => {
    expect(sstorCommand('take_over', 's15t72')).toBe('sstor --glob s15t72 --take-over');
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
      command: 'sstor --glob s1t1 --take-over',
      copied: false,
    });
  });

  it('reports not copied when there is no clipboard', async () => {
    await expect(copySstorCommand('pick_up', 's1t1', undefined)).resolves.toMatchObject({ copied: false });
  });

  it('does nothing for an action without a command', () => {
    const writeText = vi.fn(() => Promise.resolve());
    expect(copySstorCommand('start', 's1t1', { writeText })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });
});

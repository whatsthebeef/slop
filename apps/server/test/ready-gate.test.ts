import type { Board, Glob } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { readyGate } from '../src/ready-gate.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const glob = { id: 's1t1', boardId: 1, status: 'implementing', pr: { number: 7 } } as unknown as Glob;
const board = { id: 1, repo: 'acme/app', baseBranch: 'main' } as unknown as Board;

class Host extends FakeCodeHost {
  override configured = true;
  states: ('clean' | 'conflict' | 'unknown')[] = ['clean'];
  asked = 0;
  override conflictState = () => Promise.resolve(this.states[Math.min(this.asked++, this.states.length - 1)] ?? 'unknown');
}

const gateFor = (host: Host, member = true) =>
  readyGate(
    host,
    { peek: () => Promise.resolve(glob) },
    {
      get: () =>
        Promise.resolve(member ? { ok: true, value: { board, role: 'dev' } } : { ok: false, error: { code: 'forbidden', message: 'no' } }),
    } as never,
    () => Promise.resolve(),
  );

describe('the check before mark_ready', () => {
  it('refuses a conflicting branch, naming the files and what to do', async () => {
    const host = new Host();
    host.states = ['conflict'];
    host.conflictFiles = () => Promise.resolve(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    const result = await gateFor(host)('acme', 's1t1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('conflicts with main in a.ts, b.ts, c.ts and 2 more files');
    expect(result.error.message).toContain('Merge origin/main, resolve, run the checks, push, then call mark_ready again');
  });

  it('allows a clean branch with no warning', async () => {
    const result = await gateFor(new Host())('dev', 's1t1');
    expect(result).toEqual({ ok: true, value: {} });
  });

  it('allows a branch behind its base but clean, with a warning', async () => {
    const host = new Host();
    host.behindBase = () => Promise.resolve({ behindBy: 2, files: [] });
    const result = await gateFor(host)('dev', 's1t1');
    expect(result.ok && result.value.warning).toContain('2 commits behind main');
  });

  it('retries an unknown state, then allows the call', async () => {
    const host = new Host();
    host.states = ['unknown', 'conflict'];
    expect((await gateFor(host)('dev', 's1t1')).ok).toBe(false);
    const stuck = new Host();
    stuck.states = ['unknown'];
    expect(await gateFor(stuck)('dev', 's1t1')).toEqual({ ok: true, value: {} });
    expect(stuck.asked).toBe(3);
  });

  it('allows the call when the host fails, and refuses a non-member', async () => {
    const host = new Host();
    host.conflictState = () => Promise.reject(new Error('down'));
    expect(await gateFor(host)('dev', 's1t1')).toEqual({ ok: true, value: {} });
    expect((await gateFor(new Host(), false)('x', 's1t1')).ok).toBe(false);
  });
});

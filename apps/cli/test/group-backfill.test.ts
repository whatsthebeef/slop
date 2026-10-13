import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors.js';
import { groupBackfillCommand } from '../src/group-backfill.js';

const answer = (applied: boolean) => ({ applied, items: [{ id: 's1f1', title: 'Big 1/2: a', group: 'big', why: 'split', ...(applied ? { result: 'applied' } : {}) }] });

function setup(response: unknown, board: string | null = '15') {
  const calls: string[] = [];
  const out: string[] = [];
  const deps = {
    client: {
      rest: (method: string, path: string, body?: unknown) => {
        calls.push(`${method} ${path} ${JSON.stringify(body)}`);
        return Promise.resolve(response);
      },
    },
    stdout: (t: string) => out.push(t),
    defaultBoard: board ?? undefined,
  };
  return { calls, out, deps };
}

describe('slop group-backfill', () => {
  it('is a dry run by default and says how to apply', async () => {
    const { calls, out, deps } = setup(answer(false));
    await groupBackfillCommand([], deps);
    expect(calls).toEqual(['POST /api/boards/15/groups/backfill {"apply":false}']);
    expect(out.join('')).toBe('s1f1\tbig\tsplit\tBig 1/2: a\n1 proposed; run again with --apply to write them.\n');
  });

  it('--apply sends apply and prints each result; --board wins over SLOP_BOARD', async () => {
    const { calls, out, deps } = setup(answer(true));
    await groupBackfillCommand(['--board', '3', '--apply'], deps);
    expect(calls).toEqual(['POST /api/boards/3/groups/backfill {"apply":true}']);
    expect(out.join('')).toBe('s1f1\tbig\tsplit\tBig 1/2: a\t[applied]\n');
  });

  it('says so when nothing needs a group, and needs a board and known options', async () => {
    const empty = setup({ applied: false, items: [] });
    await groupBackfillCommand([], empty.deps);
    expect(empty.out.join('')).toBe('No open globs need a group.\n');
    await expect(groupBackfillCommand([], setup(answer(false), null).deps)).rejects.toThrow(UsageError);
    await expect(groupBackfillCommand(['--nope'], empty.deps)).rejects.toThrow(/unknown option/);
  });
});

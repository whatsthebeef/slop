import { FakeObjectStore, deleteObjectEffect } from '@slop/core';
import type { BoardService } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import type { CodeHost } from '../src/codehost.js';
import type { RoutineSource } from '../src/routines.js';

const executors = (objects: FakeObjectStore | null) =>
  codeHostExecutors({} as CodeHost, () => Promise.resolve(null), {} as RoutineSource, {} as Pick<BoardService, 'recordBaseChecks' | 'recordBaseBranch'>, undefined, null, null, undefined, undefined, objects);

describe('delete_object executor', () => {
  it('deletes the key, and does it again without harm', async () => {
    const objects = new FakeObjectStore();
    objects.put('boards/1/globs/s1t1/u1', { size: 1, contentType: 'image/png' });
    const run = executors(objects).delete_object;
    const effect = deleteObjectEffect('s1t1', 'boards/1/globs/s1t1/u1');
    expect(await run?.(effect, null, {} as never)).toBe('done');
    expect(await run?.(effect, null, {} as never)).toBe('done');
    expect(objects.deleted).toEqual(['boards/1/globs/s1t1/u1', 'boards/1/globs/s1t1/u1']);
    expect(objects.objects.size).toBe(0);
  });

  it('drops the job when no bucket is configured', async () => {
    expect(await executors(null).delete_object?.(deleteObjectEffect('s1t1', 'k'), null, {} as never)).toBe('dropped');
  });
});

describe('fire_routine executor and pending files', () => {
  const glob = { id: 's1t1', boardId: 1, provisioning: 'ok', runs: [{ id: 'r1', state: 'queued' }] } as never;
  const effect = { kind: 'fire_routine', globId: 's1t1', generation: 1, runId: 'r1', routineOwner: 'dev@example.com' } as const;
  const withFiles = (wait: (id: string) => Promise<number>, secretFor: () => Promise<null>) =>
    codeHostExecutors(
      {} as CodeHost,
      () => Promise.resolve(null),
      { secretFor } as unknown as RoutineSource,
      {} as Pick<BoardService, 'recordBaseChecks' | 'recordBaseBranch'>,
      undefined,
      null,
      null,
      undefined,
      undefined,
      null,
      wait,
    ).fire_routine;

  it('waits for pending files without spending an attempt, then goes on once none is pending', async () => {
    let wait = 10 * 60_000;
    let reached = 0;
    const run = withFiles(
      () => Promise.resolve(wait),
      () => {
        reached++;
        return Promise.resolve(null);
      },
    );
    const held = await run?.(effect, glob, {} as never);
    expect(held).toMatchObject({ state: 'pending', retryAfterMs: 15_000 });
    expect(reached).toBe(0);
    wait = 5_000;
    expect(await run?.(effect, glob, {} as never)).toMatchObject({ state: 'pending', retryAfterMs: 5_000 });
    wait = 0;
    // With nothing pending the run goes on to its normal steps (here: no routine set up, so it fails the run through globs).
    await run?.(effect, glob, { globs: { applyEvent: () => Promise.resolve() } } as never);
    expect(reached).toBe(1);
  });
});

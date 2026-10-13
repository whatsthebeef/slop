import { FakeObjectStore, deleteObjectEffect } from '@slop/core';
import type { BoardService } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import type { CodeHost } from '../src/codehost.js';
import type { RoutineSource } from '../src/routines.js';

const executors = (objects: FakeObjectStore | null) =>
  codeHostExecutors({} as CodeHost, () => Promise.resolve(null), {} as RoutineSource, {} as Pick<BoardService, 'recordBaseChecks'>, undefined, null, null, undefined, undefined, objects);

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

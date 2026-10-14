import { readFile } from 'node:fs/promises';
import type { Glob } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const glob = (id: string, boardId: number, patch: Partial<Glob>): Glob => ({
  id,
  boardId,
  title: id,
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  status: 'planning',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: null,
  labels: {},
  checklists: {},
  pr: null,
  prs: [],
  mergeMode: null,
  headChecks: null,
  updatedAt: '2026-10-13T14:00:00.000Z',
  signedOffAt: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  doingSince: null,
  runs: [],
  failure: null,
  provisioning: 'none',
  ...patch,
});

describe('0068 backfill of listSince', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let run: () => Promise<void>;
  let boardId: number;

  beforeAll(async () => {
    const test = await createTestDatabase('backfill_list_since');
    drop = test.drop;
    store = new PgStore(test.database.db);
    const migration = await readFile(
      new URL('../drizzle/0068_glob_list_since.sql', import.meta.url),
      'utf8',
    );
    run = async () => {
      await test.database.db.execute(sql.raw(migration));
    };
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'sandbox',
        repo: 'acme/sandbox',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
  });

  afterAll(async () => {
    await drop();
  });

  const listSince = async (id: string) =>
    (await store.transaction((tx) => tx.getGlob(id)))?.listSince;
  const moved = (globId: string, from: string, to: string, at: string) => ({
    globId,
    type: 'StatusChanged' as const,
    actor: DEV,
    at,
    data: { from, to },
  });

  it('gives each glob the time it entered its current list, else its doingSince, signedOffAt or createdAt', async () => {
    await store.transaction(async (tx) => {
      await tx.insertGlob(glob('s1t1', boardId, { status: 'planning' }), null);
      await tx.insertGlob(
        glob('s1t2', boardId, { status: 'pr_open', doingSince: '2026-10-11T09:00:00.000Z' }),
        null,
      );
      await tx.insertGlob(
        glob('s1t3', boardId, { status: 'in_progress', doingSince: '2026-10-12T09:00:00.000Z' }),
        null,
      );
      await tx.insertGlob(
        glob('s1t4', boardId, { status: 'signed_off', signedOffAt: '2026-10-13T10:00:00.000Z' }),
        null,
      );
      await tx.insertGlob(
        glob('s1t5', boardId, { status: 'planning', listSince: '2026-10-09T00:00:00.000Z' }),
        null,
      );
      // s1t3 entered Doing at 10:00, then moved inside Doing at 12:00 (not a list change): 10:00 counts.
      await tx.appendEvents([
        moved('s1t3', 'planning', 'implementing', '2026-10-12T10:00:00.000Z'),
        moved('s1t3', 'implementing', 'in_progress', '2026-10-12T12:00:00.000Z'),
      ]);
    });
    await run();
    expect(await listSince('s1t1')).toBe('2026-10-10T08:00:00.000Z');
    expect(await listSince('s1t2')).toBe('2026-10-11T09:00:00.000Z');
    expect(await listSince('s1t3')).toBe('2026-10-12T10:00:00.000Z');
    expect(await listSince('s1t4')).toBe('2026-10-13T10:00:00.000Z');
    expect(await listSince('s1t5')).toBe('2026-10-09T00:00:00.000Z');
    await run();
    expect(await listSince('s1t3')).toBe('2026-10-12T10:00:00.000Z');
  });
});

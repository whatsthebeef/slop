import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardService, GlobService, machine } from '@slop/core';
import type { Board, Effect, Result } from '@slop/core';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { GitHub } from '../src/github/client.js';
import { AppCredentialsStore } from '../src/github/credentials.js';
import { IntegrationRegistry } from '../src/integration-health.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('routine health reporting', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let dir = '';
  let registry: IntegrationRegistry;
  let executor: NonNullable<ReturnType<typeof codeHostExecutors>['fire_routine']>;

  const boardOf = (boardId: number): Promise<Board | null> =>
    store.transaction((tx) => tx.getBoard(boardId));
  // The routine executor never touches the code host.
  const host = new GitHub(new AppCredentialsStore('/nonexistent/app.json'));

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('routinehealth'));
    store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: DEV,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    dir = await mkdtemp(join(tmpdir(), 'slop-routine-health-'));
    const file = join(dir, 'routines.json');
    await writeFile(
      file,
      JSON.stringify({ [DEV]: { url: 'https://example.com/fire', token: 't' } }),
    );
    registry = new IntegrationRegistry();
    const executors = codeHostExecutors(
      host,
      boardOf,
      new FileRoutines(file),
      new BoardService({ store, notifier }),
      undefined,
      registry,
    );
    const fire = executors.fire_routine;
    if (fire === undefined) throw new Error('No fire_routine executor');
    executor = fire;
  });

  afterAll(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Fires the queued run of a fresh glob, with the routine endpoint answering `status`. */
  const fireWith = async (status: number) => {
    const created = unwrap(
      await globs.create(DEV, {
        boardId: 1,
        title: 't',
        summary: '',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: true,
        idempotencyKey: null,
      }),
    );
    await globs.applyEvent(created.id, (g, ctx) =>
      machine.provisioned(g, { branch: g.id, pr: { number: 7, headSha: 'h1' } }, ctx),
    );
    const rows = (
      await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, created.id))
    ).filter((row) => row.kind === 'fire_routine');
    const effect: Effect | undefined = rows[0]?.effect;
    if (effect === undefined) throw new Error('No fire_routine effect');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({}), { status })));
    return executor(effect, await globs.peek(created.id), { globs });
  };

  const state = () => registry.report().find((h) => h.id === 'routines');

  it('marks routines down when the credential is rejected', async () => {
    expect(await fireWith(401)).toBe('done');
    expect(state()).toMatchObject({ state: 'down' });
  });

  it('marks routines ok after a run fires', async () => {
    expect(await fireWith(200)).toBe('done');
    expect(state()).toMatchObject({ state: 'ok' });
  });

  it('does not mark routines down for a bad request', async () => {
    expect(await fireWith(400)).toBe('done');
    expect(state()).toMatchObject({ state: 'ok' });
  });
});

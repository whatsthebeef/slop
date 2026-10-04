import type { Board, Glob, GlobFilter, Member, Store, Tx, User } from '@slop/core';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase, PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
type DbTx = PgTransaction<PostgresJsQueryResultHKT, typeof schema>;
type Executor = Db | DbTx;

export interface Database {
  readonly db: Db;
  close(): Promise<void>;
}

export const connect = (url: string): Database => {
  const client = postgres(url, { max: 10, onnotice: () => undefined });
  return { db: drizzle(client, { schema }), close: () => client.end() };
};

export const runMigrations = async (url: string, folder: string): Promise<void> => {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
};

const toBoard = (row: typeof schema.boards.$inferSelect): Board => ({
  id: row.id,
  name: row.name,
  repo: row.repo,
  baseBranch: row.baseBranch,
  timeZone: row.timeZone,
  defaultRoutineOwner: row.defaultRoutineOwner,
  environments: row.environments,
  sensitivePaths: row.sensitivePaths,
  version: row.version,
});

const globColumns = (glob: Glob) => ({
  boardId: glob.boardId,
  version: glob.version,
  status: glob.status,
  type: glob.type,
  groupName: glob.group,
  planner: glob.planner,
  implementer: glob.implementer,
  data: glob,
  updatedAt: new Date(glob.updatedAt),
});

/** Postgres implementation of the core Store port. */
export class PgStore implements Store {
  constructor(private readonly db: Db) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction((t) => work(this.tx(t)));
  }

  private tx(t: Executor): Tx {
    return {
      getGlob: async (id) => {
        const [row] = await t.select({ data: schema.globs.data }).from(schema.globs).where(eq(schema.globs.id, id));
        return row?.data ?? null;
      },
      insertGlob: async (glob, creationKey) => {
        const rows = await t
          .insert(schema.globs)
          .values({ id: glob.id, creationKey, ...globColumns(glob) })
          .onConflictDoNothing()
          .returning({ id: schema.globs.id });
        return rows.length === 1;
      },
      updateGlob: async (glob, expectedVersion) => {
        const rows = await t
          .update(schema.globs)
          .set(globColumns(glob))
          .where(and(eq(schema.globs.id, glob.id), eq(schema.globs.version, expectedVersion)))
          .returning({ id: schema.globs.id });
        return rows.length === 1;
      },
      deleteGlob: async (id) => {
        await t.delete(schema.globs).where(eq(schema.globs.id, id));
      },
      findGlobByCreationKey: async (boardId, key) => {
        const [row] = await t
          .select({ data: schema.globs.data })
          .from(schema.globs)
          .where(and(eq(schema.globs.boardId, boardId), eq(schema.globs.creationKey, key)));
        return row?.data ?? null;
      },
      listGlobs: async (boardId, filter: GlobFilter) => {
        const conditions = [eq(schema.globs.boardId, boardId)];
        if (filter.status !== undefined) conditions.push(inArray(schema.globs.status, [...filter.status]));
        if (filter.type !== undefined) conditions.push(eq(schema.globs.type, filter.type));
        if (filter.group !== undefined) conditions.push(eq(schema.globs.groupName, filter.group));
        if (filter.person !== undefined) {
          const person = or(eq(schema.globs.planner, filter.person), eq(schema.globs.implementer, filter.person));
          if (person !== undefined) conditions.push(person);
        }
        const rows = await t
          .select({ data: schema.globs.data })
          .from(schema.globs)
          .where(and(...conditions))
          .orderBy(schema.globs.updatedAt);
        return rows.map((r) => r.data);
      },
      nextNumber: async (boardId, letter) => {
        const [row] = await t
          .insert(schema.idCounters)
          .values({ boardId, letter, n: 1 })
          .onConflictDoUpdate({
            target: [schema.idCounters.boardId, schema.idCounters.letter],
            set: { n: sql`${schema.idCounters.n} + 1` },
          })
          .returning({ n: schema.idCounters.n });
        if (row === undefined) throw new Error('Counter update returned nothing');
        return row.n;
      },

      getBoard: async (id) => {
        const [row] = await t.select().from(schema.boards).where(eq(schema.boards.id, id));
        return row === undefined ? null : toBoard(row);
      },
      insertBoard: async (input) => {
        const [row] = await t
          .insert(schema.boards)
          .values({ ...input, environments: [...input.environments], sensitivePaths: [...input.sensitivePaths], version: 1 })
          .returning();
        if (row === undefined) throw new Error('Board insert returned nothing');
        return toBoard(row);
      },
      updateBoard: async (board, expectedVersion) => {
        const rows = await t
          .update(schema.boards)
          .set({
            name: board.name,
            repo: board.repo,
            baseBranch: board.baseBranch,
            timeZone: board.timeZone,
            defaultRoutineOwner: board.defaultRoutineOwner,
            environments: [...board.environments],
            sensitivePaths: [...board.sensitivePaths],
            version: board.version,
          })
          .where(and(eq(schema.boards.id, board.id), eq(schema.boards.version, expectedVersion)))
          .returning({ id: schema.boards.id });
        return rows.length === 1;
      },
      listBoards: async (email) => {
        const rows = await t
          .select({ board: schema.boards })
          .from(schema.boards)
          .innerJoin(schema.members, eq(schema.members.boardId, schema.boards.id))
          .where(eq(schema.members.email, email))
          .orderBy(schema.boards.id);
        return rows.map((r) => toBoard(r.board));
      },

      getMember: async (boardId, email) => {
        const [row] = await t
          .select()
          .from(schema.members)
          .where(and(eq(schema.members.boardId, boardId), eq(schema.members.email, email)));
        return row ?? null;
      },
      listMembers: async (boardId): Promise<Member[]> =>
        t.select().from(schema.members).where(eq(schema.members.boardId, boardId)).orderBy(schema.members.email),
      upsertMember: async (member) => {
        await t
          .insert(schema.members)
          .values(member)
          .onConflictDoUpdate({
            target: [schema.members.boardId, schema.members.email],
            set: { role: member.role },
          });
      },
      deleteMember: async (boardId, email) => {
        await t.delete(schema.members).where(and(eq(schema.members.boardId, boardId), eq(schema.members.email, email)));
      },

      getUser: async (email): Promise<User | null> => {
        const [row] = await t.select().from(schema.users).where(eq(schema.users.email, email));
        return row === undefined ? null : { email: row.email, name: row.name, active: row.active };
      },
      upsertUser: async (user) => {
        await t
          .insert(schema.users)
          .values(user)
          .onConflictDoUpdate({ target: schema.users.email, set: { name: user.name, active: user.active } });
      },

      appendEvents: async (events) => {
        if (events.length === 0) return;
        await t.insert(schema.events).values(
          events.map((e) => ({ globId: e.globId, type: e.type, actor: e.actor, at: new Date(e.at), data: e.data })),
        );
      },
      deleteEvents: async (globId) => {
        await t.delete(schema.events).where(eq(schema.events.globId, globId));
      },
      enqueueEffects: async (effects) => {
        if (effects.length === 0) return;
        await t.insert(schema.outbox).values(effects.map((effect) => ({ kind: effect.kind, globId: effect.globId, effect })));
        // Wake the job runner after commit.
        await t.execute(sql`select pg_notify('slop_outbox', '')`);
      },
    };
  }
}

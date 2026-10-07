import { ArtifactService, GlobService } from '@slop/core';
import type { Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface Body {
  plan: { content: string };
  implementationPlan: { content: string } | null;
  attachments: { label: string }[];
  available: { kind: string }[];
  content: string;
}

describe('MCP get_context include and get_artifact', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let client: Client;
  let globId: string;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('mcp_context'));
    const store = new PgStore(database.db);
    const deps = {
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
    };
    const globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const artifacts = new ArtifactService(deps);
    const boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
    globId = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Super',
        summary: 'Idea',
        type: 'super',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
    const put = (kind: 'postplan' | 'implementation_plan' | 'local_review', content: string) =>
      artifacts.putArtifact(DEV, globId, kind, content, {
        commitSha: 'abc123',
        runId: null,
        agentSetVersion: null,
      });
    unwrap(await put('postplan', '# Postplan\n\nWhat was built.'));
    unwrap(await put('implementation_plan', '# Decision log\n\n**Decision.** Why.'));
    unwrap(await put('local_review', '# Review\n\nAll fine.'));
    unwrap(
      await artifacts.attach(DEV, globId, { label: 'Clarifications', text: 'Use X.', link: null }),
    );
    unwrap(
      await artifacts.attach(DEV, globId, { label: 'Notes', text: 'Side notes.', link: null }),
    );

    const server = buildServer({ artifacts, globs } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { type: string; text: string }[];
    return {
      isError: result.isError === true,
      body: JSON.parse(first?.text ?? 'null') as Body,
    };
  };

  it('get_context sends the postplan and Clarifications in full and lists the rest with sizes', async () => {
    const { body } = await call('get_context', { id: globId });
    expect(body.plan.content).toBe('# Postplan\n\nWhat was built.');
    expect(body.attachments.map((a: { label: string }) => a.label)).toEqual(['Clarifications']);
    expect(body.implementationPlan).toBeNull();
    expect(body.available).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'implementation_plan',
          commitSha: 'abc123',
          size: '# Decision log\n\n**Decision.** Why.'.length,
          description: 'Decision log',
        }),
        expect.objectContaining({ kind: 'local_review', description: 'Review' }),
        expect.objectContaining({ kind: 'attachment', label: 'Notes' }),
      ]),
    );
    expect(body.available).toHaveLength(3);
  });

  it('get_context include returns the named artifacts in full', async () => {
    const { body } = await call('get_context', {
      id: globId,
      include: ['implementation_plan', 'attachment:Notes'],
    });
    expect(body.implementationPlan?.content).toContain('**Decision.**');
    expect(body.attachments.map((a: { label: string }) => a.label).sort()).toEqual([
      'Clarifications',
      'Notes',
    ]);
    expect(body.available.map((a: { kind: string }) => a.kind)).toEqual(['local_review']);
    expect((await call('get_context', { id: globId, include: ['all'] })).body.available).toEqual(
      [],
    );
  });

  it('get_artifact returns one artifact in full, or an error when there is none', async () => {
    expect(
      (await call('get_artifact', { id: globId, kind: 'implementation_plan' })).body.content,
    ).toContain('# Decision log');
    expect(
      (await call('get_artifact', { id: globId, kind: 'attachment', label: 'Notes' })).body.content,
    ).toBe('Side notes.');
    expect(
      (await call('get_artifact', { id: globId, kind: 'attachment', label: 'Nope' })).isError,
    ).toBe(true);
  });
});

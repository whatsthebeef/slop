import { beforeEach, describe, expect, it } from 'vitest';
import { InboxService } from '../src/app/inbox-service.js';
import { IntegrationTokenService } from '../src/app/integration-token-service.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const START = '2026-10-05T12:00:00.000Z';

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);

describe('integration tokens and delivery', () => {
  let store: MemoryStore;
  let tokens: IntegrationTokenService;
  let inbox: InboxService;
  let boardId: number;
  let otherBoardId: number;
  let n: number;

  beforeEach(async () => {
    store = new MemoryStore();
    n = 0;
    const clock = { now: () => START };
    tokens = new IntegrationTokenService({
      store,
      clock,
      newSecret: () => `secret-${String(++n)}`,
      hashSecret: (s) => `hash:${s}`,
    });
    inbox = new InboxService({ store, clock, notifier: new RecordingNotifier() });
    [boardId, otherBoardId] = await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
      const make = () =>
        tx.insertBoard({ name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      const a = await make();
      const b = await make();
      await tx.upsertMember({ boardId: a.id, email: ADMIN, role: 'admin' });
      await tx.upsertMember({ boardId: a.id, email: DEV, role: 'dev' });
      return [a.id, b.id];
    });
  });

  it('shows the secret once, stores only its hash, and lets only admins manage it', async () => {
    expect(errorCode(await tokens.create(DEV, boardId))).toBe('forbidden');
    const made = unwrap(await tokens.create(ADMIN, boardId));
    expect(made.token).toBe('secret-1');
    expect(store.state.integrationTokens.map((t) => t.tokenHash)).toEqual(['hash:secret-1']);
    expect(unwrap(await tokens.status(DEV, boardId))).toEqual({ active: true, createdAt: START });
    expect(errorCode(await tokens.revoke(DEV, boardId))).toBe('forbidden');
  });

  it('accepts the active token for its board only; a new one revokes the old, and revoke stops it', async () => {
    const first = unwrap(await tokens.create(ADMIN, boardId)).token;
    expect(unwrap(await tokens.authenticate(boardId, first))).toEqual({ boardId });
    expect(errorCode(await tokens.authenticate(otherBoardId, first))).toBe('forbidden');
    expect(errorCode(await tokens.authenticate(boardId, 'unknown'))).toBe('forbidden');
    const second = unwrap(await tokens.create(ADMIN, boardId)).token;
    expect(errorCode(await tokens.authenticate(boardId, first))).toBe('forbidden');
    expect(unwrap(await tokens.authenticate(boardId, second))).toEqual({ boardId });
    unwrap(await tokens.revoke(ADMIN, boardId));
    expect(errorCode(await tokens.authenticate(boardId, second))).toBe('forbidden');
    expect(unwrap(await tokens.status(ADMIN, boardId)).active).toBe(false);
  });

  it('delivers once per source ref, whatever the text, and a paste of the same text is the same item', async () => {
    const delivery = { source: 'meet', sourceRef: 'doc-1', text: 'Notes one', title: 'Sync' } as const;
    const first = unwrap(await inbox.deliver(boardId, delivery));
    expect(first.created).toBe(true);
    const item = await store.transaction((tx) => tx.getInboxItem(boardId, first.id));
    expect(item).toMatchObject({ source: 'meet', sourceRef: 'doc-1', createdBy: null, status: 'new' });
    expect(unwrap(await inbox.deliver(boardId, { ...delivery, text: 'Edited notes' }))).toEqual({ id: first.id, created: false });
    expect(unwrap(await inbox.add(DEV, boardId, { text: 'Notes one' }))).toEqual({ id: first.id, created: false });
    expect(unwrap(await inbox.deliver(boardId, { ...delivery, sourceRef: 'doc-2', text: 'Other notes' })).created).toBe(true);
    // The same doc ID on another board is its own item.
    expect(unwrap(await inbox.deliver(otherBoardId, delivery)).created).toBe(true);
  });

  it('refuses an empty source ref, an unknown source, empty text and an unknown board', async () => {
    const ok = { source: 'meet', sourceRef: 'doc-1', text: 'Notes' } as const;
    expect(errorCode(await inbox.deliver(boardId, { ...ok, sourceRef: ' ' }))).toBe('invalid_input');
    expect(errorCode(await inbox.deliver(boardId, { ...ok, source: 'slack' as 'meet' }))).toBe('invalid_input');
    expect(errorCode(await inbox.deliver(boardId, { ...ok, text: '  ' }))).toBe('invalid_input');
    expect(errorCode(await inbox.deliver(999, ok))).toBe('not_found');
  });
});

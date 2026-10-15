import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { ACTION_PLAN_TEMPLATE } from '../src/domain/action-glob.js';
import { validateAttributes } from '../src/domain/attributes.js';
import type { ActionAttributes } from '../src/domain/attributes.js';
import type { Result } from '../src/domain/errors.js';
import { derivedSteps } from '../src/domain/human-steps.js';
import * as machine from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import { needsHuman } from '../src/domain/attention.js';
import { checkRelationShape, defaultUntil, isMet, toState } from '../src/domain/relations.js';
import type { Actor, Glob } from '../src/domain/types.js';
import { includes } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board, ctx, dev, glob, relation } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);

const attributes = (patch: Partial<ActionAttributes> = {}): ActionAttributes => ({ assignee: null, outcome: null, ...patch });

const action = (patch: Partial<Glob> = {}): Glob =>
  glob({ id: 's1a1', category: 'action', type: null, attributes: attributes(), pr: null, provisioning: 'none', ...patch });

const create = (patch: Partial<machine.CreateInput> = {}, actor: Actor = dev): Result<Transition> =>
  machine.create(
    { id: 's1a1', boardId: 1, title: 'Protect main', type: null, category: 'action', attributes: attributes(), group: null, environment: null, autoTrigger: false, ...patch },
    board,
    ctx(actor),
  );

describe('A1: creating an action', () => {
  it('enters Planning with no type, run, provisioning, labels or doing clock', () => {
    const t = unwrap(create());
    expect(t.glob).toMatchObject({ category: 'action', type: null, status: 'planning', provisioning: 'none', labels: {}, runs: [], pr: null, doingSince: null });
    expect(t.effects).toEqual([]);
    expect(t.events.map((e) => [e.type, e.data['category'], e.data['type']])).toEqual([['GlobCreated', 'action', null]]);
  });

  it('refuses a type, an environment, an outcome and an empty title', () => {
    expect(code(create({ type: 'same' }))).toBe('invalid_combination');
    expect(code(create({ environment: 'dev' }))).toBe('invalid_input');
    expect(code(create({ attributes: attributes({ outcome: { kind: 'done', by: 'a', at: NOW } }) }))).toBe('invalid_input');
    expect(code(create({ title: ' ' }))).toBe('invalid_input');
  });

  it('refuses a code category without a type', () => {
    expect(code(create({ category: 'task', id: 's1t1', attributes: undefined }))).toBe('invalid_combination');
  });

  it('validates attributes: only assignee and outcome', () => {
    expect(validateAttributes('action', undefined)).toEqual({ ok: true, value: { assignee: null, outcome: null } });
    expect(code(validateAttributes('action', { assignee: 'a@b.c', scope: 1 }))).toBe('invalid_input');
  });
});

describe('A2: completing an action', () => {
  it('records who and when, signs the action off and releases what waits for it', () => {
    const t = unwrap(machine.completeAction(action(), { note: ' checked the settings page ' }, ctx(dev)));
    expect(t.glob.status).toBe('signed_off');
    expect(t.glob.signedOffAt).toBe(NOW);
    expect(t.glob.attributes).toEqual({ assignee: null, outcome: { kind: 'done', by: dev.email, at: NOW, note: 'checked the settings page' } });
    expect(t.effects).toEqual([{ kind: 'release_waiting', globId: 's1a1', generation: 1 }]);
    expect(t.events.map((e) => e.type)).toEqual(['StatusChanged', 'ActionDone']);
  });

  it('takes any board member, with no note', () => {
    for (const role of ['dev', 'qa', 'po', 'admin'] as const) {
      const t = unwrap(machine.completeAction(action(), {}, ctx({ email: `${role}@example.com`, role })));
      expect(t.glob.attributes).toMatchObject({ outcome: { kind: 'done', by: `${role}@example.com` } });
    }
  });

  it('is unchanged on a repeat, refused after a dismissal and on other globs', () => {
    const done = unwrap(machine.completeAction(action(), {}, ctx(dev))).glob;
    expect(unwrap(machine.completeAction(done, {}, ctx(dev))).changed).toBe(false);
    const dismissed = unwrap(machine.dismissAction(action(), { reason: 'no longer needed' }, ctx(dev))).glob;
    expect(code(machine.completeAction(dismissed, {}, ctx(dev)))).toBe('invalid_transition');
    expect(code(machine.completeAction(glob(), {}, ctx(dev)))).toBe('invalid_transition');
  });
});

describe('A3: dismissing an action', () => {
  it('needs a reason, then ends it and releases what waits for it', () => {
    expect(code(machine.dismissAction(action(), { reason: '  ' }, ctx(dev)))).toBe('invalid_input');
    const t = unwrap(machine.dismissAction(action(), { reason: ' not needed ' }, ctx(dev)));
    expect(t.glob.status).toBe('signed_off');
    expect(t.glob.attributes).toEqual({ assignee: null, outcome: { kind: 'dismissed', by: dev.email, at: NOW, reason: 'not needed' } });
    expect(t.effects.map((e) => e.kind)).toEqual(['release_waiting']);
    expect(t.events.map((e) => e.type)).toEqual(['StatusChanged', 'ActionDismissed']);
  });

  it('is unchanged on a repeat and refused after it was done', () => {
    const dismissed = unwrap(machine.dismissAction(action(), { reason: 'x' }, ctx(dev))).glob;
    expect(unwrap(machine.dismissAction(dismissed, { reason: 'x' }, ctx(dev))).changed).toBe(false);
    const done = unwrap(machine.completeAction(action(), {}, ctx(dev))).glob;
    expect(code(machine.dismissAction(done, { reason: 'x' }, ctx(dev)))).toBe('invalid_transition');
  });
});

describe('what a person can do with an action', () => {
  it('offers done and dismiss while open, and only delete after', () => {
    expect(machine.allowedActions(action(), dev)).toEqual(['complete_action', 'dismiss_action', 'delete']);
    const done = unwrap(machine.completeAction(action(), {}, ctx(dev))).glob;
    expect(machine.allowedActions(done, dev)).toEqual(['delete']);
  });

  it('offers a code glob neither', () => {
    expect(machine.allowedActions(glob(), dev)).not.toContain('complete_action');
  });

  it('changes the assignee while open, and nothing else about its kind', () => {
    const board0 = board;
    const t = unwrap(machine.changeFields(action(), { attributes: { assignee: 'sam@example.com' } }, board0, ctx(dev)));
    expect(t.glob.attributes).toEqual({ assignee: 'sam@example.com', outcome: null });
    expect(code(machine.changeFields(action(), { attributes: { scope: 1 } }, board0, ctx(dev)))).toBe('invalid_input');
    expect(code(machine.changeFields(action(), { type: 'same' }, board0, ctx(dev)))).toBe('invalid_combination');
    expect(code(machine.changeFields(action(), { category: 'decision' }, board0, ctx(dev)))).toBe('invalid_combination');
    expect(code(machine.changeFields(glob(), { category: 'action' }, board0, ctx(dev)))).toBe('invalid_combination');
    const done = unwrap(machine.completeAction(action(), {}, ctx(dev))).glob;
    expect(code(machine.changeFields(done, { attributes: { assignee: 'x@y.z' } }, board0, ctx(dev)))).toBe('invalid_input');
  });
});

describe('an action in the derived views', () => {
  it('has one human step while open, for the assignee or anyone, and none after', () => {
    expect(derivedSteps(action()).map((s) => [s.kind, s.title, s.who])).toEqual([['action', 'Do: Fix login timeout', 'anyone']]);
    expect(derivedSteps(action({ attributes: attributes({ assignee: 'sam@example.com' }) }))[0]?.who).toBe('sam@example.com');
    const done = unwrap(machine.completeAction(action(), {}, ctx(dev))).glob;
    expect(derivedSteps(done)).toEqual([]);
  });

  it('needs a person while open only', () => {
    expect(needsHuman(action())).toBe(true);
    expect(needsHuman(unwrap(machine.completeAction(action(), {}, ctx(dev))).glob)).toBe(false);
  });

  it('is listed by actions and human, not by work or decisions', () => {
    expect(includes('actions', 'action')).toBe(true);
    expect(includes('human', 'action')).toBe(true);
    expect(includes('human', 'decision')).toBe(true);
    expect(includes('work', 'action')).toBe(false);
    expect(includes(undefined, 'action')).toBe(false);
    expect(includes('decisions', 'action')).toBe(false);
    expect(includes('actions', 'task')).toBe(false);
  });
});

describe('relations to an action', () => {
  it('holds until the action is done or dismissed, whichever way it ended', () => {
    const open = toState(action());
    expect(open).toBe('planning');
    const r = relation('s1t2', 's1a1', { until: 'done' });
    expect(isMet(r, open)).toBe(false);
    const done = unwrap(machine.completeAction(action(), {}, ctx(dev))).glob;
    const dismissed = unwrap(machine.dismissAction(action(), { reason: 'x' }, ctx(dev))).glob;
    expect(toState(done)).toBe('done');
    expect(toState(dismissed)).toBe('done');
    expect(isMet(r, 'done')).toBe(true);
    expect(isMet(r, 'missing')).toBe(true);
  });

  it('defaults to done for an action, decided for a decision, merged for work', () => {
    expect(defaultUntil({ category: 'action' })).toBe('done');
    expect(defaultUntil({ category: 'decision' })).toBe('decided');
    expect(defaultUntil({ category: 'task' })).toBe('merged');
  });

  it('checks the shape: done only to an action, an action only done, and human work is never held back', () => {
    expect(checkRelationShape({ id: 's1t2', category: 'task' }, { to: 's1a1', until: 'done' }, { category: 'action' }).ok).toBe(true);
    expect(code(checkRelationShape({ id: 's1t2', category: 'task' }, { to: 's1t1', until: 'done' }, { category: 'task' }))).toBe('invalid_input');
    expect(code(checkRelationShape({ id: 's1t2', category: 'task' }, { to: 's1a1', until: 'merged' }, { category: 'action' }))).toBe('invalid_input');
    expect(code(checkRelationShape({ id: 's1a1', category: 'action' }, { to: 's1t1', until: 'merged' }, { category: 'task' }))).toBe('invalid_input');
  });
});

describe('work commands on human globs', () => {
  const ADMIN = 'admin@example.com';
  const DEV = 'dev@example.com';
  let globs: GlobService;
  let boards: BoardService;
  let store: MemoryStore;
  let boardId: number;
  let runs = 0;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    boards = new BoardService({ store, notifier });
    globs = new GlobService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Protect main',
    type: null,
    category: 'action',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });

  const current = async (id: string): Promise<Glob> => unwrap(await globs.get(DEV, id)).glob;

  it('creates an action with no type or provisioning, the template as plan, and its own ID counter', async () => {
    const made = unwrap(await globs.create(DEV, input({ assignee: 'sam@example.com' })));
    expect(made).toMatchObject({ id: `s${boardId}a1`, category: 'action', type: null, status: 'planning', provisioning: 'none', version: 1 });
    expect(made.attributes).toEqual({ assignee: 'sam@example.com', outcome: null });
    const plan = (await store.transaction((tx) => tx.artifactVersions(made.id, 'plan', ''))).at(-1)?.content ?? '';
    expect(plan).toContain('# Protect main');
    for (const heading of ['## Why', '## Do this', '## Permissions', '## Check it worked']) expect(plan).toContain(heading);
    expect(ACTION_PLAN_TEMPLATE).toContain('scripts/rollout/');
    expect(unwrap(await globs.create(DEV, input())).id).toBe(`s${boardId}a2`);
    // The code counters are untouched.
    expect(unwrap(await globs.create(DEV, input({ title: 'Work', type: 'same', category: 'task' }))).id).toBe(`s${boardId}t1`);
  });

  it('keeps a caller-given plan, is idempotent, and refuses a type, relations and non-members', async () => {
    const made = unwrap(await globs.create(DEV, input({ plan: '# Rotate\n\nDo it.', idempotencyKey: 'k1' })));
    expect(unwrap(await globs.create(DEV, input({ plan: 'other', idempotencyKey: 'k1' }))).id).toBe(made.id);
    expect((await store.transaction((tx) => tx.artifactVersions(made.id, 'plan', ''))).at(-1)?.content).toBe('# Rotate\n\nDo it.');
    expect(code(await globs.create(DEV, input({ type: 'same' })))).toBe('invalid_input');
    expect(code(await globs.create(DEV, input({ after: [made.id] })))).toBe('invalid_input');
    expect(code(await globs.create(DEV, input({ files: ['src/a.ts'] })))).toBe('invalid_input');
    expect(code(await globs.create('nobody@example.com', input()))).not.toBeNull();
  });

  it('refuses a code glob without a type', async () => {
    expect(code(await globs.create(DEV, input({ category: 'task', type: null })))).toBe('invalid_input');
  });

  it('completes and dismisses through the service, any member, with the REST-shaped results', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    const done = unwrap(await globs.completeAction(ADMIN, a.id, a.version, 'looked fine'));
    expect(done.status).toBe('signed_off');
    expect(done.attributes).toMatchObject({ outcome: { kind: 'done', by: ADMIN, note: 'looked fine' } });
    const b = unwrap(await globs.create(DEV, input({ title: 'Other' })));
    expect(code(await globs.dismissAction(DEV, b.id, b.version, ''))).toBe('invalid_input');
    expect(unwrap(await globs.dismissAction(DEV, b.id, b.version, 'moved')).attributes).toMatchObject({ outcome: { kind: 'dismissed', reason: 'moved' } });
  });

  it('refuses work steps on an action and action steps on work', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    const work = unwrap(await globs.create(DEV, input({ title: 'Work', type: 'same', category: 'task' })));
    expect(code(await globs.start(DEV, a.id, a.version))).toBe('invalid_transition');
    expect(code(await globs.merge(DEV, a.id, a.version))).toBe('invalid_transition');
    expect(code(await globs.completeAction(DEV, work.id, work.version))).toBe('invalid_transition');
    expect(code(await globs.dismissAction(DEV, work.id, work.version, 'x'))).toBe('invalid_transition');
  });

  it('does not split an action, nor split code work into an action', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    expect(code(await globs.split(DEV, a.id, a.version, { group: null, idempotencyKey: null, parts: [{ title: 'a', plan: 'p' }, { title: 'b', plan: 'q' }] }))).toBe('invalid_input');
    const work = unwrap(await globs.create(DEV, input({ title: 'Work', type: 'same', category: 'task' })));
    expect(code(await globs.split(DEV, work.id, work.version, { group: null, idempotencyKey: null, parts: [{ title: 'a', plan: 'p' }, { title: 'b', plan: 'q', category: 'action' }] }))).toBe('invalid_input');
  });

  it('holds a sub that waits for an action until done, and a dismissal releases it too', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    const sub = unwrap(await globs.create(ADMIN, input({ title: 'Needs it', type: 'sub', category: 'task', relations: [{ to: a.id, gate: 'start' }] })));
    const held = unwrap(await globs.get(DEV, sub.id));
    expect(held.glob.waiting).toBeDefined();
    expect(held.holding.map((h) => [h.to, h.until, h.toIsAction])).toEqual([[a.id, 'done', true]]);
    unwrap(await globs.dismissAction(DEV, a.id, a.version, 'not needed'));
    const after = unwrap(await globs.get(DEV, sub.id));
    expect(after.holding).toEqual([]);
    expect((await current(a.id)).status).toBe('signed_off');
  });

  it('holds a sub that needs an action (after/needs lists) until it is done or dismissed', async () => {
    for (const how of ['done', 'dismissed'] as const) {
      const a = unwrap(await globs.create(DEV, input({ title: `Action ${how}` })));
      const sub = unwrap(await globs.create(ADMIN, input({ title: 'Needs it', type: 'sub', category: 'task', after: [a.id] })));
      const held = unwrap(await globs.get(DEV, sub.id));
      expect(held.glob.waiting).toBeDefined();
      expect(held.holding.map((h) => [h.to, h.until, h.toIsAction])).toEqual([[a.id, 'done', true]]);
      if (how === 'done') unwrap(await globs.completeAction(DEV, a.id, a.version));
      else unwrap(await globs.dismissAction(DEV, a.id, a.version, 'not needed'));
      expect(unwrap(await globs.get(DEV, sub.id)).holding).toEqual([]);
    }
  });

  it('records no relation to an action that is done already', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    unwrap(await globs.completeAction(DEV, a.id, a.version));
    const sub = unwrap(await globs.create(ADMIN, input({ title: 'Late', type: 'sub', category: 'task', after: [a.id] })));
    expect(unwrap(await globs.get(DEV, sub.id)).holding).toEqual([]);
  });

  it('writes a PATCH after-list entry for an action as until done', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    const other = unwrap(await globs.create(DEV, input({ title: 'Other' })));
    const sub = unwrap(await globs.create(ADMIN, input({ title: 'Later', type: 'sub', category: 'task', after: [other.id] })));
    unwrap(await globs.update(ADMIN, sub.id, sub.version, { after: [a.id] }));
    expect(unwrap(await globs.get(DEV, sub.id)).holding.map((h) => [h.to, h.until])).toEqual([[a.id, 'done']]);
    unwrap(await globs.completeAction(DEV, a.id, a.version));
    expect(unwrap(await globs.get(DEV, sub.id)).holding).toEqual([]);
  });

  it('gives a split part the original\'s wait for an action as until done', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    const sub = unwrap(await globs.create(ADMIN, input({ title: 'Big', type: 'sub', category: 'task', after: [a.id], plan: '# Big\n\nDo it.' })));
    const split = unwrap(await globs.split(ADMIN, sub.id, sub.version, { group: null, idempotencyKey: null, parts: [{ title: 'one', plan: 'p' }, { title: 'two', plan: 'q' }] }));
    const ids = JSON.stringify(split).match(/s\d+t\d+/g) ?? [];
    const part = [...new Set(ids)].find((id) => id !== sub.id);
    expect(part).toBeDefined();
    expect(unwrap(await globs.get(DEV, part ?? '')).holding.map((h) => [h.to, h.until])).toEqual([[a.id, 'done']]);
    unwrap(await globs.completeAction(DEV, a.id, a.version));
    expect(unwrap(await globs.get(DEV, part ?? '')).holding).toEqual([]);
  });

  it('refuses pick-up and take-over of an action, with a message that says what to do', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    for (const takeOver of [false, true]) {
      const r = await globs.pickUp(DEV, a.id, a.version, takeOver);
      expect(code(r)).toBe('invalid_transition');
      expect(!r.ok && r.error.message).toBe('An action is not picked up: mark it done or dismiss it');
    }
    expect(code(await globs.pickUp(ADMIN, a.id, a.version, false))).toBe('invalid_transition');
    expect((await current(a.id)).status).toBe('planning');
    expect(unwrap(await globs.completeAction(DEV, a.id, a.version)).status).toBe('signed_off');
  });

  it('lets a person relate to an action but never relates an action to anything', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    const work = unwrap(await globs.create(DEV, input({ title: 'Work', type: 'same', category: 'task' })));
    expect(code(await globs.addRelation(DEV, work.id, work.version, { to: a.id, gate: 'merge', until: 'merged' }))).toBe('invalid_input');
    expect(code(await globs.addRelation(DEV, a.id, a.version, { to: work.id, gate: 'start' }))).toBe('invalid_input');
    expect(code(await globs.addRelation(DEV, work.id, work.version, { to: a.id, gate: 'merge' }))).toBeNull();
  });
});

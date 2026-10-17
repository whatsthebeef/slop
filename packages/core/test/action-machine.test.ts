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
import { scriptPathOf } from '../src/domain/action-script.js';
import type { Actor, Glob } from '../src/domain/types.js';
import { includes } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board, ctx, dev, glob, relation, relationFacts } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);

const attributes = (patch: Partial<ActionAttributes> = {}): ActionAttributes => ({ assignee: null, outcome: null, ...patch });

const action = (patch: Partial<Glob> = {}): Glob =>
  glob({ id: 's1a1', category: 'action', type: null, attributes: attributes(), pr: null, provisioning: 'none', ...patch });

const doing = (patch: Partial<Glob> = {}): Glob => action({ status: 'in_progress', implementer: 'dev@example.com', ...patch });

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
  it('offers pick up first in Planning, then done, dismiss and back to Planning in Doing, and only delete after', () => {
    expect(machine.allowedActions(action(), dev)).toEqual(['pick_up', 'dismiss_action', 'delete']);
    expect(machine.allowedActions(doing(), dev)).toEqual(['complete_action', 'dismiss_action', 'back_to_planning', 'delete']);
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
    expect(derivedSteps(action())).toEqual([]);
    expect(derivedSteps(doing()).map((s) => [s.kind, s.title, s.who])).toEqual([['action', 'Do: Fix login timeout', 'anyone']]);
    expect(derivedSteps(doing({ attributes: attributes({ assignee: 'sam@example.com' }) }))[0]?.who).toBe('sam@example.com');
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
    expect(code(checkRelationShape({ id: 's1d1', category: 'decision' }, { to: 's1t1', until: 'merged' }, { category: 'task' }))).toBe('invalid_input');
  });

  it('lets an action wait at its start for a code glob, and for nothing at another gate', () => {
    const from = { id: 's1a1', category: 'action' } as const;
    expect(checkRelationShape(from, { to: 's1t1', until: 'merged' }, { category: 'task' }).ok).toBe(true);
    expect(checkRelationShape(from, { to: 's1t1', until: 'merged', gate: 'start' }, { category: 'task' }).ok).toBe(true);
    expect(code(checkRelationShape(from, { to: 's1t1', until: 'merged', gate: 'merge' }, { category: 'task' }))).toBe('invalid_input');
    expect(code(checkRelationShape(from, { to: 's1t1', until: 'merged', gate: 'sign_off' }, { category: 'task' }))).toBe('invalid_input');
  });
});

describe('an action waits for the glob that builds its script', () => {
  const held = (state: 'planning' | 'open' | 'merged') => relationFacts('s1a1', [['s1t1', state]], { reason: 'builds its script' });

  it('is refused Done while a start relation is unmet, and says what it waits for', () => {
    for (const state of ['planning', 'open'] as const) {
      const r = machine.completeAction(action(), {}, ctx(dev), { relations: held(state) });
      expect(code(r)).toBe('invalid_transition');
      expect(!r.ok && r.error.message).toContain('Waits for s1t1 to merge');
    }
  });

  it('can be done once that glob has merged, and an unmet relation of another gate holds nothing', () => {
    expect(unwrap(machine.completeAction(action(), {}, ctx(dev), { relations: held('merged') })).glob.status).toBe('signed_off');
    const other = relationFacts('s1a1', [['s1t1', 'planning']], { gate: 'merge' });
    expect(unwrap(machine.completeAction(action(), {}, ctx(dev), { relations: other })).glob.status).toBe('signed_off');
  });

  it('can still be dismissed while held', () => {
    const t = unwrap(machine.dismissAction(action(), { reason: 'not needed' }, ctx(dev)));
    expect(t.glob.status).toBe('signed_off');
    expect(machine.allowedActions(action(), dev, { relations: held('planning') })).toEqual(['pick_up', 'dismiss_action', 'delete']);
    expect(machine.allowedActions(doing(), dev, { relations: held('planning') })).toEqual(['dismiss_action', 'back_to_planning', 'delete']);
  });

  it('offers Done again when the glob has merged', () => {
    expect(machine.allowedActions(doing(), dev, { relations: held('merged') })).toEqual(['complete_action', 'dismiss_action', 'back_to_planning', 'delete']);
    expect(machine.allowedActions(doing(), dev)).toEqual(['complete_action', 'dismiss_action', 'back_to_planning', 'delete']);
  });

  it('is refused Done while its script is not on the base branch, with or without a relation', () => {
    const script = { path: 'scripts/rollout/s1t1-x.sh', onBase: false };
    const r = machine.completeAction(action(), {}, ctx(dev), { script });
    expect(code(r)).toBe('invalid_transition');
    expect(!r.ok && r.error.message).toBe('script not on main yet: scripts/rollout/s1t1-x.sh');
    const named = machine.completeAction(action(), {}, ctx(dev), { script, baseBranch: 'master' });
    expect(!named.ok && named.error.message).toBe('script not on master yet: scripts/rollout/s1t1-x.sh');
    expect(machine.allowedActions(doing(), dev, { script })).toEqual(['dismiss_action', 'back_to_planning', 'delete']);
    expect(machine.allowedActions(doing(), dev, { script: { ...script, onBase: true } })).toContain('complete_action');
  });

  it('fails open when the base branch could not be read, and when the plan names no script', () => {
    const unknown = { path: 'scripts/x.sh', onBase: null };
    expect(unwrap(machine.completeAction(action(), {}, ctx(dev), { script: unknown })).glob.status).toBe('signed_off');
    expect(unwrap(machine.completeAction(action(), {}, ctx(dev), { script: null })).glob.status).toBe('signed_off');
  });
});

describe('the script an action runs', () => {
  it('reads the first script line of the plan, as a bullet or not, bold label and backticks fine', () => {
    expect(scriptPathOf('## Do this\n\nscript: scripts/rollout/s1t1-x.sh\nbash scripts/rollout/s1t1-x.sh')).toBe('scripts/rollout/s1t1-x.sh');
    expect(scriptPathOf('- **script:** `scripts/a.sh`')).toBe('scripts/a.sh');
    expect(scriptPathOf('Script: scripts/a.sh\nscript: scripts/b.sh')).toBe('scripts/a.sh');
  });

  it('ignores prose, a script line inside a code fence and a path that could leave the repo', () => {
    expect(scriptPathOf('Run the script: scripts/a.sh please')).toBeNull();
    expect(scriptPathOf('```\nscript: scripts/a.sh\n```')).toBeNull();
    expect(scriptPathOf('script: ../etc/passwd.sh')).toBeNull();
    expect(scriptPathOf('script: /etc/passwd.sh')).toBeNull();
    expect(scriptPathOf('')).toBeNull();
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
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
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

  it('keeps a caller-given plan, is idempotent, and refuses a type, an unknown glob to wait for and non-members', async () => {
    const made = unwrap(await globs.create(DEV, input({ plan: '# Rotate\n\nDo it.', idempotencyKey: 'k1' })));
    expect(unwrap(await globs.create(DEV, input({ plan: 'other', idempotencyKey: 'k1' }))).id).toBe(made.id);
    expect((await store.transaction((tx) => tx.artifactVersions(made.id, 'plan', ''))).at(-1)?.content).toBe('# Rotate\n\nDo it.');
    expect(code(await globs.create(DEV, input({ type: 'same' })))).toBe('invalid_input');
    expect(code(await globs.create(DEV, input({ after: ['s9t9'] })))).toBe('invalid_input');
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

  it('picks an action up into Doing with the person, no branch or run; another person cannot, Back to Planning returns it, and the Do step closes it', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    const picked = unwrap(await globs.pickUp(DEV, a.id, a.version, false));
    expect(picked).toMatchObject({ status: 'in_progress', implementer: DEV, pr: null, provisioning: 'none' });
    expect(picked.runs).toEqual([]);
    expect(picked.attributes).toMatchObject({ assignee: DEV, outcome: null });
    expect(code(await globs.pickUp(ADMIN, a.id, picked.version, false))).toBe('invalid_transition');
    const back = unwrap(await globs.backToPlanning(DEV, a.id, picked.version));
    expect(back).toMatchObject({ status: 'planning', implementer: null });
    const again = unwrap(await globs.pickUp(DEV, a.id, back.version, false));
    const view = unwrap(await globs.get(DEV, a.id));
    expect(view.humanSteps.map((s) => s.id)).toContain('machine:action');
    expect(unwrap(await globs.completeHumanStep(DEV, a.id, 'machine:action', again.version)).state).toBe('done');
    expect((await current(a.id)).status).toBe('signed_off');
  });

  it('lets a person relate to an action, and relate an action to a code glob at its start only', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    const work = unwrap(await globs.create(DEV, input({ title: 'Work', type: 'same', category: 'task' })));
    expect(code(await globs.addRelation(DEV, work.id, work.version, { to: a.id, gate: 'merge', until: 'merged' }))).toBe('invalid_input');
    expect(code(await globs.addRelation(DEV, a.id, a.version, { to: work.id, gate: 'merge' }))).toBe('invalid_input');
    expect(code(await globs.addRelation(DEV, a.id, a.version, { to: work.id, gate: 'start' }))).toBeNull();
  });

  it('refuses a cycle between an action and a glob that waits for it', async () => {
    const a = unwrap(await globs.create(DEV, input()));
    unwrap(await globs.create(DEV, input({ title: 'Work', type: 'same', category: 'task', after: [a.id] })));
    expect(code(await globs.addRelation(DEV, a.id, a.version, { to: `s${boardId}t1`, gate: 'start' }))).toBe('invalid_input');
  });

  it('creates an action that waits for a glob, can not be done until it merges, and is told when it does', async () => {
    const work = unwrap(await globs.create(DEV, input({ title: 'Builds the script', type: 'same', category: 'task' })));
    const made = unwrap(await globs.create(DEV, input({ after: [work.id], relations: [{ to: work.id, reason: 'builds its script' }] })));
    expect(made.status).toBe('planning');
    expect(made.waiting ?? null).toBeNull();
    const view = unwrap(await globs.get(DEV, made.id));
    expect(view.relations.map((r) => [r.to, r.gate, r.until])).toEqual([[work.id, 'start', 'merged']]);
    expect(view.waitingFor.map((w) => w.id)).toEqual([work.id]);
    expect(view.allowedActions).toEqual(['pick_up', 'dismiss_action', 'delete']);
    expect(code(await globs.completeAction(DEV, made.id, made.version))).toBe('invalid_transition');
    expect((await current(made.id)).status).toBe('planning');
    // The merge releases nothing for an action (it has no start), but tells the board so the row offers Done again.
    unwrap(await globs.applyEvent(work.id, (g, c) => machine.merged(g, { sha: 'abc1234' }, c)));
    expect(await globs.releaseDependents(work.id, boardId)).toEqual([]);
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    expect(unwrap(await globs.get(DEV, made.id)).allowedActions).toContain('complete_action');
    expect(unwrap(await globs.completeAction(DEV, made.id, picked.version)).status).toBe('signed_off');
  });

  it('does not record a wait for a glob that has merged already, and refuses a non-start relation', async () => {
    const work = unwrap(await globs.create(DEV, input({ title: 'Work', type: 'same', category: 'task' })));
    unwrap(await globs.applyEvent(work.id, (g, c) => machine.merged(g, { sha: 'abc1234' }, c)));
    const free = unwrap(await globs.create(DEV, input({ after: [work.id] })));
    expect(unwrap(await globs.get(DEV, free.id)).relations).toEqual([]);
    expect(code(await globs.create(DEV, input({ relations: [{ to: work.id, gate: 'merge' }] })))).toBe('invalid_input');
  });
});

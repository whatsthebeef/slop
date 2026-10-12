import { describe, expect, it } from 'vitest';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import * as machine from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import type { Result } from '../src/domain/errors.js';
import type { Actor, Glob, GlobLink } from '../src/domain/types.js';
import { board, ctx, dev, glob, NOW, po } from './fixtures.js';

const admin: Actor = { email: 'admin@example.com', role: 'admin' };
const qa: Actor = { email: 'qa@example.com', role: 'qa' };

const attributes = (patch: Partial<DecisionAttributes> = {}): DecisionAttributes => ({
  scope: { kind: 'project', ref: null },
  origin: { kind: 'kb_item', id: 's1k1' },
  channel: 'agent',
  kbItemId: 's1k1',
  outcome: null,
  ...patch,
});

const decision = (patch: Partial<Glob> = {}): Glob =>
  glob({
    id: 's1k1',
    category: 'decision',
    attributes: attributes(),
    pr: null,
    provisioning: 'none',
    ...patch,
  });

const unwrap = (result: Result<Transition>): Transition => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = (result: Result<Transition>): string | null => (result.ok ? null : result.error.code);
const outcomeOf = (g: Glob) => (g.attributes !== undefined && 'outcome' in g.attributes ? g.attributes.outcome : undefined);
const eventTypes = (t: Transition) => t.events.map((e) => e.type);

const create = (patch: Partial<machine.CreateInput> = {}, actor: Actor = dev) =>
  machine.create(
    {
      id: 's1k1',
      boardId: 1,
      title: 'Never edit src/gen/',
      summary: 'Never edit src/gen/',
      type: 'same',
      category: 'decision',
      attributes: attributes(),
      group: null,
      environment: null,
      autoTrigger: false,
      ...patch,
    },
    board,
    ctx(actor),
  );

describe('D1: creating a decision', () => {
  it('enters Planning with no run, no provisioning, no labels and no doing clock', () => {
    const t = unwrap(create());
    expect(t.glob).toMatchObject({ category: 'decision', type: 'same', status: 'planning', provisioning: 'none', labels: {}, runs: [], pr: null, doingSince: null });
    expect(t.effects).toEqual([]);
    expect(t.events.map((e) => [e.type, e.data['category']])).toEqual([['GlobCreated', 'decision']]);
  });

  it('refuses a type other than same, a missing or already-decided attribute set, and an environment', () => {
    expect(code(create({ type: 'sub' }))).toBe('invalid_combination');
    expect(code(create({ type: 'super' }))).toBe('invalid_combination');
    expect(code(create({ attributes: undefined }))).toBe('invalid_input');
    expect(code(create({ attributes: attributes({ outcome: { kind: 'accept', by: 'a', at: NOW } }) }))).toBe('invalid_input');
    expect(code(create({ environment: 'dev' }))).toBe('invalid_input');
    expect(code(create({ title: '  ' }))).toBe('invalid_input');
  });
});

describe('D2 and D3: pick up', () => {
  it('moves Planning to Doing for an admin or PO with no provision effect and no run', () => {
    for (const actor of [admin, po]) {
      const t = unwrap(machine.pickUp(decision(), ctx(actor), board, { takeOver: false }));
      expect(t.glob).toMatchObject({ status: 'in_progress', implementer: actor.email, doingSince: NOW, provisioning: 'none', runs: [] });
      expect(t.effects).toEqual([]);
      expect(eventTypes(t)).toEqual(['StatusChanged', 'PickedUp']);
    }
  });

  it('refuses devs and QA', () => {
    expect(code(machine.pickUp(decision(), ctx(dev), board, { takeOver: false }))).toBe('forbidden');
    expect(code(machine.pickUp(decision(), ctx(qa), board, { takeOver: false }))).toBe('forbidden');
  });

  it('lets another admin take over, and the implementer picking up again changes nothing', () => {
    const mine = decision({ status: 'in_progress', implementer: admin.email, doingSince: NOW });
    expect(unwrap(machine.pickUp(mine, ctx(admin), board, { takeOver: false })).changed).toBe(false);
    const taken = unwrap(machine.pickUp(mine, ctx(po), board, { takeOver: false }));
    expect(taken.glob.implementer).toBe(po.email);
    expect(taken.events.map((e) => [e.type, e.data['takeOver']])).toEqual([['PickedUp', true]]);
  });

  it('refuses a decision in Reviewing', () => {
    expect(code(machine.pickUp(decision({ status: 'reviewing' }), ctx(admin), board, { takeOver: false }))).toBe('invalid_transition');
  });
});

describe('D4, D5, D7, D11: deciding', () => {
  const doing = decision({ status: 'in_progress', implementer: admin.email, doingSince: NOW });

  it('accept and accept with edits go to Reviewing with the outcome recorded', () => {
    for (const outcome of ['accept', 'accept_with_edits'] as const) {
      const t = unwrap(machine.decideDecision(doing, { outcome }, ctx(admin)));
      expect(t.glob).toMatchObject({ status: 'reviewing', doingSince: null });
      expect(outcomeOf(t.glob)).toMatchObject({ kind: outcome, by: admin.email, at: NOW });
      expect(eventTypes(t)).toEqual(['StatusChanged', 'DecisionDecided']);
    }
  });

  it('reject needs a reason, signs off and archives', () => {
    expect(code(machine.decideDecision(doing, { outcome: 'reject' }, ctx(admin)))).toBe('invalid_input');
    expect(code(machine.decideDecision(doing, { outcome: 'reject', reason: '   ' }, ctx(admin)))).toBe('invalid_input');
    const t = unwrap(machine.decideDecision(doing, { outcome: 'reject', reason: 'Already known' }, ctx(admin)));
    expect(t.glob).toMatchObject({ status: 'signed_off', signedOffAt: NOW });
    expect(t.glob.attributes).toMatchObject({ archived: true, outcome: { kind: 'reject', reason: 'Already known' } });
  });

  it('needs work needs the linked glob and stays in Doing', () => {
    expect(code(machine.decideDecision(doing, { outcome: 'needs_work' }, ctx(admin)))).toBe('invalid_input');
    const t = unwrap(machine.decideDecision(doing, { outcome: 'needs_work', linkedGlobId: 's1t2' }, ctx(po)));
    expect(t.glob.status).toBe('in_progress');
    expect(outcomeOf(t.glob)).toMatchObject({ kind: 'needs_work', linkedGlobId: 's1t2' });
    expect(eventTypes(t)).toEqual(['DecisionDecided']);
  });

  it('retarget records an event only: the glob stays as it was', () => {
    const t = unwrap(machine.decideDecision(doing, { outcome: 'retarget' }, ctx(admin)));
    expect(t.changed).toBe(false);
    expect(t.glob).toBe(doing);
    expect(eventTypes(t)).toEqual(['DecisionDecided']);
  });

  it('can be decided again after needs work, but not after an accept', () => {
    const waiting = decision({ status: 'in_progress', attributes: attributes({ outcome: { kind: 'needs_work', by: 'a', at: NOW, linkedGlobId: 's1t2' } }) });
    expect(unwrap(machine.decideDecision(waiting, { outcome: 'accept' }, ctx(admin))).glob.status).toBe('reviewing');
    const accepted = decision({ status: 'in_progress', attributes: attributes({ outcome: { kind: 'accept', by: 'a', at: NOW } }) });
    expect(code(machine.decideDecision(accepted, { outcome: 'accept' }, ctx(admin)))).toBe('invalid_transition');
  });

  it('refuses outside Doing, for devs, and on a work glob', () => {
    expect(code(machine.decideDecision(decision(), { outcome: 'accept' }, ctx(admin)))).toBe('invalid_transition');
    expect(code(machine.decideDecision(doing, { outcome: 'accept' }, ctx(dev)))).toBe('forbidden');
    expect(code(machine.decideDecision(glob({ status: 'in_progress' }), { outcome: 'accept' }, ctx(admin)))).toBe('invalid_transition');
  });
});

describe('D6: the linked glob merged', () => {
  const waiting = decision({ status: 'in_progress', attributes: attributes({ outcome: { kind: 'needs_work', by: 'a', at: NOW, linkedGlobId: 's1t2' } }) });

  it('moves the decision to Reviewing once, marking the work landed', () => {
    const t = unwrap(machine.decisionWorkLanded(waiting, ctx(null)));
    expect(t.glob.status).toBe('reviewing');
    expect(outcomeOf(t.glob)).toMatchObject({ kind: 'needs_work', workLanded: true });
    expect(eventTypes(t)).toEqual(['StatusChanged', 'DecisionWorkLanded']);
    expect(machine.decisionWorkLanded(t.glob, ctx(null))).toMatchObject({ ok: true, value: { changed: false } });
  });

  it('changes nothing for a decision not waiting on work', () => {
    expect(unwrap(machine.decisionWorkLanded(decision({ status: 'in_progress' }), ctx(null))).changed).toBe(false);
    expect(unwrap(machine.decisionWorkLanded(glob(), ctx(null))).changed).toBe(false);
  });
});

describe('D8 and D9: sign off and reopen', () => {
  const reviewing = decision({ status: 'reviewing', attributes: attributes({ outcome: { kind: 'accept', by: 'a', at: NOW } }) });

  it('signs off only from Reviewing', () => {
    const t = unwrap(machine.signOffDecision(reviewing, ctx(admin)));
    expect(t.glob).toMatchObject({ status: 'signed_off', signedOffAt: NOW });
    expect(code(machine.signOffDecision(decision({ status: 'in_progress' }), ctx(admin)))).toBe('invalid_transition');
    expect(code(machine.signOffDecision(reviewing, ctx(dev)))).toBe('forbidden');
  });

  it('reopens to Doing with the outcome cleared, to choose again', () => {
    const t = unwrap(machine.reopenDecision(reviewing, ctx(po)));
    expect(t.glob).toMatchObject({ status: 'in_progress', doingSince: NOW });
    expect(outcomeOf(t.glob)).toBeNull();
    expect(code(machine.reopenDecision(decision({ status: 'in_progress' }), ctx(admin)))).toBe('invalid_transition');
  });
});

describe('D10: closed by the pipeline, and sync from the item', () => {
  it('archives from any open status, and leaves a signed-off decision alone', () => {
    for (const status of ['planning', 'in_progress', 'reviewing'] as const) {
      const t = unwrap(machine.archiveDecision(decision({ status }), 'covered', ctx(null)));
      expect(t.glob).toMatchObject({ status: 'signed_off', signedOffAt: NOW });
      expect(t.glob.attributes).toMatchObject({ archived: true, outcome: { kind: 'closed', by: 'system', reason: 'covered' } });
    }
    expect(unwrap(machine.archiveDecision(decision({ status: 'signed_off' }), 'covered', ctx(null))).changed).toBe(false);
  });

  it('accepts a decision approved on the Knowledge page without a pick-up, once', () => {
    const t = unwrap(machine.decisionApproved(decision(), { by: admin.email }, ctx(null)));
    expect(t.glob.status).toBe('reviewing');
    expect(outcomeOf(t.glob)).toMatchObject({ kind: 'accept', by: admin.email });
    expect(machine.decisionApproved(t.glob, { by: admin.email }, ctx(null))).toMatchObject({ ok: true, value: { changed: false } });
    expect(unwrap(machine.decisionApproved(decision(), { by: 'x' }, ctx(null), 'signed_off')).glob.status).toBe('signed_off');
  });

  it('rejects a decision rejected on the Knowledge page, archived', () => {
    const t = unwrap(machine.decisionRejected(decision({ status: 'in_progress' }), { by: admin.email, reason: 'No' }, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'signed_off' });
    expect(t.glob.attributes).toMatchObject({ archived: true, outcome: { kind: 'reject', reason: 'No' } });
  });

  it('reopens a closed or decided decision to Planning, but not one waiting on work or already open', () => {
    const closed = unwrap(machine.archiveDecision(decision(), 'covered', ctx(null))).glob;
    const back = unwrap(machine.decisionReopened(closed, ctx(null)));
    expect(back.glob).toMatchObject({ status: 'planning', signedOffAt: null, implementer: null });
    expect(back.glob.attributes).toMatchObject({ outcome: null });
    expect(back.glob.attributes).not.toHaveProperty('archived');
    expect(unwrap(machine.decisionReopened(decision(), ctx(null))).changed).toBe(false);
    const needsWork = decision({ status: 'in_progress', attributes: attributes({ outcome: { kind: 'needs_work', by: 'a', at: NOW, linkedGlobId: 's1t2' } }) });
    expect(unwrap(machine.decisionReopened(needsWork, ctx(null))).changed).toBe(false);
  });

  it('records the broader decisions it conflicts with, and clears them', () => {
    const flagged = unwrap(machine.decisionConflicts(decision(), ['s1k7'], ctx(null)));
    expect(flagged.glob.attributes).toMatchObject({ conflictsWith: ['s1k7'] });
    expect(unwrap(machine.decisionConflicts(flagged.glob, ['s1k7'], ctx(null))).changed).toBe(false);
    const cleared = unwrap(machine.decisionConflicts(flagged.glob, [], ctx(null)));
    expect(cleared.glob.attributes).not.toHaveProperty('conflictsWith');
  });
});

describe("D10′ and D12: the KB pipeline closes a learning, an admin reopens it", () => {
  const kbAttributes = (patch: Partial<DecisionAttributes> = {}): DecisionAttributes =>
    attributes({ origin: { kind: 'submitted' }, kbItemId: null, kind: 'gotcha', target: { suggested: null, routed: null }, evidenceCount: 2, ...patch });
  const open = (patch: Partial<Glob> = {}) => decision({ attributes: kbAttributes(), ...patch });
  const pipelineLink = (id: string, kind: GlobLink['kind']): GlobLink => ({ id, kind, source: 'pipeline' });

  it('closes from any open status: Signed off, archived, closedAs, a closed outcome by slop and the closing link', () => {
    for (const status of ['planning', 'in_progress', 'reviewing'] as const) {
      const t = unwrap(machine.closeDecision(open({ status }), 'merged', pipelineLink('s1k2', 'duplicate_of'), ctx(null)));
      expect(t.glob).toMatchObject({ status: 'signed_off', signedOffAt: NOW, links: [pipelineLink('s1k2', 'duplicate_of')] });
      expect(t.glob.attributes).toMatchObject({
        archived: true,
        closedAs: 'merged',
        outcome: { kind: 'closed', by: 'slop', reason: 'The knowledge pipeline closed the item as merged' },
        // The learning's own fields are kept.
        kind: 'gotcha',
        evidenceCount: 2,
      });
      expect(eventTypes(t)).toContain('DecisionDecided');
      expect(t.events.find((e) => e.type === 'DecisionDecided')?.data).toMatchObject({ closedAs: 'merged', link: { id: 's1k2', kind: 'duplicate_of' } });
    }
  });

  it('closes as covered by a document with no link, keeps other links, and leaves a signed-off decision alone', () => {
    const hint: GlobLink = { id: 's1k5', kind: 'possibly_covered_by', source: 'pipeline', detail: { quote: 'q' } };
    const t = unwrap(machine.closeDecision(open({ links: [hint] }), 'covered', null, ctx(null)));
    expect(t.glob.links).toEqual([hint]);
    expect(t.glob.attributes).toMatchObject({ closedAs: 'covered', archived: true });
    expect(unwrap(machine.closeDecision(t.glob, 'covered', null, ctx(null))).changed).toBe(false);
    // Only a closing kind closes.
    expect(code(machine.closeDecision(open(), 'covered', hint, ctx(null)))).toBe('invalid_input');
    expect(unwrap(machine.closeDecision(glob(), 'covered', null, ctx(null))).changed).toBe(false);
  });

  it('lets only an admin reopen a closed learning: back to Planning with the closure undone', () => {
    const contradiction: GlobLink = { id: 's1k9', kind: 'contradicts', source: 'pipeline', detail: { note: 'n' } };
    const closed = unwrap(machine.closeDecision(open({ status: 'in_progress', implementer: admin.email, links: [contradiction] }), 'covered', pipelineLink('s1k3', 'covered_by'), ctx(null))).glob;
    expect(code(machine.reopenClosedDecision(closed, ctx(po)))).toBe('forbidden');
    const t = unwrap(machine.reopenClosedDecision(closed, ctx(admin)));
    expect(t.glob).toMatchObject({ status: 'planning', implementer: null, signedOffAt: null, doingSince: null, links: [contradiction] });
    expect(t.glob.attributes).toMatchObject({ outcome: null, kind: 'gotcha' });
    for (const key of ['archived', 'closedAs', 'coveredByText']) expect(t.glob.attributes).not.toHaveProperty(key);
    expect(eventTypes(t)).toEqual(['StatusChanged', 'DecisionReopened']);
    expect(t.events.at(-1)?.data).toEqual({ closedAs: 'covered' });
  });

  it('clears the text coverage on reopen, and keeps a merged pair apart', () => {
    const coveredByText = { kind: 'knowledge' as const, knowledgeKind: 'doc' as const, name: 'build_test_lint', section: null };
    const covered = unwrap(machine.closeDecision(open({ attributes: kbAttributes({ coveredByText }) }), 'covered', null, ctx(null))).glob;
    expect(unwrap(machine.reopenClosedDecision(covered, ctx(admin))).glob.attributes).not.toHaveProperty('coveredByText');

    const merged = unwrap(machine.closeDecision(open(), 'merged', pipelineLink('s1k2', 'duplicate_of'), ctx(null))).glob;
    const reopened = unwrap(machine.reopenClosedDecision(merged, ctx(admin))).glob;
    expect(reopened.links).toEqual([{ id: 's1k2', kind: 'kept_apart_from', source: 'explicit' }]);
    // Already kept apart: not added twice.
    const apart = { ...merged, links: [...(merged.links ?? []), { id: 's1k2', kind: 'kept_apart_from' as const, source: 'explicit' as const }] };
    expect(unwrap(machine.reopenClosedDecision(apart, ctx(admin))).glob.links).toEqual([{ id: 's1k2', kind: 'kept_apart_from', source: 'explicit' }]);
  });

  it('refuses to reopen this way what the pipeline did not close', () => {
    expect(code(machine.reopenClosedDecision(open(), ctx(admin)))).toBe('invalid_transition');
    const rejected = unwrap(machine.decisionRejected(open(), { by: admin.email, reason: 'No' }, ctx(null))).glob;
    expect(code(machine.reopenClosedDecision(rejected, ctx(admin)))).toBe('invalid_transition');
    expect(code(machine.reopenClosedDecision(glob(), ctx(admin)))).toBe('invalid_transition');
  });

  it('keeps the learning\'s fields through the other rows', () => {
    const accepted = unwrap(machine.decisionApproved(open(), { by: admin.email }, ctx(null))).glob;
    expect(accepted.attributes).toMatchObject({ kind: 'gotcha', evidenceCount: 2, target: { suggested: null, routed: null } });
    const flagged = unwrap(machine.decisionConflicts(open(), ['s1k7'], ctx(null))).glob;
    expect(flagged.attributes).toMatchObject({ kind: 'gotcha', conflictsWith: ['s1k7'] });
  });
});

describe('changing a decision', () => {
  it('lets an admin or PO change its scope, with a FieldsChanged diff', () => {
    const t = unwrap(machine.changeFields(decision(), { attributes: { scope: { kind: 'glob', ref: 's1t1' } } }, board, ctx(po)));
    expect(t.glob.attributes).toMatchObject({ scope: { kind: 'glob', ref: 's1t1' } });
    expect(t.events.map((e) => e.type)).toEqual(['FieldsChanged']);
    expect(unwrap(machine.changeFields(decision(), { attributes: { scope: { kind: 'project', ref: null } } }, board, ctx(po))).changed).toBe(false);
    expect(code(machine.changeFields(decision(), { attributes: { scope: { kind: 'project', ref: null }, outcome: null } }, board, ctx(po)))).toBe('invalid_input');
    expect(code(machine.changeFields(decision(), { attributes: { scope: { kind: 'glob', ref: 's1t1' } } }, board, ctx(dev)))).toBe('forbidden');
    expect(code(machine.changeFields(glob(), { attributes: { scope: { kind: 'project', ref: null } } }, board, ctx(po)))).toBe('invalid_input');
  });

  it('refuses any type change and any category change to or from decision', () => {
    expect(code(machine.changeFields(decision(), { type: 'sub' }, board, ctx(admin)))).toBe('invalid_combination');
    expect(code(machine.changeFields(decision(), { category: 'task' }, board, ctx(admin)))).toBe('invalid_combination');
    expect(code(machine.changeFields(glob(), { category: 'decision' }, board, ctx(admin)))).toBe('invalid_combination');
    expect(machine.allowedTypeChanges(decision(), 'admin')).toEqual([]);
  });

  it('can still be retitled', () => {
    expect(unwrap(machine.changeFields(decision(), { title: 'New title' }, board, ctx(admin))).glob.title).toBe('New title');
  });
});

describe('allowed actions', () => {
  it('offers only pick up, decide, sign off, reopen and delete, by role and status', () => {
    const actions = (g: Glob, actor: Actor) => machine.allowedActions(g, actor);
    expect(actions(decision(), admin)).toEqual(['pick_up', 'delete']);
    expect(actions(decision(), dev)).toEqual([]);
    expect(actions(decision({ status: 'in_progress', implementer: admin.email }), admin)).toEqual(['decide', 'delete']);
    expect(actions(decision({ status: 'in_progress', implementer: admin.email }), po)).toEqual(['pick_up', 'decide', 'delete']);
    expect(actions(decision({ status: 'reviewing' }), po)).toEqual(['sign_off', 'reopen', 'delete']);
    expect(actions(decision({ status: 'signed_off' }), admin)).toEqual(['delete']);
    const waiting = decision({ status: 'in_progress', implementer: admin.email, attributes: attributes({ outcome: { kind: 'needs_work', by: 'a', at: NOW, linkedGlobId: 's1t2' } }) });
    expect(actions(waiting, admin)).toContain('decide');
  });

  it('leaves work globs unchanged', () => {
    const actions = machine.allowedActions(glob({ status: 'planning', pr: null, provisioning: 'none' }), dev);
    expect(actions).toEqual(['start', 'investigate', 'pick_up', 'start_again', 'delete']);
  });
});

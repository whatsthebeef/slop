import { describe, expect, it } from 'vitest';
import { isDecisionAttributes, validateAttributes, validateScope, validateScopeEdit } from '../src/domain/attributes.js';
import { ARTIFACT_KINDS, ARTIFACT_ROLE, isSpecialKind } from '../src/domain/knowledge.js';
import { payloadOf } from '../src/domain/payload.js';
import { GLOB_ID_PATTERN, formatId, globIdInText, letterOf, parseId } from '../src/domain/ids.js';
import { isValidCombination, listOf } from '../src/domain/matrix.js';
import { CATEGORIES, WORK_CATEGORIES } from '../src/domain/types.js';
import { NOW } from './fixtures.js';

const decision = (patch: Record<string, unknown> = {}) => ({
  scope: { kind: 'project', ref: null },
  origin: { kind: 'submitted' },
  channel: 'agent',
  outcome: null,
  ...patch,
});

const message = (result: ReturnType<typeof validateAttributes>): string => (result.ok ? '' : result.error.message);

describe('decision IDs and the category matrix', () => {
  it('numbers decisions s<b>k<n> like KB items, and parses them back; work IDs are unchanged; there is no d letter', () => {
    expect(letterOf('decision')).toBe('k');
    expect(formatId(1, letterOf('decision'), 3)).toBe('s1k3');
    expect(parseId('s1k3')).toEqual({ boardId: 1, letter: 'k', n: 3 });
    expect(parseId('s1d3')).toBeNull();
    expect(parseId('s12k4')).toEqual({ boardId: 12, letter: 'k', n: 4 });
    expect([letterOf('feature'), letterOf('task'), letterOf('bug'), letterOf('action')]).toEqual(['f', 't', 'b', 'a']);
    expect(parseId('s2a5')).toEqual({ boardId: 2, letter: 'a', n: 5 });
    expect(parseId('s1x3')).toBeNull();
  });

  it('has one glob-ID pattern that accepts every letter, k included, and not d', () => {
    expect(['s1f2', 's1t2', 's1b2', 's1h2', 's15k3', 's15a3'].every((id) => GLOB_ID_PATTERN.test(id))).toBe(true);
    expect(['s1d3', 's0k1', 's1k0', 's1k3x', 'xs1k3'].some((id) => GLOB_ID_PATTERN.test(id))).toBe(false);
    expect('See s15k3 and s15t7, not s15d2 or as15k4.'.match(globIdInText())).toEqual(['s15k3', 's15t7']);
  });

  it('allows no type for human work, requires one for code work, and keeps the work matrix', () => {
    expect(isValidCombination(null, 'decision')).toBe(true);
    expect(isValidCombination(null, 'action')).toBe(true);
    expect(isValidCombination('same', 'decision')).toBe(false);
    expect(isValidCombination('sub', 'decision')).toBe(false);
    expect(isValidCombination('same', 'action')).toBe(false);
    expect(isValidCombination(null, 'feature')).toBe(false);
    expect(isValidCombination(null, 'bug')).toBe(false);
    expect(isValidCombination('super', 'bug')).toBe(false);
    expect(isValidCombination('super', 'feature')).toBe(true);
  });

  it('keeps decisions out of the categories a person may create', () => {
    expect(WORK_CATEGORIES).toEqual(['feature', 'task', 'bug']);
    expect(CATEGORIES).toEqual(['feature', 'task', 'bug', 'decision', 'action']);
  });

  it('puts a decision in the lists its status gives', () => {
    expect([listOf('planning'), listOf('in_progress'), listOf('reviewing'), listOf('signed_off')]).toEqual(['planning', 'doing', 'reviewing', 'signed_off']);
  });
});

describe('attribute schemas', () => {
  it('accepts no attributes, or none of the keys, on work globs', () => {
    expect(validateAttributes('task', undefined)).toEqual({ ok: true, value: {} });
    expect(validateAttributes('feature', {})).toEqual({ ok: true, value: {} });
    expect(message(validateAttributes('bug', { scope: { kind: 'project', ref: null } }))).toMatch(/unknown keys: scope/);
  });

  it('checks a decision in full and refuses unknown keys', () => {
    const ok = validateAttributes('decision', decision());
    expect(ok.ok && isDecisionAttributes(ok.value)).toBe(true);
    expect(message(validateAttributes('decision', decision({ extra: 1 })))).toMatch(/unknown keys: extra/);
    expect(message(validateAttributes('decision', undefined))).toMatch(/needs attributes/);
    expect(message(validateAttributes('decision', decision({ channel: 'fax' })))).toMatch(/channel/);
    expect(message(validateAttributes('decision', decision({ origin: { kind: 'inbox', id: 0 } })))).toMatch(/inbox item number/);
    expect(message(validateAttributes('decision', decision({ archived: false })))).toMatch(/archived/);
  });

  it('accepts a submitted or mined origin with no ID: the decision is the learning, same ID', () => {
    for (const kind of ['submitted', 'mined'] as const) {
      const result = validateAttributes('decision', decision({ origin: { kind } }));
      expect(result.ok && isDecisionAttributes(result.value) ? result.value.origin : null).toEqual({ kind });
    }
    expect(message(validateAttributes('decision', decision({ origin: { kind: 'carrier pigeon' } })))).toMatch(/origin.kind/);
    expect(message(validateAttributes('decision', decision({ source: { kind: 'manual' } })))).toMatch(/unknown keys: source/);
    // The wrapper's link to a separate KB item is gone: the decision is the item.
    expect(message(validateAttributes('decision', decision({ origin: { kind: 'kb_item', id: 's1k1' } })))).toMatch(/origin.kind/);
    expect(message(validateAttributes('decision', decision({ kbItemId: 's1k1' })))).toMatch(/unknown keys: kbItemId/);
  });

  it('carries a KB learning\'s own fields, each checked when present', () => {
    const target = { kind: 'doc', name: 'build_test_lint', section: 'Test', newDocument: null };
    const signal = {
      key: 'finding:x',
      kind: 'finding',
      agent: 'implementer',
      label: 'Findings',
      window: { from: NOW, to: NOW },
      figures: { affected: 3, eligible: 10, rate: 0.3, count: 4 },
      globIds: ['s1t1'],
      examples: ['an example'],
      measuredAt: NOW,
    };
    const kb = {
      kind: 'gotcha',
      sourceGlobs: ['s1t1', 's1t2'],
      target: { suggested: 'build doc', routed: target },
      agentSetVersion: 4,
      signal,
      evidenceCount: 2,
      catalogCandidate: true,
      catalogReason: 'Holds for any project',
      closedAs: 'covered',
      stale: { since: NOW, reason: 'no_recent_evidence', dismissedAt: null },
      document: { name: 'architecture', area: 'architecture', audience: ['implementer'], description: 'How it fits' },
      coveredByText: { kind: 'knowledge', knowledgeKind: 'doc', name: 'build_test_lint', section: null },
      possiblyCoveredByText: { knowledgeKind: 'doc', name: 'build_test_lint', section: 'Test', quote: 'Run vitest', reason: 'Says it' },
      contradictsText: [{ kind: 'knowledge', ref: 'build_test_lint', note: 'Says the opposite' }],
    };
    const result = validateAttributes('decision', decision({ origin: { kind: 'mined' }, ...kb }));
    expect(result.ok ? result.value : result.error).toEqual({ ...decision({ origin: { kind: 'mined' } }), ...kb });
    // Unrouted: a suggested target only.
    expect(validateAttributes('decision', decision({ target: { suggested: null, routed: null } })).ok).toBe(true);
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ kind: 'rumour' }, /kind must be one of/],
      [{ sourceGlobs: 's1t1' }, /sourceGlobs/],
      [{ target: { suggested: null, routed: { ...target, kind: 'novel' } } }, /target/],
      [{ agentSetVersion: -1 }, /agentSetVersion/],
      [{ signal: { ...signal, kind: 'hunch' } }, /signal/],
      [{ evidenceCount: 0 }, /evidenceCount/],
      [{ catalogCandidate: false }, /catalogCandidate/],
      [{ closedAs: 'lost' }, /closedAs/],
      [{ stale: { since: NOW, reason: 'bored', dismissedAt: null } }, /stale/],
      [{ document: { name: 'x' } }, /document/],
      [{ coveredByText: { kind: 'item', id: 's1k2' } }, /coveredByText/],
      [{ possiblyCoveredByText: { kind: 'item', id: 's1k2', quote: 'q', shortQuote: true } }, /possiblyCoveredByText/],
      [{ contradictsText: [{ kind: 'item', ref: 's1k2', note: 'n' }] }, /contradictsText/],
    ];
    for (const [patch, expected] of bad) expect(message(validateAttributes('decision', decision(patch)))).toMatch(expected);
  });

  it('checks the outcome and drops duplicate conflict IDs', () => {
    const outcome = { kind: 'needs_work', by: 'a@x.com', at: NOW, linkedGlobId: 's1t2' };
    const result = validateAttributes('decision', decision({ outcome, conflictsWith: ['s1k9', 's1k9'], archived: true }));
    expect(result.ok && isDecisionAttributes(result.value) ? result.value.conflictsWith : null).toEqual(['s1k9']);
    expect(message(validateAttributes('decision', decision({ outcome: { ...outcome, kind: 'maybe' } })))).toMatch(/outcome.kind/);
    expect(message(validateAttributes('decision', decision({ outcome: { ...outcome, workLanded: false } })))).toMatch(/workLanded/);
  });

  it('checks scope kinds and refs', () => {
    expect(validateScope({ kind: 'glob', ref: 's1t1' })).toEqual({ ok: true, value: { kind: 'glob', ref: 's1t1' } });
    expect(validateScope({ kind: 'future_work' })).toEqual({ ok: true, value: { kind: 'future_work', ref: null } });
    expect(validateScope({ kind: 'future_work', ref: 'billing' })).toEqual({ ok: true, value: { kind: 'future_work', ref: 'billing' } });
    expect(validateScope({ kind: 'area_group', ref: 'billing' }).ok).toBe(true);
    expect(validateScope({ kind: 'glob' }).ok).toBe(false);
    expect(validateScope({ kind: 'area_group', ref: null }).ok).toBe(false);
    expect(validateScope({ kind: 'project', ref: 'x' }).ok).toBe(false);
    expect(validateScope({ kind: 'galaxy', ref: 'x' }).ok).toBe(false);
    expect(validateScope({ kind: 'glob', ref: 'line\nbreak' }).ok).toBe(false);
    expect(validateScope({ kind: 'glob', ref: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateScope({ kind: 'glob', ref: 's1t1', extra: 1 }).ok).toBe(false);
  });

  it('lets a client edit only the scope, and only of a decision', () => {
    expect(validateScopeEdit('decision', { scope: { kind: 'project', ref: null } }).ok).toBe(true);
    expect(validateScopeEdit('decision', { scope: { kind: 'project', ref: null }, outcome: null }).ok).toBe(false);
    expect(validateScopeEdit('task', { scope: { kind: 'project', ref: null } }).ok).toBe(false);
  });
});

describe('artifact roles and payload', () => {
  it('gives every kind a role, with assessments special and plans the payload', () => {
    for (const kind of ARTIFACT_KINDS) expect(ARTIFACT_ROLE[kind]).toBeDefined();
    expect(ARTIFACT_ROLE.plan).toBe('payload');
    expect((['implementation_plan', 'postplan'] as const).map((k) => ARTIFACT_ROLE[k])).toEqual(['record', 'record']);
    expect((['local_review', 'investigation', 'assessment'] as const).every((k) => isSpecialKind(k))).toBe(true);
    // A KB learning's pipeline output has its own place in the decision section.
    expect((['draft', 'outcome', 'effect_check'] as const).every((k) => isSpecialKind(k))).toBe(true);
    expect(isSpecialKind('attachment')).toBe(false);
  });

  it('takes the payload from plan.md, else nothing', () => {
    expect(payloadOf([{ kind: 'plan', version: 2, content: '# Plan' }])).toEqual({ version: 2, content: '# Plan' });
    expect(payloadOf([{ kind: 'attachment', version: 1, content: 'x' }])).toBeNull();
    expect(payloadOf([])).toBeNull();
  });
});

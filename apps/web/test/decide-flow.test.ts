import { describe, expect, it } from 'vitest';
import { approveBlockedText, approveLabel, changeHeading, headerMenu, scopeMatters, submitLabel } from '../src/lib/decide-flow';

const menu = (patch: Partial<Parameters<typeof headerMenu>[0]> = {}) =>
  headerMenu({ canDecide: true, canSuggest: true, canKeep: true, hasItem: true, adminOnly: null, ...patch });

describe('what approving is called', () => {
  it('is Approve change unless the target needs a more specific name', () => {
    expect(approveLabel(false, null).label).toBe('Approve change');
    expect(approveLabel(true, null).label).toBe('Approve document');
    expect(approveLabel(false, { kind: 'merge_policy', name: 'm', section: null, newDocument: null }).label).toBe('Approve merge policy');
    expect(approveLabel(false, { kind: 'local_run', name: 'l', section: null, newDocument: null }).label).toBe('Approve local-run spec');
    expect(approveLabel(false, null, true).label).toBe('Create refactor glob');
  });
});

describe('the change heading', () => {
  const doc = (section: string | null) => ({ kind: 'doc', name: 'architecture', section, newDocument: null }) as const;
  it('names the target in words', () => {
    expect(changeHeading(null, false)).toBeNull();
    expect(changeHeading(doc('apps/web'), false)).toBe('Edit to architecture › apps/web');
    expect(changeHeading(doc('apps/web'), true)).toBe('Addition to architecture › apps/web');
    expect(changeHeading(doc(null), true)).toBe('Addition to architecture');
    expect(changeHeading({ kind: 'merge_policy', name: 'merge_policy', section: null, newDocument: null }, false)).toBe('Merge policy setting');
    expect(changeHeading({ kind: 'agent', name: 'orchestrator', section: null, newDocument: null }, true)).toBe('Addition to orchestrator');
  });
});

describe('when scope is shown', () => {
  it('is hidden for a change routed to a document or setting, and for hotspots', () => {
    expect(scopeMatters(false, false, null)).toBe(true);
    expect(scopeMatters(true, false, null)).toBe(false);
    expect(scopeMatters(false, true, null)).toBe(false);
    expect(scopeMatters(false, false, { kind: 'doc', name: 'a', section: null, newDocument: null })).toBe(false);
  });
});

describe('the ▾ menu', () => {
  it('leads with Reject…, Approve with edits…, keeping and a new recommendation, and keeps the other outcomes', () => {
    expect(menu().map((m) => m.label)).toEqual([
      'Reject…',
      'Approve with edits…',
      'Approve without changing a document',
      'Get a new recommendation',
      'Retarget',
      'Needs work',
    ]);
  });

  it('leaves out keeping and suggesting for those who cannot', () => {
    expect(menu({ canKeep: false, canSuggest: false }).map((m) => m.key)).toEqual(['reject', 'accept_with_edits', 'retarget', 'needs_work']);
  });

  it('gives the reason an entry is off', () => {
    const entries = menu({ hasItem: false, adminOnly: 'changes the merge policy' });
    expect(entries.find((m) => m.key === 'retarget')?.disabled).toMatch(/no knowledge item/);
    expect(entries.find((m) => m.key === 'accept_with_edits')?.disabled).toMatch(/no knowledge item/);
    expect(menu({ adminOnly: 'changes the merge policy' }).find((m) => m.key === 'accept_with_edits')?.disabled).toMatch(/An admin decides it/);
    expect(menu({ adminOnly: 'x' }).find((m) => m.key === 'reject')?.disabled).toBeNull();
    expect(menu({ canDecide: false }).find((m) => m.key === 'reject')?.disabled).toBe("You can't decide this");
  });
});

describe('the header text when the viewer cannot approve', () => {
  it('names the reason, or is nothing', () => {
    expect(approveBlockedText(null, true)).toBeNull();
    expect(approveBlockedText('changes the merge policy', true)).toBe('An admin approves it: it changes the merge policy');
    expect(approveBlockedText(null, false)).toBe("You can't decide this");
  });
});

describe('the submit button', () => {
  it('names the open form', () => {
    expect(submitLabel('accept', 'Approve merge policy')).toBe('Approve merge policy');
    expect(submitLabel('reject', 'x')).toBe('Reject');
    expect(submitLabel('accept_with_edits', 'x')).toBe('Save');
  });
});

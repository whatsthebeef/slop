import { describe, expect, it } from 'vitest';
import { REASON_MAX_CHARS, globIdsIn, idSentences, quoteReason, reverseCuesIn, sentenceHash, sentencesOf, supersedeCuesIn } from '../src/domain/relation-scan.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import type { RelationScanRow } from '../src/domain/relation-scan.js';

const PUSH_MODE = 'Turn on push mode for board 14, after the board 15 glob s15t220 is deployed.';
const HISTORY = 'After s14t13 merged we removed the token.';

describe('sentencesOf', () => {
  it('splits at sentence ends and line breaks, and drops list markers and headings', () => {
    expect(sentencesOf('# Rollout\n- [ ] Turn on push mode. Then check s15t220!\n1. Hand over the profile\n\n')).toEqual([
      'Rollout',
      'Turn on push mode.',
      'Then check s15t220!',
      'Hand over the profile',
    ]);
  });

  it('keeps an ID with a trailing full stop whole, and does not split inside a version number', () => {
    expect(sentencesOf('Waits for s14t17. Uses v1.2 of it.')).toEqual(['Waits for s14t17.', 'Uses v1.2 of it.']);
  });

  it('is empty for an empty text', () => {
    expect(sentencesOf('')).toEqual([]);
    expect(sentencesOf('  \n ')).toEqual([]);
  });
});

describe('idSentences (the prefilter)', () => {
  it('returns only the new sentences that mention a glob ID', () => {
    const before = 'Add the push mode switch. It reads the board setting.';
    const after = `${before} ${PUSH_MODE} Nothing else changes.`;
    expect(idSentences(before, after)).toEqual([PUSH_MODE]);
  });

  it('is empty when the change has no ID, or only text that was there before (case and spacing aside)', () => {
    expect(idSentences('One.', 'One. Two with no id.')).toEqual([]);
    expect(idSentences(PUSH_MODE, `  ${PUSH_MODE.toUpperCase()}  `)).toEqual([]);
    expect(idSentences(null, '')).toEqual([]);
  });

  it('treats a first version as all new, and lists a repeated sentence once', () => {
    expect(idSentences(null, `${PUSH_MODE}\n${PUSH_MODE}`)).toEqual([PUSH_MODE]);
  });

  it('finds the s14t19 sign-off sentence', () => {
    const text = 'Hand the prod CloudWatch profile to sessions only after s14t17 (log data protection) is in place.';
    expect(idSentences('Old plan.', `Old plan.\n${text}`)).toEqual([text]);
  });

  it('yields a history sentence too: whether it is a prerequisite is for the classifier', () => {
    expect(idSentences('', `We shipped it. ${HISTORY}`)).toEqual([HISTORY]);
    expect(globIdsIn(HISTORY)).toEqual(['s14t13']);
  });

  it('matches every ID letter and ignores look-alikes', () => {
    expect(globIdsIn('s1t2 s15b148 s3a4 s2k9 s15f175 s1x2 s0t1 ss1t2 s1t')).toEqual(['s1t2', 's15b148', 's3a4', 's2k9', 's15f175']);
  });
});

describe('reverseCuesIn', () => {
  it('finds fixes, fixed, continues, follow-up to/of and unblocks directly before an ID', () => {
    expect(reverseCuesIn('This fixes s14t14.')).toEqual([{ id: 's14t14', cue: 'fixes' }]);
    expect(reverseCuesIn('Fixed s14b6 for good')).toEqual([{ id: 's14b6', cue: 'fixed' }]);
    expect(reverseCuesIn('It continues s14t16, which merged an old plan.')).toEqual([{ id: 's14t16', cue: 'continues' }]);
    expect(reverseCuesIn('Follow-up to s14t16')).toEqual([{ id: 's14t16', cue: 'follow-up to' }]);
    expect(reverseCuesIn('a follow up of s14t16')).toEqual([{ id: 's14t16', cue: 'follow up of' }]);
    expect(reverseCuesIn('This unblocks s14t19 so it can finish.')).toEqual([{ id: 's14t19', cue: 'unblocks' }]);
    expect(reverseCuesIn('fixes the glob s14t14 and unblocks s14t19')).toEqual([
      { id: 's14t14', cue: 'fixes' },
      { id: 's14t19', cue: 'unblocks' },
    ]);
  });

  it('ignores a verb that is not directly before an ID, and plain mentions', () => {
    expect(reverseCuesIn('Fixes the rollout that s14t14 needs')).toEqual([]);
    expect(reverseCuesIn(PUSH_MODE)).toEqual([]);
    expect(reverseCuesIn(HISTORY)).toEqual([]);
    expect(reverseCuesIn('prefixes s14t14')).toEqual([]);
  });
});

describe('supersedeCuesIn', () => {
  it('finds replaces, supersedes and undoes before an ID', () => {
    expect(supersedeCuesIn('s14t13 replaces s14t11')).toEqual([{ id: 's14t11', cue: 'replaces' }]);
    expect(supersedeCuesIn('This supersedes s14t11.')).toEqual([{ id: 's14t11', cue: 'supersedes' }]);
    expect(supersedeCuesIn('Undoes s14t12')).toEqual([{ id: 's14t12', cue: 'undoes' }]);
  });

  it('does not take a reverse verb or a plain mention for it', () => {
    expect(supersedeCuesIn('Fixes s14t14')).toEqual([]);
    expect(supersedeCuesIn(HISTORY)).toEqual([]);
  });
});

describe('sentenceHash and quoteReason', () => {
  it('hashes the same sentence the same whatever its case or spacing, and different sentences differently', () => {
    expect(sentenceHash('Waits for  s14t17.')).toBe(sentenceHash('waits for s14t17.'));
    expect(sentenceHash('Waits for s14t17.')).not.toBe(sentenceHash('Waits for s14t18.'));
    expect(sentenceHash('x')).toMatch(/^[0-9a-f]+$/);
  });

  it('quotes a sentence as a reason: whole when short, cut with an ellipsis at the limit', () => {
    expect(quoteReason('  after   s14t17  is in place ')).toBe('after s14t17 is in place');
    const long = `after s14t17 ${'x'.repeat(400)}`;
    const quoted = quoteReason(long);
    expect(quoted.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
    expect(quoted.endsWith('…')).toBe(true);
    expect(quoted.startsWith('after s14t17 x')).toBe(true);
    expect(quoteReason('x'.repeat(REASON_MAX_CHARS))).toHaveLength(REASON_MAX_CHARS);
  });

  it('quotes at 300 characters and as plain text: links keep their words, code and emphasis marks go, identifiers stay', () => {
    expect(REASON_MAX_CHARS).toBe(300);
    expect(quoteReason('**Only** after `s14t17` ([the PR](https://x.test/1)) is in place, see *note* and snake_case_name and 2 * 3.')).toBe(
      'Only after s14t17 (the PR) is in place, see note and snake_case_name and 2 * 3.',
    );
    expect(quoteReason('## Wait for s14t17')).toBe('Wait for s14t17');
    expect(quoteReason('> ~~Old~~ __bold__ s14t17')).toBe('Old bold s14t17');
  });
});

describe('relation scan rows in the memory store', () => {
  const row = (patch: Partial<RelationScanRow> = {}): RelationScanRow => ({
    globId: 's1t1',
    mentionedId: 's1t2',
    sentenceHash: sentenceHash(PUSH_MODE),
    boardId: 1,
    kind: 'mention',
    decision: 'suggested',
    gate: 'sign_off',
    reason: quoteReason(PUSH_MODE),
    sentence: PUSH_MODE,
    relationId: null,
    state: 'open',
    model: null,
    createdAt: '2026-10-15T12:00:00.000Z',
    decidedAt: null,
    ...patch,
  });

  it('keeps the first decision for a pair and sentence, lists open suggestions, and patches one row', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => tx.upsertRelationScans([row(), row({ mentionedId: 's1t3', state: 'done', decision: 'history' })]));
    // A second write for the same key does not overwrite it.
    await store.transaction((tx) => tx.upsertRelationScans([row({ decision: 'not_prerequisite', state: 'dismissed' })]));
    expect((await store.transaction((tx) => tx.listRelationScans('s1t1'))).map((r) => [r.mentionedId, r.decision, r.state])).toEqual([
      ['s1t2', 'suggested', 'open'],
      ['s1t3', 'history', 'done'],
    ]);
    expect((await store.transaction((tx) => tx.listOpenSuggestions(['s1t1', 's1t9']))).map((r) => r.mentionedId)).toEqual(['s1t2']);
    expect(await store.transaction((tx) => tx.listOpenSuggestions([]))).toEqual([]);
    await store.transaction((tx) => tx.updateRelationScan('s1t1', 's1t2', sentenceHash(PUSH_MODE), { state: 'dismissed', decidedAt: '2026-10-15T13:00:00.000Z' }));
    expect(await store.transaction((tx) => tx.listOpenSuggestions(['s1t1']))).toEqual([]);
    expect((await store.transaction((tx) => tx.listRelationScans('s1t1')))[0]).toMatchObject({ state: 'dismissed', decidedAt: '2026-10-15T13:00:00.000Z', decision: 'suggested' });
  });

  it('a transaction that throws leaves no scan row behind', async () => {
    const store = new MemoryStore();
    await expect(
      store.transaction(async (tx) => {
        await tx.upsertRelationScans([row()]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.transaction((tx) => tx.listRelationScans('s1t1'))).toEqual([]);
  });
});
